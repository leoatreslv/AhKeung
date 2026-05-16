import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  muscleGroupColor,
  muscleGroupLabel,
  type MuscleGroup,
  type PlanExercise,
} from '../db';
import { exerciseById, exercises } from '../exercises';
import { weekStartISO } from '../utils';

const ALL_GROUPS: MuscleGroup[] = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function PlanEditor() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const planId = id ? Number(id) : undefined;

  const existing = useLiveQuery(
    async () => (planId ? await db.plans.get(planId) : undefined),
    [planId],
  );

  const [name, setName] = useState('');
  const [weekStart, setWeekStart] = useState(weekStartISO());
  const [focus, setFocus] = useState<MuscleGroup[]>([]);
  const [planExercises, setPlanExercises] = useState<PlanExercise[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setWeekStart(existing.weekStart);
      setFocus(existing.focus);
      setPlanExercises(existing.exercises);
    }
  }, [existing]);

  const filteredExercises = useMemo(() => {
    if (focus.length === 0) return exercises;
    return exercises.filter((e) => focus.includes(e.muscleGroup));
  }, [focus]);

  const toggleFocus = (g: MuscleGroup) =>
    setFocus((f) => (f.includes(g) ? f.filter((x) => x !== g) : [...f, g]));

  const addExercise = (exId: string) => {
    if (planExercises.find((p) => p.exerciseId === exId)) return;
    setPlanExercises((arr) => [
      ...arr,
      { exerciseId: exId, targetSets: 3, targetReps: 10 },
    ]);
    setPickerOpen(false);
  };

  const removeExercise = (exId: string) =>
    setPlanExercises((arr) => arr.filter((p) => p.exerciseId !== exId));

  const updateExercise = (exId: string, patch: Partial<PlanExercise>) =>
    setPlanExercises((arr) => arr.map((p) => (p.exerciseId === exId ? { ...p, ...patch } : p)));

  const save = async () => {
    if (!name.trim()) {
      alert('Give your plan a name');
      return;
    }
    const data = {
      name: name.trim(),
      weekStart,
      focus,
      exercises: planExercises,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (planId) {
      await db.plans.update(planId, data);
    } else {
      await db.plans.add(data);
    }
    navigate('/plans');
  };

  const remove = async () => {
    if (!planId) return;
    if (!confirm('Delete this plan?')) return;
    await db.plans.delete(planId);
    navigate('/plans');
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="text-xs text-slate-400 block mb-1">Plan name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Push/Pull Week"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">Week starting</label>
        <input
          type="date"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-2">Focus muscle groups</label>
        <div className="flex flex-wrap gap-2">
          {ALL_GROUPS.map((g) => (
            <button
              key={g}
              onClick={() => toggleFocus(g)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                focus.includes(g)
                  ? `${muscleGroupColor[g]} text-white border-transparent`
                  : 'bg-slate-800 text-slate-300 border-slate-700'
              }`}
            >
              {muscleGroupLabel[g]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-slate-400">Exercises</label>
          <button
            onClick={() => setPickerOpen(true)}
            className="text-keung-500 text-sm font-semibold"
          >
            + Add
          </button>
        </div>
        {planExercises.length === 0 ? (
          <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
            No exercises yet. Tap "+ Add" to start.
          </p>
        ) : (
          <ul className="space-y-2">
            {planExercises.map((pe) => {
              const ex = exerciseById(pe.exerciseId);
              if (!ex) return null;
              return (
                <li key={pe.exerciseId} className="bg-slate-800 rounded-xl border border-slate-700 p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <div className="text-2xl">{ex.emoji}</div>
                    <div className="flex-1">
                      <div className="font-semibold text-sm">{ex.name}</div>
                      <div className="text-xs text-slate-400">{ex.equipment}</div>
                    </div>
                    <button
                      onClick={() => removeExercise(pe.exerciseId)}
                      className="text-slate-500 hover:text-rose-400 text-sm"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <label className="text-slate-400 block">Sets</label>
                      <input
                        type="number"
                        min={1}
                        value={pe.targetSets}
                        onChange={(e) => updateExercise(pe.exerciseId, { targetSets: Number(e.target.value) })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 block">Reps</label>
                      <input
                        type="number"
                        min={1}
                        value={pe.targetReps}
                        onChange={(e) => updateExercise(pe.exerciseId, { targetReps: Number(e.target.value) })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 block">Weight (kg)</label>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={pe.targetWeight ?? ''}
                        onChange={(e) => updateExercise(pe.exerciseId, { targetWeight: e.target.value ? Number(e.target.value) : undefined })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <button onClick={save} className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-2.5 rounded-lg font-semibold">
          Save Plan
        </button>
        {planId && (
          <button onClick={remove} className="px-4 bg-rose-900/40 border border-rose-800 text-rose-300 py-2.5 rounded-lg">
            Delete
          </button>
        )}
      </div>

      {pickerOpen && (
        <ExercisePicker
          exercises={filteredExercises}
          excludeIds={planExercises.map((p) => p.exerciseId)}
          onPick={addExercise}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function ExercisePicker({
  exercises,
  excludeIds,
  onPick,
  onClose,
}: {
  exercises: typeof import('../exercises').exercises;
  excludeIds: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const list = exercises.filter(
    (e) =>
      !excludeIds.includes(e.id) &&
      (search === '' || e.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-20 flex items-end" onClick={onClose}>
      <div
        className="w-full max-w-md mx-auto bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center mb-2">
            <h3 className="font-bold">Pick an exercise</h3>
            <button onClick={onClose} className="ml-auto text-slate-400 text-xl leading-none">×</button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"
            autoFocus
          />
        </div>
        <ul className="overflow-y-auto flex-1">
          {list.map((ex) => (
            <li key={ex.id}>
              <button
                onClick={() => onPick(ex.id)}
                className="w-full text-left px-4 py-3 border-b border-slate-800 flex items-center gap-3 hover:bg-slate-800"
              >
                <span className="text-2xl">{ex.emoji}</span>
                <div className="flex-1">
                  <div className="font-medium text-sm">{ex.name}</div>
                  <div className="text-xs text-slate-400">{muscleGroupLabel[ex.muscleGroup]} · {ex.equipment}</div>
                </div>
              </button>
            </li>
          ))}
          {list.length === 0 && (
            <li className="p-4 text-center text-slate-500 text-sm">No exercises match.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
