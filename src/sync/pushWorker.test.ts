import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync, deleteWithSync } from './putWithSync';
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

describe('pushWorker — delete', () => {
  it('translates op=delete to setting deleted_at on the server', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();

    await deleteWithSync('plans', 'p1');
    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').deleted_at).not.toBeNull();
    expect(await db.syncQueue.count()).toBe(0);
  });
});

describe('pushWorker — dead letter on 4xx', () => {
  it('moves the queue entry to syncDeadLetter after a non-retryable error', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    // Inject a server-side failure: monkey-patch fake to reject inserts with code 422.
    const fake = getActiveFake();
    const orig = fake.client.from.bind(fake.client);
    fake.client.from = ((name: string) => {
      const b = orig(name);
      const origInsert = b.insert;
      b.insert = (row: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q = origInsert(row as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q.then = (_resolve: any, reject: any) => {
          void _resolve;
          return Promise.reject(Object.assign(new Error('422: validation'), { status: 422 }))
            .then(undefined, reject);
        };
        return q;
      };
      return b;
    }) as typeof fake.client.from;

    await putWithSync('plans', {
      id: 'p1', name: 'X', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    // Run push 3 times (each fails, attempts increments).
    for (let i = 0; i < 3; i++) {
      try { await runPushOnce(); } catch { /* swallow per-attempt errors */ }
    }
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.syncDeadLetter.count()).toBe(1);
  });
});

describe('pushWorker — network failure retries silently', () => {
  it('does not move to dead letter on transient network error', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await putWithSync('plans', {
      id: 'p1', name: 'X', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    fake.setNetworkUp(false);
    await runPushOnce().catch(() => {});  // throws once

    expect(await db.syncDeadLetter.count()).toBe(0);
    expect((await db.syncQueue.toArray())[0].attempts).toBe(1);

    fake.setNetworkUp(true);
    await runPushOnce();
    expect(await db.syncQueue.count()).toBe(0);
  });
});
