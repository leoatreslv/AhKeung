import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync } from './putWithSync';
import { runPushOnce } from './pushWorker';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('pushWorker — insert happy path', () => {
  it('inserts a queued row to fake Supabase and clears the queue', async () => {
    stubAuthenticatedUser({ id: 'u-1' });

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await runPushOnce();

    const fake = getActiveFake();
    expect(fake.rowOf('plans', 'p1')).toBeDefined();
    expect(await db.syncQueue.count()).toBe(0);
    const local = await db.plans.get('p1');
    expect(local?.serverVersion).toBe(fake.rowOf('plans', 'p1').updated_at);
  });
});

describe('pushWorker — update with optimistic CC', () => {
  it('uses conditional update on updated_at and refreshes serverVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    // Initial insert and push
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();
    const v1 = (await db.plans.get('p1'))!.serverVersion!;

    // Local update
    await putWithSync('plans', {
      id: 'p1', name: 'B', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    expect((await db.syncQueue.toArray())[0].expectedServerVersion).toBe(v1);

    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').name).toBe('B');
    const v2 = (await db.plans.get('p1'))!.serverVersion!;
    expect(v2).not.toBe(v1);
    expect(await db.syncQueue.count()).toBe(0);
  });
});

describe('pushWorker — conflict pull-and-replay', () => {
  it('pulls and re-pushes when server is newer than expectedServerVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();

    // Other device wrote to the server.
    const row = fake.rowOf('plans', 'p1');
    row.name = 'OTHER';
    row.updated_at = new Date(Date.now() + 1000).toISOString();

    // Local edit while we held an older serverVersion.
    await putWithSync('plans', {
      id: 'p1', name: 'LOCAL', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').name).toBe('LOCAL');
    expect(await db.syncQueue.count()).toBe(0);
    expect((await db.plans.get('p1'))!.serverVersion).toBe(fake.rowOf('plans', 'p1').updated_at);
  });
});
