import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor, type MuscleGroup } from '../db';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { resizeImage } from '../imageResize';
import { imageUrl } from '../exerciseDisplay';
import { log } from '../diagnostics/logger';
import { CATEGORY } from '../diagnostics/categories';

const ALL_GROUPS: MuscleGroup[] = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function ExerciseEditor() {
  const { t } = useI18n();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const userId = useCurrentUserId();

  const existing = useLiveQuery(
    async () => (id ? await db.exercises.get(id) : undefined),
    [id],
  );

  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [muscleGroup, setMuscleGroup] = useState<MuscleGroup | null>(null);
  const [equipment, setEquipment] = useState('');
  const [instructions, setInstructions] = useState('');
  // Newly-picked image (Blob, post-resize). Held in component state until
  // Save, at which point it's written to the row's pendingImageBlob field
  // and the sync orchestrator's image-upload sweep takes over.
  const [pickedImage, setPickedImage] = useState<Blob | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // The preview URL is derived from the picked blob — useMemo creates it
  // when pickedImage changes; the useEffect below revokes it when the URL
  // is replaced or the component unmounts.
  const previewUrl = useMemo(
    () => (pickedImage ? URL.createObjectURL(pickedImage) : null),
    [pickedImage],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  const [loadedFromId, setLoadedFromId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  if (existing && existing.id !== loadedFromId) {
    setLoadedFromId(existing.id);
    setNameEn(existing.nameEn ?? '');
    setNameZh(existing.nameZh ?? '');
    setMuscleGroup(existing.muscleGroup);
    setEquipment(existing.equipment ?? '');
    setInstructions(existing.instructions ?? '');
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';  // allow re-picking the same file
    if (!file) return;
    setImageError(null);
    try {
      const resized = await resizeImage(file);
      setPickedImage(resized);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    const trimEn = nameEn.trim();
    const trimZh = nameZh.trim();
    if (!trimEn && !trimZh) { setError(t.exerciseEditor.needsName); return; }
    if (!muscleGroup) { setError(t.exerciseEditor.needsMuscleGroup); return; }
    if (!userId) return;

    const newId = id ?? crypto.randomUUID();
    await putWithSync('exercises', {
      id: newId,
      ownerId: userId,
      nameEn: trimEn || null,
      nameZh: trimZh || null,
      muscleGroup,
      equipment: equipment.trim() || null,
      instructions: instructions.trim() || null,
      imagePath: existing?.imagePath ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
      // pendingImageBlob is stamped via a separate Dexie write below so the
      // push worker can detect it (it's a client-only field stripped from
      // server payloads).
    }, userId);
    if (pickedImage) {
      await db.exercises.update(newId, { pendingImageBlob: pickedImage });
    }
    log.info(CATEGORY.exercise, id ? 'updated' : 'created', {
      id: newId, hadImage: !!pickedImage,
    });
    navigate('/exercises');
  }

  async function remove() {
    if (!id) return;
    if (!confirm(t.exerciseEditor.deleteConfirm)) return;
    // Cascade: drop this exercise from every bundle that contains it.
    // The server-side trigger does the same on the server, but doing it
    // client-side too keeps the trainer's local Dexie consistent without
    // waiting for the next pull tick.
    const memberships = await db.exerciseBundleItems
      .where('exerciseId').equals(id).toArray();
    for (const m of memberships) {
      await deleteWithSync('exerciseBundleItems', m.bundleId, m.exerciseId);
    }
    await deleteWithSync('exercises', id);
    log.info(CATEGORY.exercise, 'deleted', { id, bundlesAffected: memberships.length });
    navigate('/exercises');
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/exercises')}
          aria-label="back"
          className="text-slate-300 text-xl leading-none px-1"
        >←</button>
        <h2 className="text-lg font-bold">
          {id ? t.exerciseEditor.titleEditing : t.exerciseEditor.title}
        </h2>
      </div>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.exerciseEditor.nameEn}</label>
        <input
          value={nameEn}
          onChange={(e) => setNameEn(e.target.value)}
          placeholder={t.exerciseEditor.namePlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.exerciseEditor.nameZh}</label>
        <input
          value={nameZh}
          onChange={(e) => setNameZh(e.target.value)}
          placeholder={t.exerciseEditor.namePlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-2">{t.exerciseEditor.muscleGroup}</label>
        <div className="flex flex-wrap gap-2">
          {ALL_GROUPS.map((g) => (
            <button
              key={g}
              onClick={() => setMuscleGroup(g)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                muscleGroup === g
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
        <label className="text-xs text-slate-400 block mb-1">{t.exerciseEditor.equipment}</label>
        <input
          value={equipment}
          onChange={(e) => setEquipment(e.target.value)}
          placeholder={t.exerciseEditor.equipmentPlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.exerciseEditor.instructions}</label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t.exerciseEditor.instructionsPlaceholder}
          rows={6}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
      </div>

      <ImagePicker
        previewUrl={previewUrl}
        existingImagePath={existing?.imagePath ?? null}
        pendingExisting={!!existing?.pendingImageBlob}
        onPick={onPickFile}
        onClear={() => setPickedImage(null)}
        error={imageError}
      />

      <div className="flex gap-2 pt-2">
        <button
          onClick={save}
          className="flex-1 bg-keung-600 hover:bg-keung-700 text-white py-2.5 rounded-lg font-semibold"
        >{t.exerciseEditor.save}</button>
        {id && (
          <button
            onClick={remove}
            className="px-4 bg-rose-900/40 border border-rose-800 text-rose-300 py-2.5 rounded-lg"
          >{t.exerciseEditor.delete}</button>
        )}
      </div>
    </div>
  );
}

function ImagePicker({
  previewUrl, existingImagePath, pendingExisting, onPick, onClear, error,
}: {
  previewUrl: string | null;
  existingImagePath: string | null;
  pendingExisting: boolean;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  error: string | null;
}) {
  const { t } = useI18n();
  const existingUrl = imageUrl(existingImagePath);
  const showingNew = !!previewUrl;
  const showingExisting = !showingNew && (!!existingUrl || pendingExisting);

  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{t.exerciseEditor.image}</label>

      {showingNew && (
        <div className="relative inline-block">
          <img
            src={previewUrl!}
            alt=""
            className="max-h-48 rounded-lg bg-slate-700"
          />
          <button
            type="button"
            onClick={onClear}
            aria-label={t.common.cancel}
            className="absolute top-1 right-1 bg-slate-900/80 text-slate-200 rounded-full w-7 h-7 leading-7 text-center"
          >×</button>
        </div>
      )}

      {showingExisting && (
        <div className="space-y-1">
          {existingUrl && (
            <img src={existingUrl} alt="" className="max-h-48 rounded-lg bg-slate-700" />
          )}
          {pendingExisting && (
            <p className="text-xs text-amber-400">{t.exerciseEditor.imageUploading}</p>
          )}
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <label className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 text-center cursor-pointer">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPick}
            className="hidden"
          />
          {showingNew || showingExisting ? t.exerciseEditor.imageReplace : t.exerciseEditor.imagePick}
        </label>
      </div>

      {error && <p className="text-rose-400 text-xs mt-1">{error}</p>}
    </div>
  );
}
