// Per-table descriptors consumed by the sync workers. Each descriptor captures
// how a synced table is shaped on both sides of the wire: primary key, owner
// column (for writability + pull predicate), and the ordering field used to
// break ties at the cursor boundary.
//
// Adding a new synced table = adding a descriptor here and registering it in
// DESCRIPTORS. The workers iterate that map; nothing else in src/sync/ should
// reach for table names directly.

import type { SyncTableName } from '../db';

export type PullPredicateKind = 'owner' | 'recipient' | 'rls-only';
export type Writability = 'own-only' | 'never';

type PKShape =
  | { pkKind: 'single';    pkClientFields: readonly [string];          pkServerFields: readonly [string] }
  | { pkKind: 'composite'; pkClientFields: readonly [string, string]; pkServerFields: readonly [string, string] };

export type TableDescriptor = PKShape & {
  /** Server table name (snake_case). */
  serverTable: string;
  /** Dexie table name (camelCase). */
  dexieTable: string;

  /** Client-side (camelCase) and server-side (snake_case) name of the column
   *  whose value identifies the row's owner. Used by the writability guard
   *  (only rows where ownerField === currentUserId may be mutated locally)
   *  and, in some cases, by the pull predicate below. */
  ownerClientField: string;
  ownerServerField: string;

  /** How the ownerField relates to the current user.
   *   - `'self'`: the column value IS the user_id of the owner. The
   *     writability guard checks `existing.ownerField === currentUserId`
   *     and mergeRow stamps that column with currentUserId.
   *   - `'parent'`: the column points at a parent record (e.g.
   *     bundle_items.bundle_id). The client trusts the call site; RLS
   *     enforces real ownership via the parent table's policy. The
   *     writability check is skipped, and mergeRow doesn't overwrite. */
  ownerKind: 'self' | 'parent';

  /** Whether the local user is allowed to mutate this row.
   *   - `'own-only'`: putWithSync/deleteWithSync enforce ownership.
   *   - `'never'`: the table is a read-only cache of rows pulled from the
   *     server; mutation attempts return early. */
  writability: Writability;

  /** Server-side predicate the pull worker adds (in addition to RLS). */
  pullPredicate:
    | { kind: 'owner' }
    | { kind: 'recipient'; serverField: string }
    | { kind: 'rls-only' };

  /** Secondary ordering field for stable pagination at a cursor boundary.
   *  Single-PK tables use 'id'; composite-PK tables use their second server
   *  field (e.g. favorites uses 'exercise_id'). */
  serverSecondaryOrderField: string;
};

/** Minimal query-builder shape we need from Supabase for key filters. */
export interface KeyFilterable {
  eq(col: string, val: unknown): this;
}

/** Encode the rowId stored in syncQueue from a typed key tuple. */
export function rowIdFromKey(
  d: TableDescriptor,
  key: string | readonly [string, string],
): string {
  if (d.pkKind === 'single') {
    if (typeof key !== 'string') throw new Error(`${d.dexieTable} expects single key`);
    return key;
  }
  if (typeof key === 'string') throw new Error(`${d.dexieTable} expects composite key`);
  return `${key[0]}:${key[1]}`;
}

/** Decode the rowId stored in syncQueue back into the Dexie lookup key. */
export function keyFromRowId(
  d: TableDescriptor,
  rowId: string,
): string | [string, string] {
  if (d.pkKind === 'single') return rowId;
  const idx = rowId.indexOf(':');
  if (idx < 0) throw new Error(`malformed composite rowId for ${d.dexieTable}: ${rowId}`);
  return [rowId.slice(0, idx), rowId.slice(idx + 1)];
}

/** Read the rowId from a client-shaped (camelCase) row. */
export function rowIdFromClientRow(
  d: TableDescriptor,
  row: Record<string, unknown>,
): string {
  if (d.pkKind === 'single') return row[d.pkClientFields[0]] as string;
  const [a, b] = d.pkClientFields;
  return `${row[a]}:${row[b]}`;
}

/** Read the rowId from a server-shaped (snake_case) row. */
export function rowIdFromServerRow(
  d: TableDescriptor,
  row: Record<string, unknown>,
): string {
  if (d.pkKind === 'single') return row[d.pkServerFields[0]] as string;
  const [a, b] = d.pkServerFields;
  return `${row[a]}:${row[b]}`;
}

/** Apply the descriptor's PK filter (`.eq('id', x)` or compound) to a
 *  Supabase query builder. The generic parameter is constrained to
 *  KeyFilterable to avoid TypeScript traversing the full Supabase builder
 *  type tree (which is recursive and overflows the inference depth limit
 *  if left unconstrained). */
export function applyServerKeyFilter<Q extends KeyFilterable>(
  d: TableDescriptor,
  q: Q,
  rowId: string,
): Q {
  if (d.pkKind === 'single') return q.eq(d.pkServerFields[0], rowId);
  const key = keyFromRowId(d, rowId) as [string, string];
  return q.eq(d.pkServerFields[0], key[0]).eq(d.pkServerFields[1], key[1]);
}

// ---------------------------------------------------------------------------
// Registry. Pre-existing four tables plus the PR 1 additions.
// ---------------------------------------------------------------------------

export const DESCRIPTORS: Record<SyncTableName, TableDescriptor> = {
  plans: {
    serverTable: 'plans',
    dexieTable: 'plans',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'userId',
    ownerServerField: 'user_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'owner' },
    serverSecondaryOrderField: 'id',
  },
  sessions: {
    serverTable: 'sessions',
    dexieTable: 'sessions',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'userId',
    ownerServerField: 'user_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'owner' },
    serverSecondaryOrderField: 'id',
  },
  metrics: {
    serverTable: 'metrics',
    dexieTable: 'metrics',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'userId',
    ownerServerField: 'user_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'owner' },
    serverSecondaryOrderField: 'id',
  },
  favorites: {
    serverTable: 'favorites',
    dexieTable: 'favorites',
    pkKind: 'composite',
    pkClientFields: ['userId', 'exerciseId'],
    pkServerFields: ['user_id', 'exercise_id'],
    ownerClientField: 'userId',
    ownerServerField: 'user_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'owner' },
    serverSecondaryOrderField: 'exercise_id',
  },

  // ─── PR 1 additions ─────────────────────────────────────────────────

  // Trainer-authored exercises. Stored locally for both owner and recipients;
  // mutation guarded by writability='own-only' + ownerField check. The pull
  // predicate is rls-only because the RLS policy already returns:
  //   * rows the user owns, AND
  //   * rows shared in (directly or via bundle).
  // Adding .eq('owner_id', me) would WRONGLY filter out shared-in rows.
  exercises: {
    serverTable: 'exercises',
    dexieTable: 'exercises',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'ownerId',
    ownerServerField: 'owner_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'rls-only' },
    serverSecondaryOrderField: 'id',
  },

  exerciseBundles: {
    serverTable: 'exercise_bundles',
    dexieTable: 'exerciseBundles',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'ownerId',
    ownerServerField: 'owner_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'rls-only' },
    serverSecondaryOrderField: 'id',
  },

  // Bundle items have no direct owner column — writability is enforced by
  // the parent bundle's RLS. From the client side, mutations go through the
  // bundle editor which loads the parent bundle and ensures ownership; we
  // treat the table as 'own-only' but with no owner field to compare against,
  // so the guard in putWithSync degenerates to "trust the call site."
  // The pull predicate is rls-only (recipient of a bundle share also pulls).
  exerciseBundleItems: {
    serverTable: 'exercise_bundle_items',
    dexieTable: 'exerciseBundleItems',
    pkKind: 'composite',
    pkClientFields: ['bundleId', 'exerciseId'],
    pkServerFields: ['bundle_id', 'exercise_id'],
    ownerClientField: 'bundleId',
    ownerServerField: 'bundle_id',
    // bundle_items has no user_id column; ownership is conferred by the
    // parent bundle. RLS enforces that real ownership server-side; the
    // client trusts the bundle-editor call site.
    ownerKind: 'parent',
    writability: 'own-only',
    pullPredicate: { kind: 'rls-only' },
    serverSecondaryOrderField: 'exercise_id',
  },

  // Shares: owner is the granter. Recipient pulls them too (via RLS).
  shares: {
    serverTable: 'shares',
    dexieTable: 'shares',
    pkKind: 'single',
    pkClientFields: ['id'],
    pkServerFields: ['id'],
    ownerClientField: 'granterId',
    ownerServerField: 'granter_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'rls-only' },
    serverSecondaryOrderField: 'id',
  },

  // Trainer-trainees: composite PK. Trainer is the owner (inserts +
  // deletes); trainee may update status. Both can read their own rows.
  trainerTrainees: {
    serverTable: 'trainer_trainees',
    dexieTable: 'trainerTrainees',
    pkKind: 'composite',
    pkClientFields: ['trainerId', 'traineeId'],
    pkServerFields: ['trainer_id', 'trainee_id'],
    ownerClientField: 'trainerId',
    ownerServerField: 'trainer_id',
    writability: 'own-only',
    ownerKind: 'self',
    pullPredicate: { kind: 'rls-only' },
    serverSecondaryOrderField: 'trainee_id',
  },

  // Note: server-side `plan_exercises` (trigger-maintained projection of
  // plans.exercises for indexable RLS joins) is deliberately not synced to
  // Dexie — the client already has plans.exercises in canonical shape.
};

export function descriptorFor(table: SyncTableName): TableDescriptor {
  const d = DESCRIPTORS[table];
  if (!d) throw new Error(`no sync descriptor for table: ${table}`);
  return d;
}
