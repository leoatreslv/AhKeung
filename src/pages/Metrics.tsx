import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { db } from '../db';
import { todayISO, formatDate } from '../utils';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { bmiSeries, filterByPeriod, firstLastDelta, type Period } from '../metricsTrend';

export function Metrics() {
  const { t, locale } = useI18n();
  const userId = useCurrentUserId();
  const metrics = useLiveQuery(() => db.metrics.orderBy('date').toArray(), []);

  const [date, setDate] = useState(todayISO());
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [notes, setNotes] = useState('');
  const [period, setPeriod] = useState<Period>('90d');

  // Stabilise the empty-array fallback so the per-series useMemos below
  // don't see a new array reference on every render (eslint:
  // react-hooks/exhaustive-deps).
  const allMetrics = useMemo(() => metrics ?? [], [metrics]);

  // Tile: latest overall weight + latest overall height + BMI from
  // those. This answers "what is my BMI right now"; the chart's
  // BMI line answers "how has my BMI changed over time" using
  // as-of-entry height. The two can disagree at the last point if
  // the user logged a height-only entry after the last weigh-in —
  // that's expected, see metricsTrend.ts:bmiSeries.
  const latestHeight = allMetrics.slice().reverse().find((m) => m.heightCm != null)?.heightCm;
  const latestWeight = allMetrics.slice().reverse().find((m) => m.weightKg != null)?.weightKg;
  const bmi = latestWeight && latestHeight
    ? (latestWeight / Math.pow(latestHeight / 100, 2)).toFixed(1)
    : null;

  // Raw series for each chart. Filter out nulls explicitly (a logged
  // 0 is preserved; only missing values are dropped).
  const weightPoints = useMemo(() =>
    allMetrics
      .filter((m) => m.weightKg != null)
      .map((m) => ({ date: m.date, value: m.weightKg as number })),
  [allMetrics]);
  const bodyFatPoints = useMemo(() =>
    allMetrics
      .filter((m) => m.bodyFatPct != null)
      .map((m) => ({ date: m.date, value: m.bodyFatPct as number })),
  [allMetrics]);
  const bmiPoints = useMemo(() =>
    bmiSeries(allMetrics).map((p) => ({ date: p.date, value: p.bmi })),
  [allMetrics]);

  const save = async () => {
    if (!weight && !height && !bodyFat && !notes.trim()) { alert(t.metrics.enterValue); return; }
    if (!userId) return;
    await putWithSync('metrics', {
      id: crypto.randomUUID(),
      date,
      weightKg: weight ? Number(weight) : undefined,
      heightCm: height ? Number(height) : undefined,
      bodyFatPct: bodyFat ? Number(bodyFat) : undefined,
      notes: notes.trim() || undefined,
    }, userId);
    setWeight(''); setBodyFat(''); setNotes('');
  };

  const remove = async (id: string) => {
    if (confirm(t.metrics.deleteConfirm)) {
      await deleteWithSync('metrics', id);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <section className="bg-slate-800 rounded-xl border border-slate-700 p-3">
        <h3 className="font-semibold mb-2">{t.metrics.logEntry}</h3>
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2">
            <span className="text-xs text-slate-400">{t.common.date}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
          <label>
            <span className="text-xs text-slate-400">{t.metrics.weightKg}</span>
            <input
              type="number"
              step={0.1}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
          <label>
            <span className="text-xs text-slate-400">{t.metrics.heightCm}</span>
            <input
              type="number"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              placeholder={latestHeight ? String(latestHeight) : ''}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
          <label>
            <span className="text-xs text-slate-400">{t.metrics.bodyFatPct}</span>
            <input
              type="number"
              step={0.1}
              value={bodyFat}
              onChange={(e) => setBodyFat(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
          <label className="col-span-2">
            <span className="text-xs text-slate-400">{t.common.notes}</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
        </div>
        <button onClick={save} className="w-full mt-3 bg-keung-600 hover:bg-keung-700 text-white py-2 rounded-lg font-semibold">
          {t.common.save}
        </button>
      </section>

      {bmi && (
        <section className="bg-slate-800 rounded-xl border border-slate-700 p-3 flex justify-around text-center">
          <div>
            <div className="text-xs text-slate-400">{t.home.weight}</div>
            <div className="font-bold text-lg">{latestWeight} kg</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">{t.home.height}</div>
            <div className="font-bold text-lg">{latestHeight} cm</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">{t.metrics.bmi}</div>
            <div className="font-bold text-lg">{bmi}</div>
          </div>
        </section>
      )}

      {(weightPoints.length > 0 || bodyFatPoints.length > 0 || bmiPoints.length > 0) && (
        <PeriodPicker period={period} onChange={setPeriod} />
      )}

      <TrendSection
        title={t.metrics.weightTrend}
        points={weightPoints}
        period={period}
        locale={locale}
        unit="kg"
        decimals={1}
      />
      <TrendSection
        title={t.metrics.bodyFatTrend}
        points={bodyFatPoints}
        period={period}
        locale={locale}
        unit="%"
        decimals={1}
      />
      <TrendSection
        title={t.metrics.bmiTrend}
        points={bmiPoints}
        period={period}
        locale={locale}
        unit=""
        decimals={1}
      />

      <section>
        <h3 className="font-semibold mb-2 text-sm text-slate-400 uppercase tracking-wide">{t.metrics.history}</h3>
        {metrics && metrics.length > 0 ? (
          <ul className="space-y-1">
            {metrics.slice().reverse().map((m) => (
              <li key={m.id} className="bg-slate-800 rounded-lg border border-slate-700 p-2 flex items-center gap-3 text-sm">
                <div className="text-xs text-slate-400 w-24">{formatDate(m.date, locale)}</div>
                <div className="flex-1 flex gap-3">
                  {m.weightKg != null && <span>{m.weightKg}kg</span>}
                  {m.heightCm != null && <span>{m.heightCm}cm</span>}
                  {m.bodyFatPct != null && <span>{m.bodyFatPct}%</span>}
                  {m.notes && <span className="text-slate-400 truncate">{m.notes}</span>}
                </div>
                <button onClick={() => remove(m.id)} className="text-slate-500 hover:text-rose-400 text-xs">✕</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-500 text-sm">{t.metrics.noEntries}</p>
        )}
      </section>
    </div>
  );
}

function PeriodPicker({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const { t } = useI18n();
  const opts: { value: Period; label: string }[] = [
    { value: '30d', label: t.metrics.period30 },
    { value: '90d', label: t.metrics.period90 },
    { value: 'all', label: t.metrics.periodAll },
  ];
  return (
    <div role="tablist" className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
      {opts.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={period === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 text-xs py-1.5 rounded ${
            period === opt.value
              ? 'bg-keung-600 text-white font-semibold'
              : 'text-slate-300'
          }`}
        >{opt.label}</button>
      ))}
    </div>
  );
}

function TrendSection({
  title, points, period, locale, unit, decimals,
}: {
  title: string;
  points: { date: string; value: number }[];
  period: Period;
  locale: string;
  unit: string;
  decimals: number;
}) {
  const { t } = useI18n();
  // Filter the entire series (not just the chart) so the delta
  // caption uses the same window the chart is showing.
  const filtered = useMemo(() => filterByPeriod(points, period), [points, period]);
  const delta = useMemo(() => firstLastDelta(filtered), [filtered]);

  // Per-locale short date for both X-axis ticks AND the tooltip
  // label. Memoized so React doesn't reinstantiate Intl on every
  // render or on form keystrokes.
  const tickFormatter = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return (iso: string) => fmt.format(new Date(iso));
  }, [locale]);
  const tooltipLabelFormatter = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
    // recharts types `label` as ReactNode (could be undefined when the
    // hovered point has no `name`); coerce to a string before parsing.
    return (label: unknown) =>
      typeof label === 'string' ? fmt.format(new Date(label)) : String(label ?? '');
  }, [locale]);

  // Hide the whole section when the source has zero points —
  // there's nothing useful to put on screen. If the source has
  // data but the period filter empties it, render the section
  // header + a small "No data in this period" so toggling pills
  // doesn't make sections appear/disappear visibly.
  if (points.length === 0) return null;

  return (
    <section
      className="bg-slate-800 rounded-xl border border-slate-700 p-3"
      role="img"
      aria-label={title}
    >
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="font-semibold text-sm">{title}</h3>
        {delta && (
          <span className={`text-xs ${
            delta.delta < 0 ? 'text-keung-400'
              : delta.delta > 0 ? 'text-amber-400'
              : 'text-slate-400'
          }`}>
            {t.metrics.deltaCaption(
              `${delta.delta >= 0 ? '+' : ''}${delta.delta.toFixed(decimals)}${unit ? ' ' + unit : ''}`,
              delta.days,
              `${delta.perWeek >= 0 ? '+' : ''}${delta.perWeek.toFixed(decimals)}${unit ? ' ' + unit : ''}`,
            )}
          </span>
        )}
      </div>
      {filtered.length >= 2 ? (
        <div className="h-48">
          <ResponsiveContainer>
            <LineChart data={filtered} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis
                dataKey="date"
                stroke="#94a3b8"
                tick={{ fontSize: 10 }}
                tickFormatter={tickFormatter}
              />
              <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}
                labelFormatter={tooltipLabelFormatter}
              />
              <Line type="monotone" dataKey="value" stroke="#ea580c" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-slate-500 text-xs py-4 text-center">{t.metrics.noChartData}</p>
      )}
    </section>
  );
}
