import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor } from '../db';
import { weekStartISO, formatDate, formatDuration } from '../utils';
import { useI18n } from '../i18n';
import { useExercises } from '../useExercises';
import { displayName } from '../exerciseDisplay';
import { DesignationBanner } from '../components/DesignationBanner';

export function Home() {
  const { t, locale } = useI18n();
  const catalog = useExercises();
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const wk = weekStartISO();
  const currentPlan = useLiveQuery(
    () => db.plans.where('weekStart').equals(wk).first(),
    [wk],
  );
  const recentSessions = useLiveQuery(
    // v4 schema dropped the startedAt index; use the indexed `date` field,
    // then resolve same-day ordering by startedAt in memory.
    async () => {
      const rows = await db.sessions.orderBy('date').reverse().limit(20).toArray();
      return rows
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, 5);
    },
    [],
  );
  const latestMetric = useLiveQuery(
    () => db.metrics.orderBy('date').reverse().first(),
    [],
  );

  return (
    <div className="p-4 space-y-4">
      <DesignationBanner />
      <AssignedPlansCard />
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
              const sessionId = s.id;
              const totalSetsDone = s.exercises.reduce((sum, ex) => sum + ex.sets.filter((x) => x.done).length, 0);
              const isOpen = openSessionId === sessionId;
              const duration = s.endedAt && s.startedAt ? s.endedAt - s.startedAt : null;
              return (
                <li key={sessionId} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                  <button
                    onClick={() => setOpenSessionId(isOpen ? null : sessionId)}
                    className="w-full text-left p-3 flex items-center gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold">{formatDate(s.date, locale)}</div>
                      <div className="text-xs text-slate-400">{t.home.sessionSummary(s.exercises.length, totalSetsDone)}</div>
                    </div>
                    {duration !== null && (
                      <div className="text-xs text-slate-400 tabular-nums shrink-0">{formatDuration(duration)}</div>
                    )}
                    <span className="text-slate-500 text-xs">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 border-t border-slate-700 pt-2 space-y-2">
                      {s.exercises.length === 0 ? (
                        <p className="text-xs text-slate-500">{t.workout.noExercises}</p>
                      ) : (
                        s.exercises.map((ex, idx) => {
                          const meta = catalog?.find((c) => c.id === ex.exerciseId);
                          const name = meta ? displayName(meta, locale) : ex.exerciseId;
                          const doneSets = ex.sets.filter((x) => x.done);
                          return (
                            <div key={idx} className="text-sm">
                              <div className="flex items-baseline gap-2">
                                <span className="font-medium truncate flex-1">{name}</span>
                                <span className="text-xs text-slate-400 shrink-0 tabular-nums">
                                  {doneSets.length}/{ex.sets.length}
                                </span>
                              </div>
                              {doneSets.length > 0 && (
                                <div className="text-xs text-slate-400 mt-0.5 tabular-nums">
                                  {doneSets
                                    .map((set) => set.weight > 0
                                      ? `${set.reps}×${set.weight}${t.workout.weightUnit}`
                                      : `${set.reps}`)
                                    .join(' · ')}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                      {s.notes && (
                        <div className="text-xs text-slate-400 italic pt-1 border-t border-slate-700/50">
                          {s.notes}
                        </div>
                      )}
                    </div>
                  )}
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

// Plans assigned to the current user by a trainer. Filter to the
// "current" assignment per trainer (superseded_by IS NULL) so the
// trainee doesn't drown in re-shared history.
function AssignedPlansCard() {
  const { t, locale } = useI18n();
  const assigned = useLiveQuery(
    async () => {
      const rows = await db.plans
        .filter((p) => !!p.assignedBy && !p.supersededBy && !p.deletedAt)
        .toArray();
      return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    },
    [],
  );
  if (!assigned || assigned.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.home.assignedByTrainer}</h2>
      <ul className="space-y-2">
        {assigned.map((p) => (
          <li key={p.id} className="bg-slate-800 rounded-xl border border-slate-700 p-3">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-bold text-sm flex-1">{p.name}</h3>
              <span className="text-xs text-slate-400">{formatDate(p.weekStart, locale)}</span>
            </div>
            <div className="flex flex-wrap gap-1 mb-2">
              {p.focus.map((m) => (
                <span key={m} className={`${muscleGroupColor[m]} text-white text-[10px] px-1.5 py-0.5 rounded`}>
                  {t.muscleGroup[m]}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <Link
                to={`/workout/${p.id}`}
                className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-1.5 rounded text-center text-sm font-semibold"
              >{t.home.startWorkout}</Link>
              <Link
                to={`/plans/${p.id}`}
                className="px-3 bg-slate-700 hover:bg-slate-600 text-white py-1.5 rounded text-sm"
              >{t.common.edit}</Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
