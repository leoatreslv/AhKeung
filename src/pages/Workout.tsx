import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CustomExercise, type SetLog, type WorkoutSession } from '../db';
import { displayName, imageUrl } from '../exerciseDisplay';
import { useExercises } from '../useExercises';
import { todayISO, formatDuration } from '../utils';
import { useI18n } from '../i18n';
import { useFavoriteIds } from '../useFavorites';
import { ExerciseDetailsModal } from '../components/ExerciseDetailsModal';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync } from '../sync/putWithSync';
import { exerciseKind, nextSet, setsFromPlanExercise, secondsToMinutes, minutesToSeconds } from '../cardio';

export function Workout() {
  const { t, locale } = useI18n();
  const { planId } = useParams<{ planId?: string }>();
  const navigate = useNavigate();
  const catalog = useExercises();
  const favorites = useFavoriteIds();
  const plan = useLiveQuery(
    async () => (planId ? await db.plans.get(planId) : undefined),
    [planId],
  );

  type SessionDraft = Pick<WorkoutSession, 'planId' | 'date' | 'exercises' | 'notes' | 'startedAt'>;
  const [session, setSession] = useState<SessionDraft | null>(null);
  const userId = useCurrentUserId();
  const [elapsed, setElapsed] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<CustomExercise | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [date] = useState(() => todayISO());

  if (session === null && (!planId || plan) && catalog) {
    setSession({
      planId: plan?.id,
      date,
      startedAt,
      exercises:
        plan?.exercises.map((pe) => ({
          exerciseId: pe.exerciseId,
          sets: setsFromPlanExercise(pe, exerciseKind(catalog.find((c) => c.id === pe.exerciseId))),
        })) ?? [],
    });
  }

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setElapsed(Date.now() - session.startedAt), 1000);
    return () => clearInterval(timer);
  }, [session]);

  if (!session || !catalog) {
    return <div className="p-4 text-slate-400">{t.common.loading}</div>;
  }

  const findEx = (id: string) => catalog.find((e) => e.id === id);

  const updateSet = (exIdx: number, setIdx: number, patch: Partial<SetLog>) => {
    setSession((s) => {
      if (!s) return s;
      return { ...s, exercises: s.exercises.map((e, i) =>
        i === exIdx ? { ...e, sets: e.sets.map((set, j) => (j === setIdx ? { ...set, ...patch } : set)) } : e,
      )};
    });
  };

  const addSet = (exIdx: number) => {
    setSession((s) => {
      if (!s) return s;
      const ex = s.exercises[exIdx];
      const kind = exerciseKind(findEx(ex.exerciseId));
      const last = ex.sets[ex.sets.length - 1];
      return { ...s, exercises: s.exercises.map((e, i) => (i === exIdx ? { ...e, sets: [...e.sets, nextSet(last, kind)] } : e)) };
    });
  };

  const removeSet = (exIdx: number, setIdx: number) => {
    setSession((s) => {
      if (!s) return s;
      return { ...s, exercises: s.exercises.map((e, i) =>
        i === exIdx ? { ...e, sets: e.sets.filter((_, j) => j !== setIdx) } : e,
      )};
    });
  };

  const addExercise = (id: string) => {
    if (session.exercises.find((e) => e.exerciseId === id)) return;
    const kind = exerciseKind(findEx(id));
    setSession((s) => s && {
      ...s,
      exercises: [...s.exercises, { exerciseId: id, sets: [nextSet(undefined, kind)] }],
    });
    setPickerOpen(false);
  };

  const removeExercise = (exIdx: number) => {
    setSession((s) => s && { ...s, exercises: s.exercises.filter((_, i) => i !== exIdx) });
  };

  const finish = async () => {
    const done = session.exercises.some((e) => e.sets.some((s) => s.done));
    if (!done) { if (!confirm(t.workout.noSetsDoneConfirm)) return; }
    if (!userId) return;
    await putWithSync('sessions', {
      id: crypto.randomUUID(),
      planId: session.planId,
      date: session.date,
      exercises: session.exercises,
      notes: session.notes,
      startedAt: session.startedAt,
      endedAt: Date.now(),
    }, userId);
    navigate('/');
  };

  const cancel = () => {
    if (confirm(t.workout.discardConfirm)) navigate(-1);
  };

  const totalSets = session.exercises.reduce((sum, e) => sum + e.sets.length, 0);
  const doneSets = session.exercises.reduce((sum, e) => sum + e.sets.filter((s) => s.done).length, 0);

  return (
    <div className="p-4 space-y-3">
      <div className="bg-slate-800 rounded-xl p-3 border border-slate-700 flex items-center">
        <div>
          <div className="text-xs text-slate-400">{t.workout.elapsed}</div>
          <div className="text-xl font-bold tabular-nums">{formatDuration(elapsed)}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-slate-400">{t.workout.progress}</div>
          <div className="text-xl font-bold">{doneSets}/{totalSets}</div>
        </div>
      </div>

      {session.exercises.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-6">{t.workout.noExercises}</p>
      )}

      <ul className="space-y-3">
        {session.exercises.map((ex, exIdx) => {
          const meta = findEx(ex.exerciseId);
          const name = meta ? displayName(meta, locale) : ex.exerciseId;
          const img = meta ? imageUrl(meta.imagePath, meta.updatedAt) : null;
          const kind = exerciseKind(meta);
          return (
            <li key={ex.exerciseId} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="p-3 flex items-center gap-2 border-b border-slate-700">
                {img ? (
                  <img src={img} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-slate-700" />
                ) : (
                  <div className="w-10 h-10 rounded bg-slate-700" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{name}</div>
                  {meta?.equipment && <div className="text-xs text-slate-400 truncate capitalize">{meta.equipment}</div>}
                </div>
                {meta && (
                  <button
                    onClick={() => setDetailsFor(meta)}
                    aria-label={t.library.viewDetails}
                    className="text-slate-400 hover:text-keung-500 px-1"
                  >
                    ⓘ
                  </button>
                )}
                <button onClick={() => removeExercise(exIdx)} className="text-slate-500 hover:text-rose-400">✕</button>
              </div>
              <div className="px-3 py-2">
                {kind === 'cardio' ? (
                  <>
                    <div className="grid grid-cols-[2rem_1fr_1fr_1fr_2.5rem_1.5rem] gap-2 items-center text-[10px] text-slate-400 uppercase tracking-wide mb-1">
                      <span>{t.workout.set}</span>
                      <span>{t.cardio.incline}</span>
                      <span>{t.cardio.speed}</span>
                      <span>{t.cardio.time}</span>
                      <span>{t.common.done}</span>
                      <span></span>
                    </div>
                    {ex.sets.map((s, setIdx) => (
                      <div key={setIdx} className="grid grid-cols-[2rem_1fr_1fr_1fr_2.5rem_1.5rem] gap-2 items-center py-1">
                        <span className="text-sm font-bold text-slate-400">{setIdx + 1}</span>
                        <input
                          type="number"
                          step={0.5}
                          value={s.inclinePct ?? 0}
                          onChange={(e) => updateSet(exIdx, setIdx, { inclinePct: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          step={0.1}
                          value={s.speedKmh ?? 0}
                          onChange={(e) => updateSet(exIdx, setIdx, { speedKmh: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          step={0.5}
                          value={secondsToMinutes(s.durationSec)}
                          onChange={(e) => updateSet(exIdx, setIdx, { durationSec: minutesToSeconds(Number(e.target.value)) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <button
                          onClick={() => updateSet(exIdx, setIdx, { done: !s.done })}
                          className={`rounded h-8 text-sm font-bold ${s.done ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                        >
                          {s.done ? '✓' : '○'}
                        </button>
                        <button
                          onClick={() => removeSet(exIdx, setIdx)}
                          className="text-slate-500 hover:text-rose-400 text-sm"
                        >
                          −
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-[2rem_1fr_1fr_2.5rem_1.5rem] gap-2 items-center text-[10px] text-slate-400 uppercase tracking-wide mb-1">
                      <span>{t.workout.set}</span>
                      <span>{t.workout.weightUnit}</span>
                      <span>{t.planEditor.reps}</span>
                      <span>{t.common.done}</span>
                      <span></span>
                    </div>
                    {ex.sets.map((s, setIdx) => (
                      <div key={setIdx} className="grid grid-cols-[2rem_1fr_1fr_2.5rem_1.5rem] gap-2 items-center py-1">
                        <span className="text-sm font-bold text-slate-400">{setIdx + 1}</span>
                        <input
                          type="number"
                          step={0.5}
                          value={s.weight}
                          onChange={(e) => updateSet(exIdx, setIdx, { weight: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          value={s.reps}
                          onChange={(e) => updateSet(exIdx, setIdx, { reps: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <button
                          onClick={() => updateSet(exIdx, setIdx, { done: !s.done })}
                          className={`rounded h-8 text-sm font-bold ${s.done ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                        >
                          {s.done ? '✓' : '○'}
                        </button>
                        <button
                          onClick={() => removeSet(exIdx, setIdx)}
                          className="text-slate-500 hover:text-rose-400 text-sm"
                        >
                          −
                        </button>
                      </div>
                    ))}
                  </>
                )}
                <button
                  onClick={() => addSet(exIdx)}
                  className="w-full mt-1 py-1.5 border border-dashed border-slate-700 text-xs text-slate-400 rounded"
                >
                  {t.workout.addSet}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <button
        onClick={() => setPickerOpen(true)}
        className="w-full py-2.5 border-2 border-dashed border-slate-700 text-slate-300 rounded-xl text-sm"
      >
        {t.workout.addExercise}
      </button>

      <div className="flex gap-2 pt-2">
        <button onClick={cancel} className="px-4 bg-slate-700 hover:bg-slate-600 text-white py-2.5 rounded-lg">
          {t.common.cancel}
        </button>
        <button onClick={finish} className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-2.5 rounded-lg font-semibold">
          {t.workout.finish}
        </button>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 bg-black/60 z-20 flex items-end" onClick={() => setPickerOpen(false)}>
          <div className="w-full max-w-md mx-auto bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-3 border-b border-slate-800 flex">
              <h3 className="font-bold">{t.workout.addExerciseTitle}</h3>
              <button onClick={() => setPickerOpen(false)} className="ml-auto text-slate-400 text-xl leading-none">×</button>
            </div>
            <ul className="overflow-y-auto flex-1">
              {(() => {
                const available = catalog.filter(
                  (e) => !session.exercises.find((se) => se.exerciseId === e.id),
                );
                const favs = available.filter((e) => favorites.has(e.id));
                const rest = available.filter((e) => !favorites.has(e.id));
                const row = (ex: typeof available[number]) => {
                  const name = displayName(ex, locale);
                  const isFav = favorites.has(ex.id);
                  const img = imageUrl(ex.imagePath, ex.updatedAt);
                  return (
                    <li key={ex.id} className="flex items-stretch border-b border-slate-800 hover:bg-slate-800">
                      <button
                        onClick={() => addExercise(ex.id)}
                        className="flex-1 min-w-0 text-left px-4 py-3 flex items-center gap-3"
                      >
                        {img ? (
                          <img src={img} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-slate-700" />
                        ) : (
                          <div className="w-10 h-10 rounded bg-slate-700" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{name}</div>
                          {ex.equipment && <div className="text-xs text-slate-400 truncate capitalize">{ex.equipment}</div>}
                        </div>
                        {isFav && <span className="text-amber-400 text-sm shrink-0">★</span>}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailsFor(ex); }}
                        aria-label={t.library.viewDetails}
                        className="px-3 text-slate-400 hover:text-keung-500 border-l border-slate-800"
                      >
                        ⓘ
                      </button>
                    </li>
                  );
                };
                return (
                  <>
                    {favs.length > 0 && (
                      <li className="px-4 py-2 text-[10px] uppercase tracking-wider text-amber-400 bg-slate-900 sticky top-0">
                        ★ {t.library.favorites}
                      </li>
                    )}
                    {favs.map(row)}
                    {favs.length > 0 && rest.length > 0 && (
                      <li className="px-4 py-2 text-[10px] uppercase tracking-wider text-slate-500 bg-slate-900 sticky top-0">
                        {t.library.others}
                      </li>
                    )}
                    {rest.map(row)}
                  </>
                );
              })()}
            </ul>
          </div>
        </div>
      )}

      {detailsFor && (
        <ExerciseDetailsModal exercise={detailsFor} onClose={() => setDetailsFor(null)} />
      )}
    </div>
  );
}
