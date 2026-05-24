import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { todayISO, weekStartISO, formatDate, formatDuration, withTimeout } from '../utils';

describe('utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('todayISO', () => {
    it('returns YYYY-MM-DD for the current date', () => {
      vi.setSystemTime(new Date('2025-03-15T10:30:00Z'));
      expect(todayISO()).toBe('2025-03-15');
    });
  });

  describe('weekStartISO', () => {
    it('returns the Monday of the same week for a Wednesday', () => {
      // 2025-03-12 is a Wednesday → Monday is 2025-03-10
      expect(weekStartISO(new Date('2025-03-12T12:00:00Z'))).toBe('2025-03-10');
    });

    it('returns the same date when called on a Monday', () => {
      // 2025-03-10 is a Monday
      expect(weekStartISO(new Date('2025-03-10T12:00:00Z'))).toBe('2025-03-10');
    });

    it('rolls back to the previous Monday on a Sunday', () => {
      // 2025-03-16 is a Sunday → previous Monday is 2025-03-10
      expect(weekStartISO(new Date('2025-03-16T12:00:00Z'))).toBe('2025-03-10');
    });
  });

  describe('formatDuration', () => {
    it('formats minutes and seconds for short durations', () => {
      expect(formatDuration(0)).toBe('0m 0s');
      expect(formatDuration(45_000)).toBe('0m 45s');
      expect(formatDuration(5 * 60_000 + 30_000)).toBe('5m 30s');
    });

    it('switches to hours+minutes once an hour has passed', () => {
      expect(formatDuration(60 * 60_000)).toBe('1h 0m');
      expect(formatDuration(2 * 60 * 60_000 + 15 * 60_000)).toBe('2h 15m');
    });
  });

  describe('formatDate', () => {
    it('returns a non-empty string with weekday/month/day parts', () => {
      const out = formatDate('2025-03-15', 'en-US');
      expect(out).toMatch(/Mar/);
      expect(out).toMatch(/15/);
    });
  });

  describe('withTimeout', () => {
    it('resolves with the inner promise when it completes first', async () => {
      vi.useRealTimers();  // tiny delays via real timers
      const out = await withTimeout(Promise.resolve(42), 50, 'fast');
      expect(out).toBe(42);
    });

    it('rejects with a labeled error when the promise outlasts the timeout', async () => {
      // Real timers with a tiny delay — fake timers wrap Promise.race
      // in a way that leaves the inner setTimeout-driven rejection
      // tracked as "unhandled" by vitest even though the outer race
      // captures it.
      vi.useRealTimers();
      const hanging = new Promise(() => {});
      await expect(
        withTimeout(hanging, 10, 'op'),
      ).rejects.toThrow(/op timeout after 10ms/);
    });

    it('clears the timer when the promise resolves first (no leak)', async () => {
      vi.useRealTimers();
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      await withTimeout(Promise.resolve('ok'), 1000, 'op');
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it('propagates the inner rejection unchanged', async () => {
      vi.useRealTimers();
      await expect(
        withTimeout(Promise.reject(new Error('inner')), 100, 'op'),
      ).rejects.toThrow('inner');
    });
  });
});
