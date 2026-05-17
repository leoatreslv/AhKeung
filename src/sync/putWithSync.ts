import { db, type SyncTableName, type Plan, type WorkoutSession, type BodyMetric, type Favorite } from '../db';

export function favoriteRowId(userId: string, exerciseId: string): string {
  return `${userId}:${exerciseId}`;
}

export function parseFavoriteRowId(rowId: string): { userId: string; exerciseId: string } {
  const idx = rowId.indexOf(':');
  if (idx < 0) throw new Error(`malformed favorite rowId: ${rowId}`);
  return { userId: rowId.slice(0, idx), exerciseId: rowId.slice(idx + 1) };
}

type PartialOf<T extends SyncTableName> =
  T extends 'plans'     ? Partial<Plan>           & { id: string }
  : T extends 'sessions' ? Partial<WorkoutSession> & { id: string }
  : T extends 'metrics'  ? Partial<BodyMetric>     & { id: string }
  : T extends 'favorites'? Partial<Favorite>       & { exerciseId: string }
  : never;

export async function putWithSync<T extends SyncTableName>(
  table: T, partial: PartialOf<T>, userId: string,
): Promise<void> {
  await db.transaction('rw', db.table(table), db.syncQueue, async (tx) => {
    if (table === 'favorites') {
      const fav = partial as Partial<Favorite> & { exerciseId: string };
      const favTable = tx.table<Favorite, [string, string]>('favorites');
      const existing = await favTable.get([userId, fav.exerciseId]);
      const row: Favorite = {
        userId,
        exerciseId: fav.exerciseId,
        addedAt: fav.addedAt ?? existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
        serverVersion: existing?.serverVersion ?? null,
      };
      await favTable.put(row);
      await tx.table('syncQueue').add({
        table: 'favorites',
        rowId: favoriteRowId(userId, fav.exerciseId),
        op: existing ? 'update' : 'insert',
        expectedServerVersion: existing?.serverVersion ?? null,
        attempts: 0, queuedAt: Date.now(),
      });
      return;
    }

    const t = tx.table(table);
    const partialId = (partial as { id: string }).id;
    const existing = await t.get(partialId);
    const row = {
      ...existing,
      ...partial,
      userId,
      updatedAt: Date.now(),
      serverVersion: existing?.serverVersion ?? null,
    };
    await t.put(row);
    await tx.table('syncQueue').add({
      table,
      rowId: partialId,
      op: existing ? 'update' : 'insert',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
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
  await db.transaction('rw', db.table(table), db.syncQueue, async (tx) => {
    if (table === 'favorites') {
      const userId = a; const exerciseId = b!;
      const favTable = tx.table<Favorite, [string, string]>('favorites');
      const existing = await favTable.get([userId, exerciseId]);
      await favTable.delete([userId, exerciseId]);
      await tx.table('syncQueue').add({
        table: 'favorites',
        rowId: favoriteRowId(userId, exerciseId),
        op: 'delete',
        expectedServerVersion: existing?.serverVersion ?? null,
        attempts: 0, queuedAt: Date.now(),
      });
      return;
    }
    const t = tx.table(table);
    const existing = (await t.get(a)) as { serverVersion?: string | null } | undefined;
    await t.delete(a);
    await tx.table('syncQueue').add({
      table, rowId: a, op: 'delete',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
    });
  });
}
