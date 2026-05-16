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
