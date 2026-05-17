import { getSupabase } from '../supabase';
import { db, type SyncTableName } from '../db';
import { fromServerRow } from './mapping';
import { getCursor, setCursor } from './syncMeta';
import { favoriteRowId } from './putWithSync';

const TABLES: SyncTableName[] = ['plans', 'sessions', 'metrics', 'favorites'];

function rowKeyOf(table: SyncTableName, row: Record<string, unknown>): string {
  if (table === 'favorites') return favoriteRowId(row.user_id as string, row.exercise_id as string);
  return row.id as string;
}

async function hasPending(table: SyncTableName, rowId: string): Promise<boolean> {
  const count = await db.syncQueue.where('rowId').equals(rowId).and((e) => e.table === table).count();
  return count > 0;
}

async function mergeRow(table: SyncTableName, serverRow: Record<string, unknown>, userId: string): Promise<void> {
  const rowId = rowKeyOf(table, serverRow);
  if (await hasPending(table, rowId)) return;

  if (serverRow.deleted_at) {
    if (table === 'favorites') {
      await db.favorites.delete([userId, serverRow.exercise_id as string]);
    } else {
      await db.table(table).delete(rowId);
    }
    return;
  }

  const camel = fromServerRow(serverRow, table);
  // serverVersion is the server-side updated_at ISO string used by the OCC
  // layer. Read it from the raw row — fromServerRow now converts *_at strings
  // back to epoch ms for Dexie storage, so camel.updatedAt is a number here.
  const serverVersion = serverRow.updated_at as string;
  const local = table === 'favorites'
    ? { userId, exerciseId: camel.exerciseId as string, addedAt: camel.addedAt as number,
        updatedAt: Date.now(), serverVersion }
    : { ...camel, userId, updatedAt: Date.now(), serverVersion };
  await db.table(table).put(local as never);
}

export async function runPullOnce(): Promise<void> {
  const { data: { session } } = await getSupabase().auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return;

  for (const table of TABLES) {
    let cursor = await getCursor(table);
    let seen = new Set(cursor.lastSeenIds);
    const PAGE = 500;

    while (true) {
      let q = getSupabase().from(table).select('*').eq('user_id', userId)
        .order('updated_at', { ascending: true })
        .order(table === 'favorites' ? 'exercise_id' : 'id', { ascending: true })
        .limit(PAGE);
      if (cursor.lastPulledAt) q = q.gte('updated_at', cursor.lastPulledAt);
      const res = await q as { data: Record<string, unknown>[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const rows = res.data ?? [];
      if (rows.length === 0) break;

      let processed = 0;
      for (const r of rows) {
        const key = rowKeyOf(table, r);
        // Skip rows we already processed at the boundary timestamp.
        if (cursor.lastPulledAt && r.updated_at === cursor.lastPulledAt && seen.has(key)) continue;
        await mergeRow(table, r, userId);
        processed++;
      }

      // Advance cursor to the page's last row's updated_at, accumulating IDs at that boundary.
      const last = rows[rows.length - 1];
      const newAt = last.updated_at as string;
      if (newAt === cursor.lastPulledAt) {
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowKeyOf(table, r));
      } else {
        seen = new Set();
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowKeyOf(table, r));
      }
      cursor = { lastPulledAt: newAt, lastSeenIds: [...seen] };
      await setCursor(table, cursor);

      if (rows.length < PAGE) break;
      // Edge case: if 500+ rows share an identical updated_at (pathological — a
      // single multi-row trigger or a backfill ingest), the cursor cannot
      // advance past the boundary and `processed === 0` may fire on the second
      // page. Acceptable in v1 because Postgres trigger timestamps are
      // microsecond-precise and per-row, so collisions >= PAGE never happen at
      // gym scale. If/when spec #2 introduces batch trainer imports, replace
      // this with an unconditional cursor bump that uses (updated_at, id)
      // tuples natively.
      if (processed === 0) break;
    }
  }
}
