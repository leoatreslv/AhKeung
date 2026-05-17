import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync, deleteWithSync, favoriteRowId, parseFavoriteRowId } from './putWithSync';

const UID = 'u-test';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('putWithSync', () => {
  it('inserts a brand-new row and queues op=insert with serverVersion=null', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: ['chest'],
      exercises: [], createdAt: 1,
    }, UID);

    const row = await db.plans.get('p1');
    expect(row?.userId).toBe(UID);
    expect(row?.serverVersion).toBeNull();
    expect(row?.updatedAt).toBeGreaterThan(0);

    const q = await db.syncQueue.toArray();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      table: 'plans', rowId: 'p1', op: 'insert', expectedServerVersion: null,
    });
  });

  it('subsequent put on the same row queues op=update with current serverVersion', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);
    // Simulate push success that filled serverVersion.
    await db.plans.update('p1', { serverVersion: 'srv-v1' });

    await putWithSync('plans', {
      id: 'p1', name: 'B', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);

    const q = await db.syncQueue.toArray();
    const second = q[q.length - 1];
    expect(second.op).toBe('update');
    expect(second.expectedServerVersion).toBe('srv-v1');
  });

  it('deleteWithSync removes local row and queues op=delete', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);
    await db.plans.update('p1', { serverVersion: 'srv-v1' });

    await deleteWithSync('plans', 'p1');

    expect(await db.plans.get('p1')).toBeUndefined();
    const q = await db.syncQueue.toArray();
    expect(q.find((e) => e.op === 'delete')).toMatchObject({
      table: 'plans', rowId: 'p1', expectedServerVersion: 'srv-v1',
    });
  });

  it('writes to favorites use the composite rowId encoding', async () => {
    await putWithSync('favorites', { exerciseId: 'Pullups', addedAt: 1 }, UID);
    const q = await db.syncQueue.toArray();
    expect(q[0].rowId).toBe(`${UID}:Pullups`);
    expect(parseFavoriteRowId(q[0].rowId)).toEqual({ userId: UID, exerciseId: 'Pullups' });
  });

  it('favoriteRowId round-trips through parseFavoriteRowId', () => {
    expect(parseFavoriteRowId(favoriteRowId('u', 'ex'))).toEqual({ userId: 'u', exerciseId: 'ex' });
  });
});
