import { getSupabase } from '../supabase';
import { db, type SyncTableName } from '../db';
import { fromServerRow } from './mapping';
import { getCursor, setCursor } from './syncMeta';
import {
  DESCRIPTORS,
  rowIdFromServerRow,
  keyFromRowId,
  type TableDescriptor,
} from './descriptors';

// Pull order matters for FK-style dependencies: exercises and bundles
// must arrive before plans (which may reference exercises in their JSON)
// and before shares (which reference exercises/bundles by id). bundle
// items follow their parent bundles. trainer_trainees stands alone.
const TABLE_ORDER: SyncTableName[] = [
  'exercises',
  'exerciseBundles',
  'exerciseBundleItems',
  'trainerTrainees',
  'shares',
  'plans',
  'sessions',
  'metrics',
  'favorites',
];

async function hasPending(table: SyncTableName, rowId: string): Promise<boolean> {
  const count = await db.syncQueue.where('rowId').equals(rowId).and((e) => e.table === table).count();
  return count > 0;
}

async function mergeRow(
  table: SyncTableName,
  d: TableDescriptor,
  serverRow: Record<string, unknown>,
  userId: string,
): Promise<void> {
  const rowId = rowIdFromServerRow(d, serverRow);
  if (await hasPending(table, rowId)) return;

  if (serverRow.deleted_at) {
    if (d.pkKind === 'composite') {
      const key = keyFromRowId(d, rowId) as [string, string];
      await db.table(d.dexieTable).delete(key as never);
    } else {
      await db.table(d.dexieTable).delete(rowId);
    }
    return;
  }

  const camel = fromServerRow(serverRow, table);
  // serverVersion is the server-side updated_at ISO string used by the OCC
  // layer. Read it from the raw row — fromServerRow now converts *_at strings
  // back to epoch ms for Dexie storage, so camel.updatedAt is a number here.
  const serverVersion = serverRow.updated_at as string;
  // Trust the server for the owner column. The previous version stamped
  // `[d.ownerClientField] = userId`, which was a no-op for own-only tables
  // (server's user_id matches the puller) but corrupted shared-in rows by
  // overwriting the real owner with the current viewer's id. The server is
  // the authority on ownership; fromServerRow has already converted the
  // snake_case column to the right camelCase field.
  const local: Record<string, unknown> = {
    ...camel,
    updatedAt: Date.now(),
    serverVersion,
  };
  void userId;
  await db.table(d.dexieTable).put(local as never);
}

function applyPullPredicate<Q extends { eq(col: string, val: unknown): Q }>(
  d: TableDescriptor,
  q: Q,
  userId: string,
): Q {
  switch (d.pullPredicate.kind) {
    case 'owner':     return q.eq(d.ownerServerField, userId);
    case 'recipient': return q.eq(d.pullPredicate.serverField, userId);
    case 'rls-only':  return q;
  }
}

export async function runPullOnce(): Promise<void> {
  const { data: { session } } = await getSupabase().auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return;

  for (const table of TABLE_ORDER) {
    const d = DESCRIPTORS[table];
    let cursor = await getCursor(table);
    let seen = new Set(cursor.lastSeenIds);
    const PAGE = 500;

    while (true) {
      let q = getSupabase().from(d.serverTable).select('*')
        .order('updated_at', { ascending: true })
        .order(d.serverSecondaryOrderField, { ascending: true })
        .limit(PAGE);
      q = applyPullPredicate(d, q, userId);
      if (cursor.lastPulledAt) q = q.gte('updated_at', cursor.lastPulledAt);
      const res = await q as { data: Record<string, unknown>[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const rows = res.data ?? [];
      if (rows.length === 0) break;

      let processed = 0;
      for (const r of rows) {
        const key = rowIdFromServerRow(d, r);
        // Skip rows we already processed at the boundary timestamp.
        if (cursor.lastPulledAt && r.updated_at === cursor.lastPulledAt && seen.has(key)) continue;
        await mergeRow(table, d, r, userId);
        processed++;
      }

      // Advance cursor to the page's last row's updated_at, accumulating IDs at that boundary.
      const last = rows[rows.length - 1];
      const newAt = last.updated_at as string;
      if (newAt === cursor.lastPulledAt) {
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowIdFromServerRow(d, r));
      } else {
        seen = new Set();
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowIdFromServerRow(d, r));
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
