import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { flushNow } from '../sync';
import { stubAuthenticatedUser, getActiveFake } from './authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('sync roundtrip', () => {
  it('insert → push → remote mutate → pull → conflict → delete', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    // 1. Local insert
    const planId = 'plan-rt-1';
    await putWithSync('plans', {
      id: planId, name: 'A', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    let local = await db.plans.get(planId);
    expect(local?.serverVersion).toBeNull();
    expect(await db.syncQueue.count()).toBe(1);

    // 2. Push
    await flushNow();
    expect(fake.rowOf('plans', planId)).toBeDefined();
    expect(await db.syncQueue.count()).toBe(0);
    local = await db.plans.get(planId);
    expect(local?.serverVersion).toBe(fake.rowOf('plans', planId).updated_at);

    // 3. Other device mutates server
    const remoteRow = fake.rowOf('plans', planId);
    remoteRow.name = 'OTHER';
    remoteRow.updated_at = new Date(Date.now() + 1000).toISOString();

    // 4. Pull merges
    await flushNow();
    expect((await db.plans.get(planId))?.name).toBe('OTHER');

    // 5. Conflict path — local edits while we hold an older serverVersion
    const T_before_remote = (await db.plans.get(planId))!.serverVersion!;
    await putWithSync('plans', {
      id: planId, name: 'LOCAL', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    // Race: server moves forward again
    remoteRow.name = 'OTHER2';
    remoteRow.updated_at = new Date(Date.now() + 2000).toISOString();
    expect(T_before_remote).not.toBe(remoteRow.updated_at);

    // Push: first attempt conflicts, worker pulls, retries
    await flushNow();
    expect(fake.rowOf('plans', planId).name).toBe('LOCAL');
    expect(await db.syncQueue.count()).toBe(0);
    expect((await db.plans.get(planId))?.serverVersion).toBe(fake.rowOf('plans', planId).updated_at);

    // 6. Delete + push tombstone
    await deleteWithSync('plans', planId);
    await flushNow();
    expect(fake.rowOf('plans', planId).deleted_at).not.toBeNull();
    expect(await db.plans.get(planId)).toBeUndefined();
  });

  it('conflict resolution preserves server fields the client schema does not know about', async () => {
    // The plan describes v1 as "row-level LWW" — accurate for fields the local
    // schema models (whichever device pushes last wins for those fields).
    // For fields outside the client schema (e.g. spec-#2's trainer-set
    // `assigned_by`), toServerRow() never emits them, so a conditional UPDATE
    // leaves those columns untouched on the server. The local push is
    // effectively a partial-column write for the fields it knows about.
    //
    // Concrete scenario: a trainer sets `assigned_by` on the member's plan
    // while the member is offline editing `name`. The member's later push
    // wins for `name` but does NOT clobber `assigned_by`.
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    const planId = 'plan-clobber-1';
    await putWithSync('plans', {
      id: planId, name: 'A', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await flushNow();

    // Other device sets assigned_by (simulating spec-#2 trainer assignment).
    const remote = fake.rowOf('plans', planId);
    remote.assigned_by = 'trainer-uuid-xyz';
    remote.updated_at = new Date(Date.now() + 1000).toISOString();

    // Local edits 'name' without knowing about the assigned_by change.
    await putWithSync('plans', {
      id: planId, name: 'LOCAL', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await flushNow();

    // Local's name wins (LWW for modelled fields), assigned_by survives
    // (partial-column update, since toServerRow doesn't emit unknown keys).
    expect(fake.rowOf('plans', planId).name).toBe('LOCAL');
    expect(fake.rowOf('plans', planId).assigned_by).toBe('trainer-uuid-xyz');
  });
});
