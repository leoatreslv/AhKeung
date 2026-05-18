import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { shareResource, unshareResource } from '../sharing';
import { putWithSync } from '../sync/putWithSync';
import { stubAuthenticatedUser } from './authStub';

const TRAINER = 'u-trainer';
const TRAINEE = 'u-trainee';

beforeEach(async () => {
  await db.delete();
  await db.open();
  stubAuthenticatedUser({ id: TRAINER, isTrainer: true });
});

describe('shareResource', () => {
  it('writes a shares row and enqueues a sync insert', async () => {
    await shareResource('exercise', 'ex-1', TRAINEE, TRAINER);
    const rows = await db.shares.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      granterId: TRAINER,
      recipientId: TRAINEE,
      resourceType: 'exercise',
      resourceId: 'ex-1',
    });

    const queue = await db.syncQueue.toArray();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ table: 'shares', op: 'insert' });
  });

  it('is idempotent — re-sharing the same resource to the same recipient is a no-op', async () => {
    await shareResource('exercise', 'ex-1', TRAINEE, TRAINER);
    await shareResource('exercise', 'ex-1', TRAINEE, TRAINER);
    const rows = await db.shares.toArray();
    expect(rows).toHaveLength(1);
  });

  it('share + unshare leaves no live row', async () => {
    await shareResource('bundle', 'bundle-1', TRAINEE, TRAINER);
    const created = await db.shares.toArray();
    expect(created).toHaveLength(1);
    await unshareResource(created[0].id);
    expect(await db.shares.get(created[0].id)).toBeUndefined();
  });
});

describe('designation lifecycle', () => {
  it('trainer inserts a pending row; status round-trips through Dexie', async () => {
    await putWithSync('trainerTrainees', {
      trainerId: TRAINER, traineeId: TRAINEE,
      status: 'pending', designatedAt: 1,
    }, TRAINER);

    const row = await db.trainerTrainees.get([TRAINER, TRAINEE]);
    expect(row?.status).toBe('pending');

    // Simulate trainee acceptance by updating Dexie directly (server RLS
    // lets the trainee update status; we exercise the Dexie shape only).
    await db.trainerTrainees
      .where('[trainerId+traineeId]')
      .equals([TRAINER, TRAINEE])
      .modify({ status: 'accepted', respondedAt: 2, updatedAt: 3 });

    const updated = await db.trainerTrainees.get([TRAINER, TRAINEE]);
    expect(updated?.status).toBe('accepted');
    expect(updated?.respondedAt).toBe(2);
  });
});
