import { getSupabase } from '../supabase';
import { db, type SyncQueueRow, type SyncTableName } from '../db';
import { toServerRow } from './mapping';
import { parseFavoriteRowId } from './putWithSync';

async function localRowFor(entry: SyncQueueRow): Promise<Record<string, unknown> | undefined> {
  if (entry.table === 'favorites') {
    const { userId, exerciseId } = parseFavoriteRowId(entry.rowId);
    return await db.favorites.get([userId, exerciseId]) as Record<string, unknown> | undefined;
  }
  return await db.table(entry.table).get(entry.rowId) as Record<string, unknown> | undefined;
}

async function setLocalServerVersion(table: SyncTableName, rowId: string, sv: string): Promise<void> {
  if (table === 'favorites') {
    const { userId, exerciseId } = parseFavoriteRowId(rowId);
    await db.favorites.update([userId, exerciseId], { serverVersion: sv });
  } else {
    await db.table(table).update(rowId, { serverVersion: sv });
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
  if (entry.op === 'insert') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    const payload = toServerRow(local);
    const res = await getSupabase().from(entry.table).insert(payload).select() as
      { data: { updated_at: string }[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    const inserted = res.data?.[0];
    if (inserted?.updated_at) await setLocalServerVersion(entry.table, entry.rowId, inserted.updated_at);
    await db.syncQueue.delete(entry.seq!);
    return;
  }
  if (entry.op === 'update') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    const payload = toServerRow(local);
    let q = getSupabase().from(entry.table).update(payload).eq('id', entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    const updated = res.data?.[0];
    if (updated?.updated_at) {
      await setLocalServerVersion(entry.table, entry.rowId, updated.updated_at);
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    const pulled = await getSupabase().from(entry.table).select('*').eq('id', entry.rowId) as
      { data: Record<string, unknown>[] | null; error: { message: string } | null };
    const serverRow = pulled.data?.[0];
    if (!serverRow) { await db.syncQueue.delete(entry.seq!); return; }
    const conflictAttempts = (entry.attempts ?? 0) + 1;
    if (conflictAttempts >= 3) { await moveToDeadLetter(entry, 'repeated conflict'); return; }
    const newExpected = serverRow.updated_at as string;
    await db.syncQueue.update(entry.seq!, { expectedServerVersion: newExpected, attempts: conflictAttempts });
    await setLocalServerVersion(entry.table, entry.rowId, newExpected);
    const refreshed = (await db.syncQueue.get(entry.seq!))!;
    entries.unshift(refreshed);
    return;
  }
  if (entry.op === 'delete') {
    let q = getSupabase().from(entry.table).update({ deleted_at: new Date().toISOString() }).eq('id', entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: unknown[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    if (res.data && res.data.length > 0) {
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    // Conditional missed — server moved since we pulled. Mirror the update path:
    // pull the current updated_at, advance expectedServerVersion, retry once.
    const pulled = await getSupabase().from(entry.table).select('updated_at').eq('id', entry.rowId) as
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
}
