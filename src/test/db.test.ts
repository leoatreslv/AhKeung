import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('Dexie database', () => {
  it('opens at schema version 3', async () => {
    expect(db.verno).toBe(3);
  });

  it('has four tables: plans, sessions, metrics, favorites', () => {
    const names = db.tables.map((t) => t.name).sort();
    expect(names).toEqual(['favorites', 'metrics', 'plans', 'sessions']);
  });

  describe('plans CRUD', () => {
    it('stores and retrieves a plan', async () => {
      const id = await db.plans.add({
        name: 'Push Day',
        weekStart: '2025-03-10',
        focus: ['chest', 'triceps'],
        exercises: [
          { exerciseId: 'Barbell_Bench_Press_-_Medium_Grip', targetSets: 3, targetReps: 8 },
        ],
        createdAt: Date.now(),
      });
      const got = await db.plans.get(id);
      expect(got?.name).toBe('Push Day');
      expect(got?.focus).toEqual(['chest', 'triceps']);
      expect(got?.exercises).toHaveLength(1);
    });

    it('looks up by weekStart index', async () => {
      await db.plans.add({
        name: 'Week 1',
        weekStart: '2025-03-10',
        focus: ['back'],
        exercises: [],
        createdAt: Date.now(),
      });
      const found = await db.plans.where('weekStart').equals('2025-03-10').first();
      expect(found?.name).toBe('Week 1');
    });
  });

  describe('sessions CRUD', () => {
    it('stores a workout session with completed sets', async () => {
      const id = await db.sessions.add({
        date: '2025-03-10',
        startedAt: Date.now(),
        endedAt: Date.now() + 30 * 60_000,
        exercises: [
          {
            exerciseId: 'Pullups',
            sets: [
              { reps: 8, weight: 0, done: true },
              { reps: 6, weight: 0, done: true },
              { reps: 5, weight: 0, done: false },
            ],
          },
        ],
      });
      const got = await db.sessions.get(id);
      const doneCount = got?.exercises[0].sets.filter((s) => s.done).length;
      expect(doneCount).toBe(2);
    });
  });

  describe('favorites CRUD', () => {
    it('toggles a favorite via the helper', async () => {
      const { toggleFavorite } = await import('../useFavorites');

      await toggleFavorite('Pullups');
      expect(await db.favorites.get('Pullups')).toBeDefined();

      await toggleFavorite('Pullups');
      expect(await db.favorites.get('Pullups')).toBeUndefined();
    });

    it('stores multiple favorites keyed by exerciseId', async () => {
      const { toggleFavorite } = await import('../useFavorites');
      await toggleFavorite('Pullups');
      await toggleFavorite('Barbell_Squat');
      const all = await db.favorites.toArray();
      expect(all.map((f) => f.exerciseId).sort()).toEqual(['Barbell_Squat', 'Pullups']);
    });
  });

  describe('metrics CRUD', () => {
    it('stores body metrics and queries ordered by date', async () => {
      await db.metrics.add({ date: '2025-03-01', weightKg: 80 });
      await db.metrics.add({ date: '2025-03-15', weightKg: 79 });
      await db.metrics.add({ date: '2025-03-10', weightKg: 79.5 });

      const ordered = await db.metrics.orderBy('date').toArray();
      expect(ordered.map((m) => m.date)).toEqual(['2025-03-01', '2025-03-10', '2025-03-15']);
    });
  });
});
