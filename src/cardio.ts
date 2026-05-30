import type { CustomExercise, PlanExercise, SetLog } from './db';

export type ExerciseKind = 'strength' | 'cardio';

const CARDIO_DEFAULTS = { inclinePct: 0, speedKmh: 6, durationSec: 1800 } as const;

/** Single read path for an exercise's modality; absent kind => strength. */
export function exerciseKind(ex: Pick<CustomExercise, 'kind'> | undefined | null): ExerciseKind {
  return ex?.kind === 'cardio' ? 'cardio' : 'strength';
}

/** Decimal minutes -> whole seconds. Invalid/<=0 -> 0. */
export function minutesToSeconds(min: number): number {
  if (!Number.isFinite(min) || min <= 0) return 0;
  return Math.round(min * 60);
}

/** Seconds -> minutes rounded to 2dp. Missing/<=0 -> 0. */
export function secondsToMinutes(sec: number | undefined): number {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round((sec / 60) * 100) / 100;
}

/** Build the next logged set, carrying over the relevant fields by kind. */
export function nextSet(last: SetLog | undefined, kind: ExerciseKind): SetLog {
  if (kind === 'cardio') {
    return {
      reps: 0, weight: 0, done: false,
      inclinePct: last?.inclinePct ?? CARDIO_DEFAULTS.inclinePct,
      speedKmh: last?.speedKmh ?? CARDIO_DEFAULTS.speedKmh,
      durationSec: last?.durationSec ?? CARDIO_DEFAULTS.durationSec,
    };
  }
  return { reps: last?.reps ?? 10, weight: last?.weight ?? 0, done: false };
}

/** Seed a session's sets from a plan exercise's targets. */
export function setsFromPlanExercise(pe: PlanExercise, kind: ExerciseKind): SetLog[] {
  const count = Math.max(1, pe.targetSets);
  return Array.from({ length: count }, () =>
    kind === 'cardio'
      ? {
          reps: 0, weight: 0, done: false,
          inclinePct: pe.targetInclinePct ?? CARDIO_DEFAULTS.inclinePct,
          speedKmh: pe.targetSpeedKmh ?? CARDIO_DEFAULTS.speedKmh,
          durationSec: pe.targetDurationSec ?? CARDIO_DEFAULTS.durationSec,
        }
      : { reps: pe.targetReps, weight: pe.targetWeight ?? 0, done: false },
  );
}

/** Default plan-exercise row when adding to a plan. */
export function defaultPlanExercise(exId: string, kind: ExerciseKind): PlanExercise {
  return kind === 'cardio'
    ? {
        exerciseId: exId, targetSets: 1, targetReps: 0,
        targetInclinePct: CARDIO_DEFAULTS.inclinePct,
        targetSpeedKmh: CARDIO_DEFAULTS.speedKmh,
        targetDurationSec: CARDIO_DEFAULTS.durationSec,
      }
    : { exerciseId: exId, targetSets: 3, targetReps: 10 };
}

/** One-line history summary for a cardio set. Units are symbols (not i18n). */
export function cardioSetSummary(set: SetLog): string {
  return [
    `${secondsToMinutes(set.durationSec)}min`,
    `${set.speedKmh ?? 0}km/h`,
    `${set.inclinePct ?? 0}%`,
  ].join(' · ');
}
