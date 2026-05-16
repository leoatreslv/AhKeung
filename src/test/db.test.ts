import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';

const UID = '00000000-0000-0000-0000-000000000001';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('Dexie database', () => {
  it('opens at schema version 4', async () => {
    expect(db.verno).toBe(4);
  });

  it('has the owned tables plus sync support tables', () => {
    const names = db.tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'favorites',
      'metrics',
      'plans',
      'sessions',
      'syncDeadLetter',
      'syncMeta',
      'syncQueue',
    ]);
  });

  describe('plans CRUD', () => {
    it('stores and retrieves a plan by UUID', async () => {
      const id = 'plan-uuid-1';
      await db.plans.put({
        id,
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
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
      await db.plans.put({
        id: 'plan-uuid-2',
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
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
      const id = 'session-uuid-1';
      await db.sessions.put({
        id,
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
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
    it('stores favorites keyed by [userId, exerciseId]', async () => {
      await db.favorites.put({
        userId: UID,
        exerciseId: 'Pullups',
        addedAt: Date.now(),
        updatedAt: Date.now(),
        serverVersion: null,
      });
      const got = await db.favorites.get([UID, 'Pullups']);
      expect(got?.exerciseId).toBe('Pullups');
    });

    it('lists favorites filtered by userId', async () => {
      await db.favorites.put({ userId: UID, exerciseId: 'Pullups',      addedAt: 1, updatedAt: 1, serverVersion: null });
      await db.favorites.put({ userId: UID, exerciseId: 'Barbell_Squat', addedAt: 2, updatedAt: 2, serverVersion: null });
      const all = await db.favorites.where('userId').equals(UID).toArray();
      expect(all.map((f) => f.exerciseId).sort()).toEqual(['Barbell_Squat', 'Pullups']);
    });
  });

  describe('metrics CRUD', () => {
    it('stores body metrics and queries ordered by date', async () => {
      await db.metrics.put({ id: 'm-1', userId: UID, updatedAt: 1, serverVersion: null, date: '2025-03-01', weightKg: 80 });
      await db.metrics.put({ id: 'm-2', userId: UID, updatedAt: 2, serverVersion: null, date: '2025-03-15', weightKg: 79 });
      await db.metrics.put({ id: 'm-3', userId: UID, updatedAt: 3, serverVersion: null, date: '2025-03-10', weightKg: 79.5 });

      const ordered = await db.metrics.orderBy('date').toArray();
      expect(ordered.map((m) => m.date)).toEqual(['2025-03-01', '2025-03-10', '2025-03-15']);
    });
  });

  describe('sync tables', () => {
    it('syncQueue auto-increments seq', async () => {
      const s1 = await db.syncQueue.add({
        table: 'plans', rowId: 'p1', op: 'insert',
        expectedServerVersion: null, attempts: 0, queuedAt: Date.now(),
      });
      const s2 = await db.syncQueue.add({
        table: 'plans', rowId: 'p2', op: 'insert',
        expectedServerVersion: null, attempts: 0, queuedAt: Date.now(),
      });
      expect(s2).toBe(s1 + 1);
    });

    it('syncMeta stores arbitrary key/value', async () => {
      await db.syncMeta.put({ key: 'plans.lastPulledAt', value: 'iso-string' });
      const got = await db.syncMeta.get('plans.lastPulledAt');
      expect(got?.value).toBe('iso-string');
    });
  });
});
