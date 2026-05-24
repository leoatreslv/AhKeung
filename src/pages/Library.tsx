import { useState } from 'react';
import { muscleGroupColor, type MuscleGroup } from '../db';
import { useI18n } from '../i18n';
import { useExercises } from '../useExercises';
import { displayName, imageUrl } from '../exerciseDisplay';
import { useFavoriteIds, toggleFavorite } from '../useFavorites';

const GROUPS: (MuscleGroup | 'all')[] = [
  'all', 'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function Library() {
  const { t, locale } = useI18n();
  const all = useExercises();
  const favorites = useFavoriteIds();
  const [filter, setFilter] = useState<MuscleGroup | 'all'>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  if (!all) {
    return <div className="p-4 text-slate-400">{t.common.loading}</div>;
  }

  const q = search.toLowerCase();
  const list = all.filter((e) => {
    if (filter !== 'all' && e.muscleGroup !== filter) return false;
    if (search === '') return true;
    const en = (e.nameEn ?? '').toLowerCase();
    const zh = (e.nameZh ?? '').toLowerCase();
    return en.includes(q) || zh.includes(q);
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
          const name = displayName(ex, locale);
          const isOpen = openId === ex.id;
          const isFav = favorites.has(ex.id);
          const img = imageUrl(ex.imagePath, ex.updatedAt);
          return (
            <li key={ex.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="flex items-stretch">
                <button
                  onClick={() => setOpenId(isOpen ? null : ex.id)}
                  className="flex-1 min-w-0 text-left p-3 flex items-center gap-3"
                >
                  {img ? (
                    <img
                      src={img}
                      alt=""
                      loading="lazy"
                      className="w-14 h-14 rounded-lg object-cover bg-slate-700 shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-slate-700 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{name}</div>
                    {ex.equipment && (
                      <div className="text-xs text-slate-400 truncate capitalize">{ex.equipment}</div>
                    )}
                  </div>
                  <span className={`${muscleGroupColor[ex.muscleGroup]} text-white text-[10px] px-2 py-0.5 rounded-full shrink-0`}>
                    {t.muscleGroup[ex.muscleGroup]}
                  </span>
                </button>
                <button
                  onClick={() => void toggleFavorite(ex.id)}
                  aria-label={isFav ? t.library.removeFromFavorites : t.library.addToFavorites}
                  aria-pressed={isFav}
                  className={`px-3 text-lg shrink-0 border-l border-slate-700 ${
                    isFav ? 'text-amber-400' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {isFav ? '★' : '☆'}
                </button>
              </div>
              {isOpen && (
                <div className="px-3 pb-3 border-t border-slate-700 pt-2 text-sm text-slate-300 space-y-3">
                  {img && (
                    <img
                      src={img}
                      alt=""
                      loading="lazy"
                      className="w-full max-h-60 object-contain rounded-lg bg-slate-700"
                    />
                  )}
                  {ex.instructions && (
                    <div>
                      <div className="text-slate-400 text-xs mb-1">{t.library.instructions}</div>
                      <p className="whitespace-pre-wrap text-sm">{ex.instructions}</p>
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
