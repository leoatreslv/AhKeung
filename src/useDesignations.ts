// Live queries over trainer↔trainee designations.
//
// All four queries are pulled from Dexie (populated by the sync worker
// via the existing `trainer_trainees` descriptor with pullPredicate
// 'rls-only'). The server's RLS policies guarantee the user only ever
// sees rows where they are the trainer or the trainee.

import { useLiveQuery } from 'dexie-react-hooks';
import { db, type TrainerTrainee, type DesignationStatus } from './db';
import { useCurrentUserId } from './auth/useCurrentUserId';

/** Designations where the current user is the trainer (any status). */
export function useMyTrainees(): TrainerTrainee[] | undefined {
  const userId = useCurrentUserId();
  return useLiveQuery<TrainerTrainee[]>(
    () => (userId
      ? db.trainerTrainees.where('trainerId').equals(userId).toArray()
      : Promise.resolve([] as TrainerTrainee[])),
    [userId],
  );
}

/** Designations where the current user is the trainee (any status). */
export function useMyTrainers(): TrainerTrainee[] | undefined {
  const userId = useCurrentUserId();
  return useLiveQuery<TrainerTrainee[]>(
    () => (userId
      ? db.trainerTrainees.where('traineeId').equals(userId).toArray()
      : Promise.resolve([] as TrainerTrainee[])),
    [userId],
  );
}

/** Filter helper that splits a list of designations by status. */
export function partitionByStatus<T extends { status: DesignationStatus }>(
  rows: T[] | undefined,
): { pending: T[]; accepted: T[]; declined: T[] } {
  const out = { pending: [] as T[], accepted: [] as T[], declined: [] as T[] };
  for (const r of rows ?? []) out[r.status].push(r);
  return out;
}
