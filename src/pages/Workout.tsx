import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type SetLog, type WorkoutSession } from '../db';
import { exerciseById, exercises as allExercises } from '../exercises';
import { todayISO, formatDuration } from '../utils';
import { useT } from '../i18n';

export function Workout() {
  const t = useT();
  const { planId } = useParams<{ planId?: string }>();
  const navigate = useNavigate();
  const plan = useLiveQuery(
    async () => (planId ? await db.plans.get(Number(planId)) : undefined),
    [planId],
  );

  const [session, setSession] = useState<WorkoutSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (planId && !plan) return;
    if (session) return;
    const newSession: WorkoutSession = {
      planId: plan?.id,
      date: todayISO(),
      startedAt: Date.now(),
      exercises:
        plan?.exercises.map((pe) => ({
          exerciseId: pe.exerciseId,
          sets: Array.from({ length: pe.targetSets }, () => ({
            reps: pe.targetReps,
            weight: pe.targetWeight ?? 0,
            done: false,
          })),
        })) ?? [],
    };
    setSession(newSession);
  }, [plan, planId, session]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => setElapsed(Date.now() - session.startedAt), 1000);
    return () => clearInterval(timer);
  }, [session]);

  if (!session) {
    return <div className="p-4 text-slate-400">{t.common.loading}</div>;
  }

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
      const last = ex.sets[ex.sets.length - 1];
      const newSet: SetLog = { reps: last?.reps ?? 10, weight: last?.weight ?? 0, done: false };
      return { ...s, exercises: s.exercises.map((e, i) => (i === exIdx ? { ...e, sets: [...e.sets, newSet] } : e)) };
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
    setSession((s) => s && {
      ...s,
      exercises: [...s.exercises, { exerciseId: id, sets: [{ reps: 10, weight: 0, done: false }] }],
    });
    setPickerOpen(false);
  };

  const removeExercise = (exIdx: number) => {
    setSession((s) => s && { ...s, exercises: s.exercises.filter((_, i) => i !== exIdx) });
  };

  const finish = async () => {
    const done = session.exercises.some((e) => e.sets.some((s) => s.done));
    if (!done) {
      if (!confirm(t.workout.noSetsDoneConfirm)) return;
    }
    await db.sessions.add({ ...session, endedAt: Date.now() });
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
          const meta = exerciseById(ex.exerciseId);
          if (!meta) return null;
          return (
            <li key={ex.exerciseId} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="p-3 flex items-center gap-2 border-b border-slate-700">
                <span className="text-2xl">{meta.emoji}</span>
                <div className="flex-1">
                  <div className="font-semibold text-sm">{t.exercise[meta.id]?.name ?? meta.id}</div>
                  <div className="text-xs text-slate-400">{meta.equipment}</div>
                </div>
                <button onClick={() => removeExercise(exIdx)} className="text-slate-500 hover:text-rose-400">✕</button>
              </div>
              <div className="px-3 py-2">
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
                      className={`bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                    />
                    <input
                      type="number"
                      value={s.reps}
                      onChange={(e) => updateSet(exIdx, setIdx, { reps: Number(e.target.value) })}
                      className={`bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
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
              {allExercises
                .filter((e) => !session.exercises.find((se) => se.exerciseId === e.id))
                .map((ex) => (
                  <li key={ex.id}>
                    <button
                      onClick={() => addExercise(ex.id)}
                      className="w-full text-left px-4 py-3 border-b border-slate-800 flex items-center gap-3 hover:bg-slate-800"
                    >
                      <span className="text-2xl">{ex.emoji}</span>
                      <div>
                        <div className="font-medium text-sm">{t.exercise[ex.id]?.name ?? ex.id}</div>
                        <div className="text-xs text-slate-400">{ex.equipment}</div>
                      </div>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
