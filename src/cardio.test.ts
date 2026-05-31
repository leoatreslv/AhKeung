import { describe, it, expect } from 'vitest';
import type { PlanExercise, SetLog } from './db';
import {
  exerciseKind,
  minutesToSeconds,
  secondsToMinutes,
  nextSet,
  setsFromPlanExercise,
  defaultPlanExercise,
  cardioSetSummary,
} from './cardio';

describe('exerciseKind', () => {
  it('defaults undefined/absent to strength', () => {
    expect(exerciseKind(undefined)).toBe('strength');
    expect(exerciseKind({ kind: undefined })).toBe('strength');
  });
  it('honours cardio', () => {
    expect(exerciseKind({ kind: 'cardio' })).toBe('cardio');
  });
});

describe('minutes <-> seconds', () => {
  it('converts minutes to whole seconds', () => {
    expect(minutesToSeconds(30)).toBe(1800);
    expect(minutesToSeconds(12.5)).toBe(750);
  });
  it('floors invalid/negative/zero minutes to 0', () => {
    expect(minutesToSeconds(0)).toBe(0);
    expect(minutesToSeconds(-5)).toBe(0);
    expect(minutesToSeconds(NaN)).toBe(0);
  });
  it('converts seconds back to minutes (2dp), empty -> 0', () => {
    expect(secondsToMinutes(1800)).toBe(30);
    expect(secondsToMinutes(750)).toBe(12.5);
    expect(secondsToMinutes(undefined)).toBe(0);
  });
});

describe('nextSet', () => {
  it('clones reps/weight for strength', () => {
    const last: SetLog = { reps: 8, weight: 40, done: true };
    expect(nextSet(last, 'strength')).toEqual({ reps: 8, weight: 40, done: false });
  });
  it('clones incline/speed/time for cardio', () => {
    const last: SetLog = { reps: 0, weight: 0, done: true, inclinePct: 2, speedKmh: 8, durationSec: 600 };
    expect(nextSet(last, 'cardio')).toEqual({
      reps: 0, weight: 0, done: false, inclinePct: 2, speedKmh: 8, durationSec: 600,
    });
  });
  it('uses defaults when there is no previous set', () => {
    expect(nextSet(undefined, 'cardio')).toEqual({
      reps: 0, weight: 0, done: false, inclinePct: 0, speedKmh: 6, durationSec: 1800,
    });
    expect(nextSet(undefined, 'strength')).toEqual({ reps: 10, weight: 0, done: false });
  });
});

describe('setsFromPlanExercise', () => {
  it('maps strength targets into N sets', () => {
    const pe: PlanExercise = { exerciseId: 'a', targetSets: 2, targetReps: 12, targetWeight: 50 };
    expect(setsFromPlanExercise(pe, 'strength')).toEqual([
      { reps: 12, weight: 50, done: false },
      { reps: 12, weight: 50, done: false },
    ]);
  });
  it('maps cardio targets into the first set (min one set)', () => {
    const pe: PlanExercise = { exerciseId: 'a', targetSets: 1, targetReps: 0, targetInclinePct: 1, targetSpeedKmh: 7, targetDurationSec: 1200 };
    expect(setsFromPlanExercise(pe, 'cardio')).toEqual([
      { reps: 0, weight: 0, done: false, inclinePct: 1, speedKmh: 7, durationSec: 1200 },
    ]);
  });
});

describe('defaultPlanExercise', () => {
  it('strength default', () => {
    expect(defaultPlanExercise('a', 'strength')).toEqual({ exerciseId: 'a', targetSets: 3, targetReps: 10 });
  });
  it('cardio default', () => {
    expect(defaultPlanExercise('a', 'cardio')).toEqual({
      exerciseId: 'a', targetSets: 1, targetReps: 0, targetInclinePct: 0, targetSpeedKmh: 6, targetDurationSec: 1800,
    });
  });
});

describe('cardioSetSummary', () => {
  it('formats time/speed/incline', () => {
    const set: SetLog = { reps: 0, weight: 0, done: true, inclinePct: 2, speedKmh: 6, durationSec: 1800 };
    expect(cardioSetSummary(set)).toBe('30min · 6km/h · 2%');
  });
  it('tolerates missing fields', () => {
    expect(cardioSetSummary({ reps: 0, weight: 0, done: true })).toBe('0min · 0km/h · 0%');
  });
});
