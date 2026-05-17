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

export async function runPushOnce(): Promise<void> {
  const entries = await db.syncQueue.orderBy('seq').toArray();
  while (entries.length > 0) {
    const entry = entries.shift()!;
    if (entry.op === 'insert') {
      const local = await localRowFor(entry);
      if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
      const payload = toServerRow(local);
      const res = await getSupabase().from(entry.table).insert(payload).select() as
        { data: { updated_at: string }[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const inserted = res.data?.[0];
      if (inserted?.updated_at) {
        await setLocalServerVersion(entry.table, entry.rowId, inserted.updated_at);
      }
      await db.syncQueue.delete(entry.seq!);
      continue;
    }

    if (entry.op === 'update') {
      const local = await localRowFor(entry);
      if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
      const payload = toServerRow(local);
      // Build conditional WHERE
      let q = getSupabase().from(entry.table).update(payload).eq('id', entry.rowId);
      if (entry.expectedServerVersion !== null) {
        q = q.eq('updated_at', entry.expectedServerVersion);
      }
      const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const updated = res.data?.[0];
      if (updated?.updated_at) {
        await setLocalServerVersion(entry.table, entry.rowId, updated.updated_at);
        await db.syncQueue.delete(entry.seq!);
      } else {
        // Conflict: server's updated_at moved. Pull latest, update
        // expectedServerVersion on the queue row, and let the next iteration retry.
        const pulled = await getSupabase().from(entry.table).select('*').eq('id', entry.rowId) as
          { data: Record<string, unknown>[] | null; error: { message: string } | null };
        if (pulled.error) throw new Error(pulled.error.message);
        const serverRow = pulled.data?.[0];
        if (!serverRow) {
          // Row disappeared on server — treat as a stale local update; drop the queue entry.
          await db.syncQueue.delete(entry.seq!);
          continue;
        }
        const conflictAttempts = (entry.attempts ?? 0) + 1;
        if (conflictAttempts >= 3) {
          await moveToDeadLetter(entry, 'repeated conflict');
          continue;
        }
        const newExpected = serverRow.updated_at as string;
        // Update the queue row, then re-run this loop iteration.
        await db.syncQueue.update(entry.seq!, {
          expectedServerVersion: newExpected, attempts: conflictAttempts,
        });
        // Reflect freshly-pulled serverVersion locally so subsequent local edits use the right baseline.
        // Keep the local DATA (the user's edit) — only the version pointer moves.
        await setLocalServerVersion(entry.table, entry.rowId, newExpected);
        // Re-fetch and retry within this loop iteration.
        const refreshed = (await db.syncQueue.get(entry.seq!))!;
        entries.unshift(refreshed);  // Process again at front of the list.
        // Continue main loop — note: we don't `continue` here because we've manipulated `entries`.
        continue;
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
