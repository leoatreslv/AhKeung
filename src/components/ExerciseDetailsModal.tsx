import { muscleGroupColor, type CustomExercise } from '../db';
import { displayName, imageUrl } from '../exerciseDisplay';
import { useI18n } from '../i18n';

export function ExerciseDetailsModal({
  exercise,
  onClose,
}: {
  exercise: CustomExercise;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const name = displayName(exercise, locale);
  const img = imageUrl(exercise.imagePath, exercise.updatedAt);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-30 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-auto bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-bold text-base truncate">{name}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className={`${muscleGroupColor[exercise.muscleGroup]} text-white text-[10px] px-2 py-0.5 rounded-full`}>
                {t.muscleGroup[exercise.muscleGroup]}
              </span>
              {exercise.equipment && (
                <span className="text-xs text-slate-400 capitalize truncate">{exercise.equipment}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t.common.cancel}
            className="text-slate-400 text-2xl leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-3 space-y-3 text-sm text-slate-300">
          {img && (
            <img
              src={img}
              alt=""
              loading="lazy"
              className="w-full max-h-72 object-contain rounded-lg bg-slate-700"
            />
          )}

          {exercise.instructions && (
            <div>
              <div className="text-slate-400 text-xs mb-1">{t.library.instructions}</div>
              <p className="whitespace-pre-wrap">{exercise.instructions}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
