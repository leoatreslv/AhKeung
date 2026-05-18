import { type ExerciseMeta } from './exercises';

// PR 1 stub. The free-exercise-db catalogue is being removed (PR 2) and
// replaced with trainer-authored exercises (PR 3). Between PR 1 and PR 3
// the picker and library render an empty state — documented in the
// trainer-exercises plan as the W13 transitional window.
//
// Once PR 3 lands, useExercises (or its successor useCustomExercises /
// useSharedExercises) will live-query db.exercises and adapt the row
// shape to the call sites that still consume ExerciseMeta.

export function useExercises(): ExerciseMeta[] | null {
  return [];
}

export function useExercise(_id: string | undefined): ExerciseMeta | undefined {
  void _id;
  return undefined;
}
