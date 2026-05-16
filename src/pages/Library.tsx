import { useState } from 'react';
import { muscleGroupColor, type MuscleGroup } from '../db';
import { useT } from '../i18n';
import { useExercises } from '../useExercises';
import { imageUrl } from '../exercises';

const GROUPS: (MuscleGroup | 'all')[] = [
  'all', 'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function Library() {
  const t = useT();
  const all = useExercises();
  const [filter, setFilter] = useState<MuscleGroup | 'all'>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  if (!all) {
    return <div className="p-4 text-slate-400">{t.common.loading}</div>;
  }

  const list = all.filter((e) => {
    if (filter !== 'all' && e.muscleGroup !== filter) return false;
    if (search === '') return true;
    const local = t.exerciseName[e.id] ?? e.name;
    const q = search.toLowerCase();
    return local.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
  });

  return (
    <div className="p-4 space-y-3">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t.library.searchPlaceholder}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
      />

      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1">
        {GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setFilter(g)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium ${
              filter === g
                ? g === 'all'
                  ? 'bg-keung-600 text-white'
                  : `${muscleGroupColor[g as MuscleGroup]} text-white`
                : 'bg-slate-800 text-slate-300 border border-slate-700'
            }`}
          >
            {g === 'all' ? t.common.all : t.muscleGroup[g]}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500">{list.length} / {all.length}</p>

      <ul className="space-y-2">
        {list.map((ex) => {
          const name = t.exerciseName[ex.id] ?? ex.name;
          const isOpen = openId === ex.id;
          return (
            <li key={ex.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <button
                onClick={() => setOpenId(isOpen ? null : ex.id)}
                className="w-full text-left p-3 flex items-center gap-3"
              >
                {ex.images[0] ? (
                  <img
                    src={imageUrl(ex.images[0])}
                    alt=""
                    loading="lazy"
                    className="w-14 h-14 rounded-lg object-cover bg-slate-700 shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-slate-700 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{name}</div>
                  <div className="text-xs text-slate-400 truncate capitalize">{ex.equipment}</div>
                </div>
                <span className={`${muscleGroupColor[ex.muscleGroup]} text-white text-[10px] px-2 py-0.5 rounded-full shrink-0`}>
                  {t.muscleGroup[ex.muscleGroup]}
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3 border-t border-slate-700 pt-2 text-sm text-slate-300 space-y-3">
                  {ex.images.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto -mx-3 px-3">
                      {ex.images.map((img) => (
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
                    {ex.level && (
                      <div>
                        <div className="text-slate-400">{t.library.level}</div>
                        <div className="capitalize">{ex.level}</div>
                      </div>
                    )}
                    <div>
                      <div className="text-slate-400">{t.library.primaryMuscles}</div>
                      <div className="capitalize">{ex.primaryMuscles.join(', ')}</div>
                    </div>
                    {ex.secondaryMuscles.length > 0 && (
                      <div className="col-span-2">
                        <div className="text-slate-400">{t.library.secondaryMuscles}</div>
                        <div className="capitalize">{ex.secondaryMuscles.join(', ')}</div>
                      </div>
                    )}
                  </div>
                  {ex.instructions.length > 0 && (
                    <div>
                      <div className="text-slate-400 text-xs mb-1">{t.library.instructions}</div>
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        {ex.instructions.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="text-center text-slate-500 text-sm py-8">{t.library.noMatch}</li>
        )}
      </ul>
    </div>
  );
}
