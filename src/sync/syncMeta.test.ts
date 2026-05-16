import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { getCursor, setCursor } from './syncMeta';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('syncMeta cursor', () => {
  it('returns empty when nothing stored', async () => {
    expect(await getCursor('plans')).toEqual({ lastPulledAt: null, lastSeenIds: [] });
  });

  it('persists and retrieves a cursor with lastSeenIds', async () => {
    await setCursor('plans', { lastPulledAt: '2025-03-10T00:00:00.000Z', lastSeenIds: ['p1', 'p2'] });
    expect(await getCursor('plans')).toEqual({
      lastPulledAt: '2025-03-10T00:00:00.000Z', lastSeenIds: ['p1', 'p2'],
    });
  });

  it('keeps per-table cursors independent', async () => {
    await setCursor('plans',    { lastPulledAt: 'A', lastSeenIds: ['pa'] });
    await setCursor('sessions', { lastPulledAt: 'B', lastSeenIds: ['pb'] });
    expect((await getCursor('plans')).lastPulledAt).toBe('A');
    expect((await getCursor('sessions')).lastPulledAt).toBe('B');
  });
});
