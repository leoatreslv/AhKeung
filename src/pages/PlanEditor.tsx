import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  muscleGroupColor,
  type CustomExercise,
  type MuscleGroup,
  type PlanExercise,
} from '../db';
import { displayName, imageUrl } from '../exerciseDisplay';
import { useExercises } from '../useExercises';
import { weekStartISO } from '../utils';
import { useI18n } from '../i18n';
import { useFavoriteIds } from '../useFavorites';
import { ExerciseDetailsModal } from '../components/ExerciseDetailsModal';
import { ShareSheet } from '../components/ShareSheet';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useAuth } from '../auth/useAuth';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { sharePlan } from '../sharing';

const ALL_GROUPS: MuscleGroup[] = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function PlanEditor() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const planId = id;
  const userId = useCurrentUserId();
  const { profile } = useAuth();
  const catalog = useExercises();

  const existing = useLiveQuery(
    async () => (planId ? await db.plans.get(planId) : undefined),
    [planId],
  );

  const [name, setName] = useState('');
  const [weekStart, setWeekStart] = useState(weekStartISO());
  const [focus, setFocus] = useState<MuscleGroup[]>([]);
  const [planExercises, setPlanExercises] = useState<PlanExercise[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<CustomExercise | null>(null);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [loadedFromId, setLoadedFromId] = useState<string | undefined>(undefined);

  if (existing && existing.id !== loadedFromId) {
    setLoadedFromId(existing.id);
    setName(existing.name);
    setWeekStart(existing.weekStart);
    setFocus(existing.focus);
    setPlanExercises(existing.exercises);
  }

  const filteredExercises = useMemo(() => {
    if (!catalog) return [];
    if (focus.length === 0) return catalog;
    return catalog.filter((e) => focus.includes(e.muscleGroup));
  }, [focus, catalog]);

  const findEx = (exId: string) => catalog?.find((e) => e.id === exId);

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
    if (!name.trim()) { alert(t.planEditor.nameRequired); return; }
    if (!userId) return;
    const newId = planId ?? crypto.randomUUID();
    await putWithSync('plans', {
      id: newId,
      name: name.trim(),
      weekStart,
      focus,
      exercises: planExercises,
      createdAt: existing?.createdAt ?? Date.now(),
    }, userId);
    navigate('/plans');
  };

  const remove = async () => {
    if (!planId) return;
    if (!confirm(t.planEditor.deleteConfirm)) return;
    await deleteWithSync('plans', planId);
    navigate('/plans');
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.planEditor.nameLabel}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.planEditor.namePlaceholderExample}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.planEditor.weekStarting}</label>
        <input
          type="date"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-2">{t.planEditor.focusGroups}</label>
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
              {t.muscleGroup[g]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-slate-400">{t.planEditor.exercises}</label>
          <button
            onClick={() => setPickerOpen(true)}
            className="text-keung-500 text-sm font-semibold"
          >
            {t.planEditor.addExercise}
          </button>
        </div>
        {planExercises.length === 0 ? (
          <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
            {t.planEditor.noExercises}
          </p>
        ) : (
          <ul className="space-y-2">
            {planExercises.map((pe) => {
              const ex = findEx(pe.exerciseId);
              const exName = ex ? displayName(ex, locale) : pe.exerciseId;
              const img = ex ? imageUrl(ex.imagePath, ex.updatedAt) : null;
              return (
                <li key={pe.exerciseId} className="bg-slate-800 rounded-xl border border-slate-700 p-3">
                  <div className="flex items-start gap-2 mb-2">
                    {img ? (
                      <img
                        src={img}
                        alt=""
                        loading="lazy"
                        className="w-10 h-10 rounded object-cover bg-slate-700"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-slate-700" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{exName}</div>
                      {ex?.equipment && <div className="text-xs text-slate-400 capitalize">{ex.equipment}</div>}
                    </div>
                    {ex && (
                      <button
                        onClick={() => setDetailsFor(ex)}
                        aria-label={t.library.viewDetails}
                        className="text-slate-400 hover:text-keung-500 text-sm px-1"
                      >
                        ⓘ
                      </button>
                    )}
                    <button
                      onClick={() => removeExercise(pe.exerciseId)}
                      className="text-slate-500 hover:text-rose-400 text-sm"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <label className="text-slate-400 block">{t.planEditor.sets}</label>
                      <input
                        type="number"
                        min={1}
                        value={pe.targetSets}
                        onChange={(e) => updateExercise(pe.exerciseId, { targetSets: Number(e.target.value) })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 block">{t.planEditor.reps}</label>
                      <input
                        type="number"
                        min={1}
                        value={pe.targetReps}
                        onChange={(e) => updateExercise(pe.exerciseId, { targetReps: Number(e.target.value) })}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 block">{t.planEditor.weightKg}</label>
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
          {t.planEditor.savePlan}
        </button>
        {planId && (
          <button onClick={remove} className="px-4 bg-rose-900/40 border border-rose-800 text-rose-300 py-2.5 rounded-lg">
            {t.common.delete}
          </button>
        )}
      </div>

      {/* Share plan — trainer-only, only meaningful once the plan is saved. */}
      {planId && profile?.isTrainer && (
        <button
          onClick={() => setShareSheetOpen(true)}
          className="w-full mt-2 py-2 border border-keung-600 text-keung-500 rounded-lg text-sm font-semibold"
        >📤 {t.share.sharePlan}</button>
      )}
      {shareStatus && <p className="text-xs text-slate-400 text-center">{shareStatus}</p>}

      {pickerOpen && (
        <ExercisePicker
          exercises={filteredExercises}
          excludeIds={planExercises.map((p) => p.exerciseId)}
          onPick={addExercise}
          onClose={() => setPickerOpen(false)}
          onShowDetails={setDetailsFor}
        />
      )}

      {detailsFor && (
        <ExerciseDetailsModal exercise={detailsFor} onClose={() => setDetailsFor(null)} />
      )}

      {shareSheetOpen && planId && (
        <ShareSheet
          title={`${t.share.sharePlanTitle}: ${name}`}
          onClose={() => setShareSheetOpen(false)}
          onConfirm={async (recipientIds) => {
            try {
              for (const r of recipientIds) {
                await sharePlan(planId, r);
              }
              setShareStatus(t.share.sharePlanSuccess(recipientIds.length));
            } catch (e) {
              setShareStatus(
                `${t.share.sharePlanFailed}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }}
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
  onShowDetails,
}: {
  exercises: CustomExercise[];
  excludeIds: string[];
  onPick: (id: string) => void;
  onClose: () => void;
  onShowDetails: (ex: CustomExercise) => void;
}) {
  const { t, locale } = useI18n();
  const favorites = useFavoriteIds();
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const list = exercises.filter((e) => {
    if (excludeIds.includes(e.id)) return false;
    if (search === '') return true;
    const en = (e.nameEn ?? '').toLowerCase();
    const zh = (e.nameZh ?? '').toLowerCase();
    return en.includes(q) || zh.includes(q);
  });
  const favList = list.filter((e) => favorites.has(e.id));
  const restList = list.filter((e) => !favorites.has(e.id));

  const renderRow = (ex: CustomExercise) => {
    const name = displayName(ex, locale);
    const isFav = favorites.has(ex.id);
    const img = imageUrl(ex.imagePath, ex.updatedAt);
    return (
      <li key={ex.id} className="flex items-stretch border-b border-slate-800 hover:bg-slate-800">
        <button
          onClick={() => onPick(ex.id)}
          className="flex-1 min-w-0 text-left px-4 py-3 flex items-center gap-3"
        >
          {img ? (
            <img src={img} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-slate-700" />
          ) : (
            <div className="w-10 h-10 rounded bg-slate-700" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm truncate">{name}</div>
            <div className="text-xs text-slate-400 truncate capitalize">
              {t.muscleGroup[ex.muscleGroup]}{ex.equipment ? ` · ${ex.equipment}` : ''}
            </div>
          </div>
          {isFav && <span className="text-amber-400 text-sm shrink-0">★</span>}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onShowDetails(ex); }}
          aria-label={t.library.viewDetails}
          className="px-3 text-slate-400 hover:text-keung-500 border-l border-slate-800"
        >
          ⓘ
        </button>
      </li>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-20 flex items-end" onClick={onClose}>
      <div
        className="w-full max-w-md mx-auto bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center mb-2">
            <h3 className="font-bold">{t.planEditor.pickExercise}</h3>
            <button onClick={onClose} className="ml-auto text-slate-400 text-xl leading-none">×</button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.common.search}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm"
            autoFocus
          />
        </div>
        <ul className="overflow-y-auto flex-1">
          {favList.length > 0 && (
            <li className="px-4 py-2 text-[10px] uppercase tracking-wider text-amber-400 bg-slate-900 sticky top-0">
              ★ {t.library.favorites}
            </li>
          )}
          {favList.map(renderRow)}
          {favList.length > 0 && restList.length > 0 && (
            <li className="px-4 py-2 text-[10px] uppercase tracking-wider text-slate-500 bg-slate-900 sticky top-0">
              {t.library.others}
            </li>
          )}
          {restList.map(renderRow)}
          {list.length === 0 && (
            <li className="p-4 text-center text-slate-500 text-sm">{t.planEditor.noMatch}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
