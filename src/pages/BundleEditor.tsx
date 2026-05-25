import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CustomExercise } from '../db';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useExercises } from '../useExercises';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { displayName, imageUrl } from '../exerciseDisplay';

export function BundleEditor() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const userId = useCurrentUserId();
  const catalog = useExercises();

  const existingBundle = useLiveQuery(
    async () => (id ? await db.exerciseBundles.get(id) : undefined),
    [id],
  );
  const existingItems = useLiveQuery(
    async () => (id ? await db.exerciseBundleItems.where('bundleId').equals(id).toArray() : []),
    [id],
  );

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Local working set of exercise IDs (in order). We persist on Save.
  const [exerciseIds, setExerciseIds] = useState<string[]>([]);
  const [loadedFromId, setLoadedFromId] = useState<string | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existingBundle && existingBundle.id !== loadedFromId && existingItems) {
    setLoadedFromId(existingBundle.id);
    setName(existingBundle.name);
    setDescription(existingBundle.description ?? '');
    setExerciseIds(
      [...existingItems]
        .sort((a, b) => a.position - b.position)
        .map((it) => it.exerciseId),
    );
  }

  const findEx = (exId: string): CustomExercise | undefined =>
    catalog?.find((c) => c.id === exId);

  function removeExercise(exId: string) {
    setExerciseIds((arr) => arr.filter((x) => x !== exId));
  }
  function move(exId: string, dir: -1 | 1) {
    setExerciseIds((arr) => {
      const i = arr.indexOf(exId);
      if (i < 0) return arr;
      const j = i + dir;
      if (j < 0 || j >= arr.length) return arr;
      const next = [...arr];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function addExercise(exId: string) {
    setExerciseIds((arr) => (arr.includes(exId) ? arr : [...arr, exId]));
    setPickerOpen(false);
  }

  async function save() {
    if (!name.trim()) { setError(t.bundleEditor.needsName); return; }
    if (!userId) return;

    const newId = id ?? crypto.randomUUID();
    await putWithSync('exerciseBundles', {
      id: newId,
      ownerId: userId,
      name: name.trim(),
      description: description.trim() || null,
      createdAt: existingBundle?.createdAt ?? Date.now(),
    }, userId);

    // Sync the items: compute the diff vs existingItems and apply.
    // Items removed from the working set get soft-deleted (sync queue picks
    // them up next push). Items added or repositioned go through putWithSync.
    for (const it of existingItems ?? []) {
      if (!exerciseIds.includes(it.exerciseId)) {
        await deleteWithSync('exerciseBundleItems', newId, it.exerciseId);
      }
    }
    for (let i = 0; i < exerciseIds.length; i++) {
      const exId = exerciseIds[i];
      await putWithSync('exerciseBundleItems', {
        bundleId: newId,
        exerciseId: exId,
        position: i,
      }, userId);
    }
    navigate('/trainer/bundles');
  }

  async function remove() {
    if (!id) return;
    if (!confirm(t.bundleEditor.deleteConfirm)) return;
    // Soft-delete each item, then the bundle. Server-side ON DELETE CASCADE
    // would clean items up when the bundle is hard-deleted, but our delete
    // path uses tombstones — explicitly tombstone items so RLS revokes
    // access for recipients on next pull.
    for (const it of existingItems ?? []) {
      await deleteWithSync('exerciseBundleItems', id, it.exerciseId);
    }
    await deleteWithSync('exerciseBundles', id);
    navigate('/trainer/bundles');
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/trainer/bundles')}
          aria-label="back"
          className="text-slate-300 text-xl leading-none px-1"
        >←</button>
        <h2 className="text-lg font-bold">
          {id ? t.bundleEditor.titleEditing : t.bundleEditor.title}
        </h2>
      </div>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.bundleEditor.name}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.bundleEditor.namePlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.bundleEditor.description}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t.bundleEditor.descriptionPlaceholder}
          rows={3}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-slate-400">{t.bundleEditor.exercises}</label>
          <button
            onClick={() => setPickerOpen(true)}
            className="text-keung-500 text-sm font-semibold"
          >{t.bundleEditor.addExercise}</button>
        </div>
        {exerciseIds.length === 0 ? (
          <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
            {t.bundleEditor.noExercises}
          </p>
        ) : (
          <ul className="space-y-2">
            {exerciseIds.map((exId, idx) => {
              const ex = findEx(exId);
              const name = ex ? displayName(ex, locale) : exId;
              const img = ex ? imageUrl(ex.imagePath, ex.updatedAt) : null;
              return (
                <li key={exId} className="bg-slate-800 rounded-xl border border-slate-700 p-3 flex items-center gap-2">
                  {img ? (
                    <img src={img} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-slate-700" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-slate-700" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{name}</div>
                    {ex?.equipment && (
                      <div className="text-xs text-slate-400 capitalize">{ex.equipment}</div>
                    )}
                  </div>
                  <button
                    onClick={() => move(exId, -1)}
                    disabled={idx === 0}
                    aria-label="up"
                    className="text-slate-400 disabled:opacity-30 px-1"
                  >↑</button>
                  <button
                    onClick={() => move(exId, 1)}
                    disabled={idx === exerciseIds.length - 1}
                    aria-label="down"
                    className="text-slate-400 disabled:opacity-30 px-1"
                  >↓</button>
                  <button
                    onClick={() => removeExercise(exId)}
                    className="text-slate-500 hover:text-rose-400 text-sm"
                  >✕</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={save}
          className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-2.5 rounded-lg font-semibold"
        >{t.bundleEditor.save}</button>
        {id && (
          <button
            onClick={remove}
            className="px-4 bg-rose-900/40 border border-rose-800 text-rose-300 py-2.5 rounded-lg"
          >{t.bundleEditor.delete}</button>
        )}
      </div>

      {pickerOpen && catalog && (
        <ExercisePicker
          exercises={catalog.filter((e) => !exerciseIds.includes(e.id))}
          onPick={addExercise}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function ExercisePicker({
  exercises, onPick, onClose,
}: { exercises: CustomExercise[]; onPick: (id: string) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const list = exercises.filter((e) => {
    if (search === '') return true;
    const en = (e.nameEn ?? '').toLowerCase();
    const zh = (e.nameZh ?? '').toLowerCase();
    return en.includes(q) || zh.includes(q);
  });

  return (
    <div className="fixed inset-0 bg-black/60 z-20 flex items-end" onClick={onClose}>
      <div
        className="w-full max-w-md mx-auto bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800">
          <div className="flex items-center mb-2">
            <h3 className="font-bold">{t.bundleEditor.addExercise}</h3>
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
          {list.map((ex) => {
            const name = displayName(ex, locale);
            const img = imageUrl(ex.imagePath, ex.updatedAt);
            return (
              <li key={ex.id}>
                <button
                  onClick={() => onPick(ex.id)}
                  className="w-full text-left px-4 py-3 border-b border-slate-800 flex items-center gap-3 hover:bg-slate-800"
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
                </button>
              </li>
            );
          })}
          {list.length === 0 && (
            <li className="p-4 text-center text-slate-500 text-sm">{t.planEditor.noMatch}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
