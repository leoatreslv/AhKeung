import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor } from '../db';
import { weekStartISO, formatDate } from '../utils';
import { useI18n } from '../i18n';

export function Home() {
  const { t, locale } = useI18n();
  const wk = weekStartISO();
  const currentPlan = useLiveQuery(
    () => db.plans.where('weekStart').equals(wk).first(),
    [wk],
  );
  const recentSessions = useLiveQuery(
    () => db.sessions.orderBy('startedAt').reverse().limit(5).toArray(),
    [],
  );
  const latestMetric = useLiveQuery(
    () => db.metrics.orderBy('date').reverse().first(),
    [],
  );

  return (
    <div className="p-4 space-y-4">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.home.thisWeek}</h2>
        {currentPlan ? (
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-bold text-lg">{currentPlan.name}</h3>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {currentPlan.focus.map((m) => (
                <span key={m} className={`${muscleGroupColor[m]} text-white text-xs px-2 py-0.5 rounded-full`}>
                  {t.muscleGroup[m]}
                </span>
              ))}
            </div>
            <p className="text-sm text-slate-400 mb-3">
              {t.home.exercisesPlanned(currentPlan.exercises.length)}
            </p>
            <div className="flex gap-2">
              <Link
                to={`/workout/${currentPlan.id}`}
                className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-2 rounded-lg text-center font-semibold"
              >
                {t.home.startWorkout}
              </Link>
              <Link
                to={`/plans/${currentPlan.id}`}
                className="px-4 bg-slate-700 hover:bg-slate-600 text-white py-2 rounded-lg text-center"
              >
                {t.common.edit}
              </Link>
            </div>
          </div>
        ) : (
          <div className="bg-slate-800 rounded-xl p-4 border border-dashed border-slate-700 text-center">
            <p className="text-slate-400 mb-3">{t.home.noPlanThisWeek}</p>
            <Link
              to="/plans/new"
              className="inline-block bg-keung-600 hover:bg-keung-700 text-white px-4 py-2 rounded-lg font-semibold"
            >
              {t.home.createPlan}
            </Link>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.home.quickActions}</h2>
        <div className="grid grid-cols-2 gap-2">
          <Link to="/workout" className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl p-3 text-center">
            <div className="text-2xl">🔥</div>
            <div className="text-sm mt-1">{t.home.freeWorkout}</div>
          </Link>
          <Link to="/metrics" className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl p-3 text-center">
            <div className="text-2xl">⚖️</div>
            <div className="text-sm mt-1">{t.home.logWeight}</div>
          </Link>
        </div>
      </section>

      {latestMetric && (
        <section>
          <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.home.latestMetric}</h2>
          <div className="bg-slate-800 rounded-xl p-4 border border-slate-700 flex gap-4 text-sm">
            <div>
              <div className="text-xs text-slate-400">{t.common.date}</div>
              <div className="font-semibold">{formatDate(latestMetric.date, locale)}</div>
            </div>
            {latestMetric.weightKg && (
              <div>
                <div className="text-xs text-slate-400">{t.home.weight}</div>
                <div className="font-semibold">{latestMetric.weightKg} kg</div>
              </div>
            )}
            {latestMetric.heightCm && (
              <div>
                <div className="text-xs text-slate-400">{t.home.height}</div>
                <div className="font-semibold">{latestMetric.heightCm} cm</div>
              </div>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.home.recentSessions}</h2>
        {recentSessions && recentSessions.length > 0 ? (
          <ul className="space-y-2">
            {recentSessions.map((s) => {
              const totalSets = s.exercises.reduce((sum, ex) => sum + ex.sets.filter((x) => x.done).length, 0);
              return (
                <li key={s.id} className="bg-slate-800 rounded-xl p-3 border border-slate-700 flex items-center">
                  <div>
                    <div className="font-semibold">{formatDate(s.date, locale)}</div>
                    <div className="text-xs text-slate-400">{t.home.sessionSummary(s.exercises.length, totalSets)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-slate-500 text-sm">{t.home.noWorkouts}</p>
        )}
      </section>
    </div>
  );
}
