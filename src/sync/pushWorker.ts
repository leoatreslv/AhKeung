import { getSupabase } from '../supabase';
import { db, type SyncQueueRow } from '../db';
import { toServerRow } from './mapping';
import {
  descriptorFor,
  keyFromRowId,
  applyServerKeyFilter,
  type KeyFilterable,
  type TableDescriptor,
} from './descriptors';
import { log } from '../diagnostics/logger';
import { CATEGORY } from '../diagnostics/categories';

async function localRowFor(entry: SyncQueueRow): Promise<Record<string, unknown> | undefined> {
  const d = descriptorFor(entry.table);
  if (d.pkKind === 'composite') {
    const key = keyFromRowId(d, entry.rowId) as [string, string];
    return await db.table(d.dexieTable).get(key as never) as Record<string, unknown> | undefined;
  }
  return await db.table(d.dexieTable).get(entry.rowId) as Record<string, unknown> | undefined;
}

async function setLocalServerVersion(
  d: TableDescriptor, rowId: string, sv: string,
): Promise<void> {
  if (d.pkKind === 'composite') {
    const key = keyFromRowId(d, rowId) as [string, string];
    await db.table(d.dexieTable).update(key as never, { serverVersion: sv });
  } else {
    await db.table(d.dexieTable).update(rowId, { serverVersion: sv });
  }
}

const NETWORK_RE = /network/i;

function classifyError(e: unknown): 'network' | 'auth' | 'fatal' {
  if (e instanceof Error) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) return 'auth';
    if (status && status >= 400 && status < 500) return 'fatal';
    if (NETWORK_RE.test(e.message)) return 'network';
  }
  return 'network';
}

async function bumpAttempts(entry: SyncQueueRow, err: unknown): Promise<void> {
  const status = (err as { status?: number })?.status;
  await db.syncQueue.update(entry.seq!, {
    attempts: (entry.attempts ?? 0) + 1,
    lastError: err instanceof Error ? err.message : String(err),
    lastErrorStatus: status,
  });
}

async function processEntry(entry: SyncQueueRow, entries: SyncQueueRow[]): Promise<void> {
  const d = descriptorFor(entry.table);
  if (entry.op === 'insert') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    // If a row is still waiting for image upload, skip this push attempt.
    // The image-upload sweep runs before each push; the next iteration will
    // find imagePath set and proceed.
    if ((local as { pendingImageBlob?: Blob }).pendingImageBlob) return;
    const payload = toServerRow(local);
    const res = await getSupabase().from(d.serverTable).insert(payload).select() as
      { data: { updated_at: string }[] | null; error: { message: string; code?: string } | null };
    if (res.error) {
      // 23505 = Postgres unique_violation. The row already exists on the
      // server (likely because a previous delete is stuck in dead-letter
      // and never landed). Convert this insert into an update with the
      // server's current updated_at as expectedServerVersion, then replay
      // through the update branch on the next iteration.
      if (res.error.code === '23505') {
        const pullQ = getSupabase().from(d.serverTable).select('updated_at') as unknown as KeyFilterable;
        const pulled = await applyServerKeyFilter(d, pullQ, entry.rowId) as unknown as
          { data: { updated_at: string }[] | null };
        const serverRow = pulled.data?.[0];
        if (serverRow) {
          await setLocalServerVersion(d, entry.rowId, serverRow.updated_at);
          await db.syncQueue.update(entry.seq!, {
            op: 'update',
            expectedServerVersion: serverRow.updated_at,
          });
          const refreshed = (await db.syncQueue.get(entry.seq!))!;
          entries.unshift(refreshed);
          return;
        }
      }
      throw new Error(res.error.message);
    }
    const inserted = res.data?.[0];
    if (inserted?.updated_at) await setLocalServerVersion(d, entry.rowId, inserted.updated_at);
    await db.syncQueue.delete(entry.seq!);
    return;
  }
  if (entry.op === 'update') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    if ((local as { pendingImageBlob?: Blob }).pendingImageBlob) return;
    const payload = toServerRow(local);
    let q = getSupabase().from(d.serverTable).update(payload);
    q = applyServerKeyFilter(d, q, entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    const updated = res.data?.[0];
    if (updated?.updated_at) {
      await setLocalServerVersion(d, entry.rowId, updated.updated_at);
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    const pullQ = getSupabase().from(d.serverTable).select('*') as unknown as KeyFilterable;
    const pulled = await applyServerKeyFilter(d, pullQ, entry.rowId) as unknown as
      { data: Record<string, unknown>[] | null; error: { message: string } | null };
    const serverRow = pulled.data?.[0];
    if (!serverRow) { await db.syncQueue.delete(entry.seq!); return; }
    const conflictAttempts = (entry.attempts ?? 0) + 1;
    if (conflictAttempts >= 3) { await moveToDeadLetter(entry, 'repeated conflict'); return; }
    const newExpected = serverRow.updated_at as string;
    await db.syncQueue.update(entry.seq!, { expectedServerVersion: newExpected, attempts: conflictAttempts });
    await setLocalServerVersion(d, entry.rowId, newExpected);
    const refreshed = (await db.syncQueue.get(entry.seq!))!;
    entries.unshift(refreshed);
    log.warn(CATEGORY.sync, 'OCC conflict, retrying', {
      table: entry.table, rowId: entry.rowId, attempts: conflictAttempts,
    });
    return;
  }
  if (entry.op === 'delete') {
    let q = getSupabase().from(d.serverTable).update({ deleted_at: new Date().toISOString() });
    q = applyServerKeyFilter(d, q, entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: unknown[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    if (res.data && res.data.length > 0) {
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    // Conditional missed — server moved since we pulled. Mirror the update path:
    // pull the current updated_at, advance expectedServerVersion, retry once.
    const pullQ = getSupabase().from(d.serverTable).select('updated_at') as unknown as KeyFilterable;
    const pulled = await applyServerKeyFilter(d, pullQ, entry.rowId) as unknown as
      { data: { updated_at: string }[] | null };
    const serverRow = pulled.data?.[0];
    if (!serverRow) { await db.syncQueue.delete(entry.seq!); return; }  // already gone server-side
    const conflictAttempts = (entry.attempts ?? 0) + 1;
    if (conflictAttempts >= 3) { await moveToDeadLetter(entry, 'delete conflict'); return; }
    await db.syncQueue.update(entry.seq!, {
      expectedServerVersion: serverRow.updated_at, attempts: conflictAttempts,
    });
    entries.unshift((await db.syncQueue.get(entry.seq!))!);
  }
}

export async function runPushOnce(): Promise<void> {
  const entries = await db.syncQueue.orderBy('seq').toArray();
  while (entries.length > 0) {
    const entry = entries.shift()!;
    let attempt = 0;
    while (true) {
      try {
        await processEntry(entry, entries);
        break;
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'auth' && attempt === 0) {
          attempt++;
          await getSupabase().auth.refreshSession();
          continue;  // one retry after refresh
        }
        if (kind === 'fatal') {
          const newAttempts = (entry.attempts ?? 0) + 1;
          if (newAttempts >= 3) {
            await moveToDeadLetter({ ...entry, attempts: newAttempts,
              lastError: err instanceof Error ? err.message : String(err) },
              err instanceof Error ? err.message : String(err));
          } else {
            await bumpAttempts(entry, err);
          }
          break;
        }
        if (kind === 'auth') {
          // refresh-and-retry already attempted; rethrow so AuthProvider can sign out.
          await bumpAttempts(entry, err);
          throw err;
        }
        // network — bump and stop the loop entirely
        await bumpAttempts(entry, err);
        throw err;
      }
    }
  }
}

async function moveToDeadLetter(entry: SyncQueueRow, reason: string): Promise<void> {
  await db.transaction('rw', db.syncQueue, db.syncDeadLetter, async (tx) => {
    await tx.table('syncDeadLetter').add({ ...entry, seq: undefined, lastError: reason, movedAt: Date.now() });
    await tx.table('syncQueue').delete(entry.seq!);
  });
  // Dead-lettering is the canary for "a class of bug ships in production"
  // — surface every one so the diagnostics dump and PR E's remote-alert
  // cron both pick it up.
  log.error(CATEGORY.sync, 'moved to dead letter', {
    table: entry.table, rowId: entry.rowId, op: entry.op, reason,
  });
}
