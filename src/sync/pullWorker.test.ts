import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { runPullOnce } from './pullWorker';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('pullWorker', () => {
  it('inserts new server rows into Dexie and sets serverVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso1', updated_at: 'iso2',
    });

    await runPullOnce();

    const local = await db.plans.get('p1');
    expect(local?.name).toBe('A');
    expect(local?.serverVersion).toBe('iso2');
  });

  it('skips overwrite when the row has a pending queue entry', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    // Local row with pending update queued
    await db.plans.put({
      id: 'p1', userId: 'u-1', updatedAt: 5, serverVersion: 'v1',
      name: 'LOCAL', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    });
    await db.syncQueue.add({
      table: 'plans', rowId: 'p1', op: 'update', expectedServerVersion: 'v1',
      attempts: 0, queuedAt: 1,
    });
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'SERVER', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso0', updated_at: 'iso999',
    });

    await runPullOnce();

    expect((await db.plans.get('p1'))?.name).toBe('LOCAL');
  });

  it('deletes local row when server has deleted_at', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await db.plans.put({
      id: 'p1', userId: 'u-1', updatedAt: 5, serverVersion: 'v1',
      name: 'L', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    });
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'L', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso0', updated_at: 'iso999', deleted_at: 'iso999',
    });

    await runPullOnce();

    expect(await db.plans.get('p1')).toBeUndefined();
  });
});
