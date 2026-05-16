import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor } from '../db';
import { formatDate } from '../utils';
import { useI18n } from '../i18n';

export function Plans() {
  const { t, locale } = useI18n();
  const plans = useLiveQuery(
    () => db.plans.orderBy('createdAt').reverse().toArray(),
    [],
  );

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{t.plans.title}</h2>
        <Link to="/plans/new" className="bg-keung-600 hover:bg-keung-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold">
          {t.plans.newButton}
        </Link>
      </div>
      {plans && plans.length > 0 ? (
        <ul className="space-y-2">
          {plans.map((p) => (
            <li key={p.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <Link to={`/plans/${p.id}`} className="block p-3">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold">{p.name}</h3>
                  <span className="text-xs text-slate-400">{t.plans.weekOf} {formatDate(p.weekStart, locale)}</span>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                  {p.focus.map((m) => (
                    <span key={m} className={`${muscleGroupColor[m]} text-white text-[10px] px-1.5 py-0.5 rounded`}>
                      {t.muscleGroup[m]}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-slate-400">{t.plans.exerciseCount(p.exercises.length)}</p>
              </Link>
              <div className="flex border-t border-slate-700">
                <Link
                  to={`/workout/${p.id}`}
                  className="flex-1 py-2 text-center text-sm text-keung-500 hover:bg-slate-700"
                >
                  {t.plans.start}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-center py-12">
          <div className="text-5xl mb-2">📋</div>
          <p className="text-slate-400 mb-4">{t.plans.noPlans}</p>
          <Link to="/plans/new" className="inline-block bg-keung-600 hover:bg-keung-700 text-white px-4 py-2 rounded-lg font-semibold">
            {t.plans.createFirst}
          </Link>
        </div>
      )}
    </div>
  );
}
