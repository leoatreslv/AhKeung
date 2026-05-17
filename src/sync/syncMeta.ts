import { db, type SyncTableName } from '../db';

export interface Cursor {
  lastPulledAt: string | null;  // ISO timestamp from server
  lastSeenIds: string[];        // IDs at the boundary timestamp already merged
}

function key(table: SyncTableName) { return `${table}.cursor`; }

export async function getCursor(table: SyncTableName): Promise<Cursor> {
  const row = await db.syncMeta.get(key(table));
  return (row?.value as Cursor | undefined) ?? { lastPulledAt: null, lastSeenIds: [] };
}

export async function setCursor(table: SyncTableName, cursor: Cursor): Promise<void> {
  await db.syncMeta.put({ key: key(table), value: cursor });
}
