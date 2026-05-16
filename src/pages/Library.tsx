import { useState } from 'react';
import { exercises } from '../exercises';
import { muscleGroupColor, muscleGroupLabel, type MuscleGroup } from '../db';

const GROUPS: (MuscleGroup | 'all')[] = [
  'all', 'chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio',
];

export function Library() {
  const [filter, setFilter] = useState<MuscleGroup | 'all'>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = exercises.filter(
    (e) =>
      (filter === 'all' || e.muscleGroup === filter) &&
      (search === '' || e.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="p-4 space-y-3">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search exercises…"
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
            {g === 'all' ? 'All' : muscleGroupLabel[g]}
          </button>
        ))}
      </div>

      <ul className="space-y-2">
        {list.map((ex) => (
          <li key={ex.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            <button
              onClick={() => setOpenId(openId === ex.id ? null : ex.id)}
              className="w-full text-left p-3 flex items-center gap-3"
            >
              <span className="text-3xl">{ex.emoji}</span>
              <div className="flex-1">
                <div className="font-semibold text-sm">{ex.name}</div>
                <div className="text-xs text-slate-400">{ex.equipment}</div>
              </div>
              <span className={`${muscleGroupColor[ex.muscleGroup]} text-white text-[10px] px-2 py-0.5 rounded-full`}>
                {muscleGroupLabel[ex.muscleGroup]}
              </span>
            </button>
            {openId === ex.id && (
              <div className="px-3 pb-3 text-sm text-slate-300 border-t border-slate-700 pt-2">
                {ex.description}
              </div>
            )}
          </li>
        ))}
        {list.length === 0 && (
          <li className="text-center text-slate-500 text-sm py-8">No exercises match.</li>
        )}
      </ul>
    </div>
  );
}
