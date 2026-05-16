import { muscleGroupColor } from '../db';
import { imageUrl, type ExerciseMeta } from '../exercises';
import { useT } from '../i18n';

export function ExerciseDetailsModal({
  exercise,
  onClose,
}: {
  exercise: ExerciseMeta;
  onClose: () => void;
}) {
  const t = useT();
  const name = t.exerciseName[exercise.id] ?? exercise.name;

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
              <span className="text-xs text-slate-400 capitalize truncate">{exercise.equipment}</span>
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
          {exercise.images.length > 0 && (
            <div className="flex gap-2 overflow-x-auto -mx-3 px-3">
              {exercise.images.map((img) => (
                <img
                  key={img}
                  src={imageUrl(img)}
                  alt=""
                  loading="lazy"
                  className="h-40 rounded-lg bg-slate-700"
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-xs">
            {exercise.level && (
              <div>
                <div className="text-slate-400">{t.library.level}</div>
                <div className="capitalize">{exercise.level}</div>
              </div>
            )}
            <div>
              <div className="text-slate-400">{t.library.primaryMuscles}</div>
              <div className="capitalize">{exercise.primaryMuscles.join(', ')}</div>
            </div>
            {exercise.secondaryMuscles.length > 0 && (
              <div className="col-span-2">
                <div className="text-slate-400">{t.library.secondaryMuscles}</div>
                <div className="capitalize">{exercise.secondaryMuscles.join(', ')}</div>
              </div>
            )}
          </div>

          {exercise.instructions.length > 0 && (
            <div>
              <div className="text-slate-400 text-xs mb-1">{t.library.instructions}</div>
              <ol className="list-decimal list-inside space-y-1">
                {exercise.instructions.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
