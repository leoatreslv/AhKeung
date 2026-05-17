import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { putWithSync } from './putWithSync';
import { startSync, stopSync, flushNow } from './index';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('sync orchestrator', () => {
  it('flushNow runs push and pull in sequence', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await flushNow();

    expect(fake.rowOf('plans', 'p1')).toBeDefined();
  });

  it('startSync wires online/visibility listeners; stopSync removes them', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    startSync();
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    stopSync();
    expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
