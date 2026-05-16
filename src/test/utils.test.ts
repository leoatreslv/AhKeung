import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { todayISO, weekStartISO, formatDate, formatDuration } from '../utils';

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
});
