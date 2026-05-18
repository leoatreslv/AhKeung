import { db, type SyncTableName } from '../db';
import {
  descriptorFor,
  rowIdFromKey,
  rowIdFromClientRow,
  type TableDescriptor,
} from './descriptors';

// Legacy helpers kept for callers outside src/sync/. The internal sync code
// goes through the descriptors instead — these wrappers will eventually be
// inlined once the last call site moves to descriptor-aware code.
export function favoriteRowId(userId: string, exerciseId: string): string {
  return rowIdFromKey(descriptorFor('favorites'), [userId, exerciseId]);
}

export function parseFavoriteRowId(rowId: string): { userId: string; exerciseId: string } {
  const idx = rowId.indexOf(':');
  if (idx < 0) throw new Error(`malformed favorite rowId: ${rowId}`);
  return { userId: rowId.slice(0, idx), exerciseId: rowId.slice(idx + 1) };
}

type Partials = {
  plans:     Partial<import('../db').Plan>           & { id: string };
  sessions:  Partial<import('../db').WorkoutSession> & { id: string };
  metrics:   Partial<import('../db').BodyMetric>     & { id: string };
  favorites: Partial<import('../db').Favorite>       & { exerciseId: string };
};
type PartialOf<T extends SyncTableName> = Partials[T];

/** Build the merged row that gets put into Dexie. Each descriptor's
 *  ownerField is overwritten with the supplied userId. */
function mergeRow(
  d: TableDescriptor,
  partial: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  userId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...existing, ...partial };
  base[d.ownerClientField] = userId;
  base.updatedAt = Date.now();
  base.serverVersion = (existing?.serverVersion as string | null | undefined) ?? null;
  // favorites needs addedAt fallback (it's part of the row, not a system column)
  if (d.dexieTable === 'favorites') {
    base.addedAt = base.addedAt ?? Date.now();
  }
  return base;
}

async function existingRow(
  d: TableDescriptor,
  partial: Record<string, unknown>,
  userId: string,
): Promise<Record<string, unknown> | undefined> {
  if (d.pkKind === 'single') {
    return await db.table(d.dexieTable).get(partial[d.pkClientFields[0]] as string) as
      Record<string, unknown> | undefined;
  }
  // composite — for favorites, the first field is userId from arg, second from partial
  const second = partial[d.pkClientFields[1]] as string;
  return await db.table(d.dexieTable).get([userId, second]) as
    Record<string, unknown> | undefined;
}

export async function putWithSync<T extends SyncTableName>(
  table: T, partial: PartialOf<T>, userId: string,
): Promise<void> {
  const d = descriptorFor(table);
  if (d.writability === 'never') {
    throw new Error(`${d.dexieTable} is a read-only synced table`);
  }
  await db.transaction('rw', db.table(table), db.syncQueue, async () => {
    const existing = await existingRow(d, partial as unknown as Record<string, unknown>, userId);
    const row = mergeRow(d, partial as unknown as Record<string, unknown>, existing, userId);

    // Writability: shared-in rows (owner !== me) can't be mutated locally.
    // For PR 0 all four descriptors are 'own-only' AND every row's owner is
    // already the local user, so this branch is currently unreachable; PR 1
    // adds tables where this triggers.
    const existingOwner = existing?.[d.ownerClientField] as string | undefined;
    if (existing && existingOwner && existingOwner !== userId) {
      throw new Error(
        `cannot mutate ${d.dexieTable} row owned by ${existingOwner} as ${userId}`,
      );
    }

    await db.table(d.dexieTable).put(row);
    await db.syncQueue.add({
      table,
      rowId: rowIdFromClientRow(d, row),
      op: existing ? 'update' : 'insert',
      expectedServerVersion: (existing?.serverVersion as string | null | undefined) ?? null,
      attempts: 0,
      queuedAt: Date.now(),
    });
  });
}

export async function deleteWithSync(
  table: Exclude<SyncTableName, 'favorites'>, rowId: string,
): Promise<void>;
export async function deleteWithSync(
  table: 'favorites', userId: string, exerciseId: string,
): Promise<void>;
export async function deleteWithSync(
  table: SyncTableName, a: string, b?: string,
): Promise<void> {
  const d = descriptorFor(table);
  if (d.writability === 'never') {
    throw new Error(`${d.dexieTable} is a read-only synced table`);
  }
  await db.transaction('rw', db.table(table), db.syncQueue, async () => {
    const rowId = d.pkKind === 'single' ? a : rowIdFromKey(d, [a, b!]);
    const lookupKey: string | [string, string] = d.pkKind === 'single' ? a : [a, b!];
    const existing = await db.table(d.dexieTable).get(lookupKey as never) as
      Record<string, unknown> | undefined;

    const existingOwner = existing?.[d.ownerClientField] as string | undefined;
    // For single-PK tables we don't have a userId on the call site, so we
    // can only enforce the guard for composite (where the caller passed it).
    if (existing && existingOwner && d.pkKind === 'composite' && existingOwner !== a) {
      throw new Error(
        `cannot delete ${d.dexieTable} row owned by ${existingOwner} as ${a}`,
      );
    }

    await db.table(d.dexieTable).delete(lookupKey as never);
    await db.syncQueue.add({
      table,
      rowId,
      op: 'delete',
      expectedServerVersion: (existing?.serverVersion as string | null | undefined) ?? null,
      attempts: 0,
      queuedAt: Date.now(),
    });
  });
}
