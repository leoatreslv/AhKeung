// Pure helpers for the Metrics screen's per-period charts and
// delta captions. No React, no I/O — unit-tested in isolation.

import type { BodyMetric } from './db';

export type Period = 'all' | '90d' | '30d';

/** Filter rows to a time window anchored on the MOST RECENT entry's
 *  date — NOT on `Date.now()`. If a user hasn't logged in 6 months,
 *  anchoring on Date.now would silently empty the chart even though
 *  there's a perfectly readable history a year ago; anchoring on
 *  max(date) preserves the chart's usefulness for sporadic loggers.
 *  `'all'` returns the input unchanged. */
export function filterByPeriod<T extends { date: string }>(
  rows: T[], period: Period,
): T[] {
  if (period === 'all' || rows.length === 0) return rows;
  const days = period === '90d' ? 90 : 30;
  let anchorMs = 0;
  for (const r of rows) {
    const t = Date.parse(r.date);
    if (t > anchorMs) anchorMs = t;
  }
  const cutoffMs = anchorMs - days * 24 * 3600 * 1000;
  return rows.filter((r) => Date.parse(r.date) >= cutoffMs);
}

/** BMI per weight-entry. Carries forward the most recent height
 *  logged at or before the entry's date, so users who log height
 *  only occasionally still get a BMI on every weigh-in. Entries
 *  before the first ever height-log are skipped (we have nothing
 *  to compute against). Input must be sorted by date ascending —
 *  Dexie's `orderBy('date')` does this. */
export function bmiSeries(
  metrics: BodyMetric[],
): { date: string; bmi: number }[] {
  let currentHeight: number | undefined;
  const out: { date: string; bmi: number }[] = [];
  for (const m of metrics) {
    if (m.heightCm != null && m.heightCm > 0) currentHeight = m.heightCm;
    if (m.weightKg != null && currentHeight != null) {
      const h = currentHeight / 100;
      out.push({ date: m.date, bmi: m.weightKg / (h * h) });
    }
  }
  return out;
}

/** First-vs-last delta with a per-week rate. Returns null when
 *  - fewer than 2 points (no delta to compute), or
 *  - span is less than 14 days (a per-week rate over a single
 *    calendar week is just noise).
 *  Caller is expected to render the result, including the sign,
 *  in the user's locale. */
export function firstLastDelta(
  rows: { date: string; value: number }[],
): { delta: number; days: number; perWeek: number } | null {
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const days = Math.round(
    (Date.parse(last.date) - Date.parse(first.date)) / (24 * 3600 * 1000),
  );
  if (days < 14) return null;
  const delta = last.value - first.value;
  const perWeek = (delta / days) * 7;
  return { delta, days, perWeek };
}
