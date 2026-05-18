import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor, type MuscleGroup } from '../db';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { useTranslate } from '../useTranslate';

const ALL_GROUPS: MuscleGroup[] = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function ExerciseEditor() {
  const { t } = useI18n();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const userId = useCurrentUserId();
  const { translate, loading: translating, error: translateError } = useTranslate();

  const existing = useLiveQuery(
    async () => (id ? await db.exercises.get(id) : undefined),
    [id],
  );

  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [muscleGroup, setMuscleGroup] = useState<MuscleGroup | null>(null);
  const [equipment, setEquipment] = useState('');
  const [instructions, setInstructions] = useState('');
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

  async function onTranslate(direction: 'en→zh' | 'zh→en') {
    const source = direction === 'en→zh' ? 'en' : 'zh-TW';
    const target = direction === 'en→zh' ? 'zh-TW' : 'en';
    const input = direction === 'en→zh' ? nameEn : nameZh;
    const out = await translate(input, source, target);
    if (out === null) return;
    if (direction === 'en→zh') setNameZh(out); else setNameEn(out);
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
    }, userId);
    navigate('/exercises');
  }

  async function remove() {
    if (!id) return;
    if (!confirm(t.exerciseEditor.deleteConfirm)) return;
    await deleteWithSync('exercises', id);
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

      <BilingualNameField
        label={t.exerciseEditor.nameEn}
        value={nameEn}
        onChange={setNameEn}
        canTranslate={!!nameZh.trim() && !translating}
        onTranslate={() => onTranslate('zh→en')}
        translating={translating}
      />
      <BilingualNameField
        label={t.exerciseEditor.nameZh}
        value={nameZh}
        onChange={setNameZh}
        canTranslate={!!nameEn.trim() && !translating}
        onTranslate={() => onTranslate('en→zh')}
        translating={translating}
      />
      {translateError && (
        <p className="text-rose-400 text-xs">{t.exerciseEditor.translateError}: {translateError}</p>
      )}

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

function BilingualNameField({
  label, value, onChange, canTranslate, onTranslate, translating,
}: {
  label: string; value: string; onChange: (v: string) => void;
  canTranslate: boolean; onTranslate: () => void; translating: boolean;
}) {
  const { t } = useI18n();
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t.exerciseEditor.namePlaceholder}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
        <button
          type="button"
          onClick={onTranslate}
          disabled={!canTranslate}
          className="px-3 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm whitespace-nowrap"
          title={t.exerciseEditor.translate}
        >
          {translating ? t.exerciseEditor.translating : `🌐 ${t.exerciseEditor.translate}`}
        </button>
      </div>
    </div>
  );
}
