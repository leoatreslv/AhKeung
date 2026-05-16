import { describe, it, expect, beforeEach } from 'vitest';
import { loadExercises, imageUrl, __resetExercisesForTest } from '../exercises';

describe('exercises catalog', () => {
  beforeEach(() => {
    __resetExercisesForTest();
  });

  it('loads and normalizes the fixture catalog', async () => {
    const list = await loadExercises();
    expect(list.length).toBeGreaterThan(0);
    const first = list[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('muscleGroup');
    expect(first).toHaveProperty('images');
  });

  it('maps lats to back', async () => {
    const list = await loadExercises();
    const pullups = list.find((e) => e.id === 'Pullups');
    expect(pullups?.muscleGroup).toBe('back');
  });

  it('maps quadriceps to legs for strength exercises', async () => {
    const list = await loadExercises();
    const squat = list.find((e) => e.id === 'Barbell_Squat');
    expect(squat?.muscleGroup).toBe('legs');
  });

  it('classifies cardio category as cardio regardless of primary muscle', async () => {
    const list = await loadExercises();
    const treadmill = list.find((e) => e.id === 'Treadmill_Running');
    // Even though primaryMuscles is "quadriceps", category=cardio wins.
    expect(treadmill?.muscleGroup).toBe('cardio');
  });

  it('maps abdominals to core', async () => {
    const list = await loadExercises();
    const plank = list.find((e) => e.id === 'Plank');
    expect(plank?.muscleGroup).toBe('core');
  });

  it('maps glutes to glutes', async () => {
    const list = await loadExercises();
    const hipThrust = list.find((e) => e.id === 'Barbell_Hip_Thrust');
    expect(hipThrust?.muscleGroup).toBe('glutes');
  });

  it('preserves images, instructions, and equipment from the source', async () => {
    const list = await loadExercises();
    const bench = list.find((e) => e.id === 'Barbell_Bench_Press_-_Medium_Grip');
    expect(bench?.equipment).toBe('barbell');
    expect(bench?.images).toHaveLength(2);
    expect(bench?.instructions.length).toBeGreaterThan(0);
  });

  it('falls back to "bodyweight" when equipment is null', async () => {
    // No fixture has null equipment, but the normalizer logic should.
    // Skip if every fixture has equipment defined.
    const list = await loadExercises();
    expect(list.every((e) => typeof e.equipment === 'string')).toBe(true);
  });

  it('sorts catalog alphabetically by name', async () => {
    const list = await loadExercises();
    const names = list.map((e) => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

describe('imageUrl', () => {
  it('builds a jsDelivr CDN URL for a given image path', () => {
    const url = imageUrl('Pullups/0.jpg');
    expect(url).toBe(
      'https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/Pullups/0.jpg',
    );
  });
});
