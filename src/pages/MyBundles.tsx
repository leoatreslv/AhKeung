import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useI18n } from '../i18n';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useAuth } from '../auth/useAuth';
import { ShareSheet } from '../components/ShareSheet';
import { shareResource } from '../sharing';

export function MyBundles() {
  const { t } = useI18n();
  const userId = useCurrentUserId();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);

  const bundles = useLiveQuery(
    async () => {
      if (!userId) return [];
      const rows = await db.exerciseBundles
        .where('ownerId').equals(userId)
        .and((b) => !b.deletedAt)
        .toArray();
      return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    },
    [userId],
  );

  const counts = useLiveQuery(
    async () => {
      if (!bundles || bundles.length === 0) return new Map<string, number>();
      const m = new Map<string, number>();
      for (const b of bundles) {
        const n = await db.exerciseBundleItems.where('bundleId').equals(b.id).count();
        m.set(b.id, n);
      }
      return m;
    },
    [bundles],
  );

  if (profile && !profile.isTrainer) {
    return (
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
          <h2 className="text-lg font-bold">{t.myBundles.title}</h2>
        </div>
        <p className="text-slate-400 text-sm">{t.myExercises.notATrainerYet}</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
        <h2 className="text-lg font-bold flex-1">{t.myBundles.title}</h2>
        <Link
          to="/trainer/bundles/new"
          className="bg-keung-600 hover:bg-keung-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold"
        >
          {t.myBundles.newButton}
        </Link>
      </div>

      {!bundles ? (
        <p className="text-slate-400 text-sm">{t.common.loading}</p>
      ) : bundles.length === 0 ? (
        <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
          {t.myBundles.empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {bundles.map((b) => (
            <li key={b.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden flex items-stretch">
              <Link to={`/bundles/${b.id}`} className="flex-1 p-3 min-w-0">
                <div className="font-semibold text-sm">{b.name}</div>
                {b.description && (
                  <div className="text-xs text-slate-400 truncate">{b.description}</div>
                )}
                <div className="text-xs text-slate-500 mt-1">
                  {t.myBundles.exerciseCount(counts?.get(b.id) ?? 0)}
                </div>
              </Link>
              <button
                onClick={() => setShareTarget({ id: b.id, name: b.name })}
                aria-label={t.share.button}
                className="px-3 text-slate-400 hover:text-keung-500 border-l border-slate-700"
              >📤</button>
            </li>
          ))}
        </ul>
      )}

      {shareTarget && userId && (
        <ShareSheet
          title={`${t.share.shareTitle}: ${shareTarget.name}`}
          onClose={() => setShareTarget(null)}
          onConfirm={async (recipientIds) => {
            for (const r of recipientIds) {
              await shareResource('bundle', shareTarget.id, r, userId);
            }
          }}
        />
      )}
    </div>
  );
}
