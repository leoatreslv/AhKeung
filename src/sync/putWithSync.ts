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
  plans:               Partial<import('../db').Plan>                & { id: string };
  sessions:            Partial<import('../db').WorkoutSession>      & { id: string };
  metrics:             Partial<import('../db').BodyMetric>          & { id: string };
  favorites:           Partial<import('../db').Favorite>            & { exerciseId: string };
  exercises:           Partial<import('../db').CustomExercise>      & { id: string };
  exerciseBundles:     Partial<import('../db').ExerciseBundle>      & { id: string };
  exerciseBundleItems: Partial<import('../db').ExerciseBundleItem>  & { bundleId: string; exerciseId: string };
  shares:              Partial<import('../db').Share>               & { id: string };
  trainerTrainees:     Partial<import('../db').TrainerTrainee>      & { trainerId: string; traineeId: string };
};
type PartialOf<T extends SyncTableName> = Partials[T];

/** Build the merged row that gets put into Dexie. */
function mergeRow(
  d: TableDescriptor,
  partial: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  userId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...existing, ...partial };
  // 'self'-owned tables get their owner column stamped with the current user.
  // 'parent'-owned tables (bundle_items) keep whatever the caller passed.
  if (d.ownerKind === 'self') {
    base[d.ownerClientField] = userId;
  }
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
  // composite — first field comes from the partial if present, else the
  // userId arg (legacy favorites call style where the caller passes only
  // the second key field).
  const first = (partial[d.pkClientFields[0]] as string | undefined) ?? userId;
  const second = partial[d.pkClientFields[1]] as string;
  return await db.table(d.dexieTable).get([first, second]) as
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
    // Skip the check for 'parent'-owned tables where the ownerField doesn't
    // hold a user_id (RLS enforces real ownership on the server).
    if (d.ownerKind === 'self') {
      const existingOwner = existing?.[d.ownerClientField] as string | undefined;
      if (existing && existingOwner && existingOwner !== userId) {
        throw new Error(
          `cannot mutate ${d.dexieTable} row owned by ${existingOwner} as ${userId}`,
        );
      }
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

type SingleKeyTable = 'plans' | 'sessions' | 'metrics' | 'exercises' | 'exerciseBundles' | 'shares';
type CompositeKeyTable = 'favorites' | 'exerciseBundleItems' | 'trainerTrainees';

export async function deleteWithSync(table: SingleKeyTable, rowId: string): Promise<void>;
export async function deleteWithSync(table: CompositeKeyTable, pkPart1: string, pkPart2: string): Promise<void>;
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

    // For composite-PK self-owned tables (favorites), `a` is the userId.
    // For composite-PK parent-owned tables (bundle_items), `a` is the parent's
    // id. In both cases, mismatch with the existing owner field would be a bug
    // upstream; we only flag self-owned ones here.
    if (d.ownerKind === 'self' && d.pkKind === 'composite') {
      const existingOwner = existing?.[d.ownerClientField] as string | undefined;
      if (existing && existingOwner && existingOwner !== a) {
        throw new Error(
          `cannot delete ${d.dexieTable} row owned by ${existingOwner} as ${a}`,
        );
      }
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
