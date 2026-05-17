import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { db } from '../db';
import { todayISO, formatDate } from '../utils';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';

export function Metrics() {
  const { t, locale } = useI18n();
  const userId = useCurrentUserId();
  const metrics = useLiveQuery(() => db.metrics.orderBy('date').toArray(), []);

  const [date, setDate] = useState(todayISO());
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [notes, setNotes] = useState('');

  const latestHeight = metrics?.slice().reverse().find((m) => m.heightCm)?.heightCm;

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

  const chartData = (metrics ?? [])
    .filter((m) => m.weightKg)
    .map((m) => ({ date: m.date, weight: m.weightKg }));

  const latestWeight = metrics?.slice().reverse().find((m) => m.weightKg)?.weightKg;
  const bmi = latestWeight && latestHeight
    ? (latestWeight / Math.pow(latestHeight / 100, 2)).toFixed(1)
    : null;

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

      {chartData.length >= 2 && (
        <section className="bg-slate-800 rounded-xl border border-slate-700 p-3">
          <h3 className="font-semibold mb-2 text-sm">{t.metrics.weightTrend}</h3>
          <div className="h-48">
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 10 }} />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                <Line type="monotone" dataKey="weight" stroke="#ea580c" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section>
        <h3 className="font-semibold mb-2 text-sm text-slate-400 uppercase tracking-wide">{t.metrics.history}</h3>
        {metrics && metrics.length > 0 ? (
          <ul className="space-y-1">
            {metrics.slice().reverse().map((m) => (
              <li key={m.id} className="bg-slate-800 rounded-lg border border-slate-700 p-2 flex items-center gap-3 text-sm">
                <div className="text-xs text-slate-400 w-24">{formatDate(m.date, locale)}</div>
                <div className="flex-1 flex gap-3">
                  {m.weightKg && <span>{m.weightKg}kg</span>}
                  {m.heightCm && <span>{m.heightCm}cm</span>}
                  {m.bodyFatPct && <span>{m.bodyFatPct}%</span>}
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
