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
  for (const entry of entries) {
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
    }
  }
}
