import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, muscleGroupColor } from '../db';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useAuth } from '../auth/useAuth';
import { displayName, imageUrl } from '../exerciseDisplay';
import { ShareSheet } from '../components/ShareSheet';
import { shareResource } from '../sharing';

export function MyExercises() {
  const { t, locale } = useI18n();
  const userId = useCurrentUserId();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);

  const exercises = useLiveQuery(
    async () => {
      if (!userId) return [];
      const rows = await db.exercises
        .where('ownerId').equals(userId)
        .and((e) => !e.deletedAt)
        .toArray();
      return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    },
    [userId],
  );

  if (profile && !profile.isTrainer) {
    return (
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
          <h2 className="text-lg font-bold">{t.myExercises.title}</h2>
        </div>
        <p className="text-slate-400 text-sm">{t.myExercises.notATrainerYet}</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
        <h2 className="text-lg font-bold flex-1">{t.myExercises.title}</h2>
        <Link
          to="/exercises/new"
          className="bg-keung-600 hover:bg-keung-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold"
        >
          {t.myExercises.newButton}
        </Link>
      </div>

      {!exercises ? (
        <p className="text-slate-400 text-sm">{t.common.loading}</p>
      ) : exercises.length === 0 ? (
        <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
          {t.myExercises.empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {exercises.map((ex) => {
            const name = displayName(ex, locale);
            const img = imageUrl(ex.imagePath);
            return (
              <li key={ex.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden flex items-stretch">
                <Link to={`/exercises/${ex.id}`} className="flex-1 p-3 flex items-center gap-3 min-w-0">
                  {img ? (
                    <img
                      src={img}
                      alt=""
                      loading="lazy"
                      className="w-12 h-12 rounded-lg object-cover bg-slate-700 shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-slate-700 shrink-0" />
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
                </Link>
                <button
                  onClick={() => setShareTarget({ id: ex.id, name })}
                  aria-label={t.share.button}
                  className="px-3 text-slate-400 hover:text-keung-500 border-l border-slate-700"
                >📤</button>
              </li>
            );
          })}
        </ul>
      )}

      {shareTarget && userId && (
        <ShareSheet
          title={`${t.share.shareTitle}: ${shareTarget.name}`}
          onClose={() => setShareTarget(null)}
          onConfirm={async (recipientIds) => {
            for (const r of recipientIds) {
              await shareResource('exercise', shareTarget.id, r, userId);
            }
          }}
        />
      )}
    </div>
  );
}
