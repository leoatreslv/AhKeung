import { describe, it, expect } from 'vitest';
import { filterByPeriod, bmiSeries, firstLastDelta } from './metricsTrend';
import type { BodyMetric } from './db';

function metric(date: string, partial: Partial<BodyMetric> = {}): BodyMetric {
  return {
    id: `m-${date}`,
    userId: 'u-1',
    date,
    updatedAt: 0,
    ...partial,
  };
}

describe('filterByPeriod', () => {
  it('returns input unchanged when period is "all"', () => {
    const rows = [{ date: '2020-01-01' }, { date: '2026-05-23' }];
    expect(filterByPeriod(rows, 'all')).toBe(rows);
  });

  it('returns empty when input is empty', () => {
    expect(filterByPeriod([], '90d')).toEqual([]);
  });

  it('anchors cutoff on max(date), not Date.now()', () => {
    // Even though both rows are from years ago, the 90d window
    // around the latest one keeps both if they're within 90d of
    // each other.
    const rows = [
      { date: '2020-01-01' },
      { date: '2020-03-15' },  // 74 days after the first
    ];
    expect(filterByPeriod(rows, '90d')).toEqual(rows);
  });

  it('drops rows older than (max - 90 days) when filtering by 90d', () => {
    const rows = [
      { date: '2020-01-01' },  // 143 days before max — out
      { date: '2020-04-15' },  // 38 days before max — in
      { date: '2020-05-23' },  // max — in
    ];
    expect(filterByPeriod(rows, '90d')).toEqual([
      { date: '2020-04-15' },
      { date: '2020-05-23' },
    ]);
  });

  it('drops rows older than (max - 30 days) when filtering by 30d', () => {
    const rows = [
      { date: '2020-04-01' },  // 52 days before max — out
      { date: '2020-05-01' },  // 22 days before max — in
      { date: '2020-05-23' },  // max — in
    ];
    expect(filterByPeriod(rows, '30d')).toEqual([
      { date: '2020-05-01' },
      { date: '2020-05-23' },
    ]);
  });
});

describe('bmiSeries', () => {
  it('returns empty when no metrics', () => {
    expect(bmiSeries([])).toEqual([]);
  });

  it('skips entries before the first height log', () => {
    const rows = [
      metric('2020-01-01', { weightKg: 70 }),  // no height yet — skip
      metric('2020-02-01', { weightKg: 71 }),  // still no height — skip
      metric('2020-03-01', { weightKg: 72, heightCm: 175 }),  // first height — keep
    ];
    const out = bmiSeries(rows);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2020-03-01');
    expect(out[0].bmi).toBeCloseTo(72 / 1.75 / 1.75, 2);
  });

  it('carries the latest known height forward across subsequent weight entries', () => {
    const rows = [
      metric('2020-01-01', { weightKg: 70, heightCm: 170 }),
      metric('2020-02-01', { weightKg: 71 }),                  // uses 170
      metric('2020-03-01', { weightKg: 72, heightCm: 175 }),   // uses new 175
      metric('2020-04-01', { weightKg: 73 }),                  // uses 175
    ];
    const out = bmiSeries(rows);
    expect(out).toHaveLength(4);
    expect(out[0].bmi).toBeCloseTo(70 / 1.7 / 1.7, 2);
    expect(out[1].bmi).toBeCloseTo(71 / 1.7 / 1.7, 2);  // carried forward 170
    expect(out[2].bmi).toBeCloseTo(72 / 1.75 / 1.75, 2);
    expect(out[3].bmi).toBeCloseTo(73 / 1.75 / 1.75, 2);  // carried forward 175
  });

  it('skips entries with no weight even when height is known', () => {
    const rows = [
      metric('2020-01-01', { weightKg: 70, heightCm: 170 }),
      metric('2020-02-01', { heightCm: 171 }),  // height-only — no weight, no BMI point
      metric('2020-03-01', { weightKg: 72 }),   // BMI using 171
    ];
    const out = bmiSeries(rows);
    expect(out).toHaveLength(2);
    expect(out[1].bmi).toBeCloseTo(72 / 1.71 / 1.71, 2);
  });

  it('ignores zero or negative height values', () => {
    const rows = [
      metric('2020-01-01', { weightKg: 70, heightCm: 0 }),
      metric('2020-02-01', { weightKg: 71, heightCm: 170 }),
    ];
    const out = bmiSeries(rows);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe('2020-02-01');
  });
});

describe('firstLastDelta', () => {
  it('returns null on <2 points', () => {
    expect(firstLastDelta([])).toBeNull();
    expect(firstLastDelta([{ date: '2020-01-01', value: 70 }])).toBeNull();
  });

  it('returns null when span is less than 14 days', () => {
    expect(firstLastDelta([
      { date: '2020-01-01', value: 70 },
      { date: '2020-01-13', value: 69 },  // 12 days span — too short
    ])).toBeNull();
  });

  it('computes delta and per-week rate over a valid span', () => {
    const result = firstLastDelta([
      { date: '2020-01-01', value: 70 },
      { date: '2020-04-01', value: 68.8 },  // 91 days, -1.2 kg
    ]);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeCloseTo(-1.2, 5);
    expect(result!.days).toBe(91);
    // -1.2 / 91 * 7 ≈ -0.0923
    expect(result!.perWeek).toBeCloseTo(-1.2 / 91 * 7, 5);
  });

  it('uses first and last by position, not by date sort order', () => {
    // The helper assumes the caller has sorted ascending. If
    // not, it still computes — caller's responsibility.
    const result = firstLastDelta([
      { date: '2020-01-01', value: 70 },
      { date: '2020-02-15', value: 71 },
      { date: '2020-04-01', value: 72 },
    ]);
    expect(result!.delta).toBeCloseTo(2, 5);  // 72 - 70
    expect(result!.days).toBe(91);
  });
});
