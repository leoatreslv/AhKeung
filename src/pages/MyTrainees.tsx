import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { useAuth } from '../auth/useAuth';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useMyTrainees, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';

interface ProfileSummary { id: string; display_name: string | null }

export function MyTrainees() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const trainerId = useCurrentUserId();
  const designations = useMyTrainees();
  const { pending, accepted, declined } = partitionByStatus(designations);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ProfileSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  if (profile && !profile.isTrainer) {
    return (
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
          <h2 className="text-lg font-bold">{t.myTrainees.title}</h2>
        </div>
        <p className="text-slate-400 text-sm">{t.myExercises.notATrainerYet}</p>
      </div>
    );
  }

  async function runSearch() {
    const q = search.trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    setSearchError(null);
    // Drop focus from the input so iOS dismisses the keyboard immediately.
    // Otherwise the first tap on a result row just hides the keyboard
    // (because the input had focus) and the click event is swallowed —
    // the user has to tap a second time. Blurring up-front lets the
    // first tap fire the designate handler.
    if (typeof document !== 'undefined') {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === 'function') active.blur();
    }
    try {
      // Trainer RLS allows reading every profile. ILIKE matches case-
      // insensitively against display_name; limit caps the result set.
      const res = await getSupabase().from('profiles')
        .select('id, display_name')
        .ilike('display_name', `%${q}%`)
        .limit(20) as { data: ProfileSummary[] | null; error: { message: string } | null };
      if (res.error) { setSearchError(res.error.message); setResults([]); return; }
      // Filter out self and anyone already designated.
      const known = new Set([trainerId, ...(designations ?? []).map((d) => d.traineeId)]);
      setResults((res.data ?? []).filter((p) => !known.has(p.id)));
    } finally {
      setSearching(false);
    }
  }

  const designate = async (traineeId: string): Promise<void> => {
    if (!trainerId) return;
    // Re-check freshness: if a prior 'declined' row exists, delete it first
    // (a fresh pending row gives the trainee another chance to respond).
    const existing = designations?.find((d) => d.traineeId === traineeId);
    if (existing) {
      await deleteWithSync('trainerTrainees', trainerId, traineeId);
    }
    await putWithSync('trainerTrainees', {
      trainerId, traineeId,
      status: 'pending',
      // eslint-disable-next-line react-hooks/purity -- event handler, not render
      designatedAt: Date.now(),
    }, trainerId);
    setSearch('');
    setResults([]);
  };

  const undesignate = async (traineeId: string): Promise<void> => {
    if (!trainerId) return;
    if (!confirm(t.myTrainees.removeConfirm)) return;
    await deleteWithSync('trainerTrainees', trainerId, traineeId);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/settings')} aria-label="back" className="text-slate-300 text-xl leading-none px-1">←</button>
        <h2 className="text-lg font-bold flex-1">{t.myTrainees.title}</h2>
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.myTrainees.addByName}</label>
        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            placeholder={t.myTrainees.searchPlaceholder}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
          />
          <button
            onClick={() => void runSearch()}
            disabled={searching || !search.trim()}
            className="px-3 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm font-semibold"
          >{searching ? t.myTrainees.searching : t.common.search}</button>
        </div>
        {searchError && <p className="text-rose-400 text-xs mt-1">{searchError}</p>}
        {results.length > 0 && (
          <ul className="mt-2 bg-slate-800 rounded-lg border border-slate-700 divide-y divide-slate-700">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => void designate(p.id)}
                  className="w-full text-left px-3 py-3 min-h-[44px] flex items-center touch-manipulation hover:bg-slate-700 active:bg-slate-600"
                >
                  <span className="flex-1 text-sm">{p.display_name ?? '(no name)'}</span>
                  <span className="text-keung-500 text-sm">+ {t.myTrainees.designate}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {results.length === 0 && search.trim() !== '' && !searching && !searchError && (
          <p className="text-slate-500 text-xs mt-2">{t.myTrainees.noResults}</p>
        )}
      </div>

      <DesignationSection title={t.myTrainees.accepted} rows={accepted} chip="bg-emerald-600/30 text-emerald-300 border-emerald-700/50" onRemove={undesignate} />
      <DesignationSection title={t.myTrainees.pending}  rows={pending}  chip="bg-amber-600/30 text-amber-300 border-amber-700/50"      onRemove={undesignate} />
      <DesignationSection title={t.myTrainees.declined} rows={declined} chip="bg-slate-600/30 text-slate-400 border-slate-600"          onRemove={undesignate} />

      {(designations ?? []).length === 0 && (
        <p className="text-slate-500 text-sm bg-slate-800/50 rounded-lg p-3 text-center">
          {t.myTrainees.empty}
        </p>
      )}
    </div>
  );
}

function DesignationSection({
  title, rows, chip, onRemove,
}: {
  title: string;
  rows: { traineeId: string; designatedAt: number }[];
  chip: string;
  onRemove: (traineeId: string) => void;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-slate-400 mb-1.5">{title}</h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.traineeId} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2">
            <TraineeName id={r.traineeId} className="flex-1 text-sm" />
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${chip}`}>{title}</span>
            <button
              onClick={() => onRemove(r.traineeId)}
              aria-label={t.myTrainees.remove}
              className="text-slate-500 hover:text-rose-400 text-sm px-1"
            >✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TraineeName({ id, className }: { id: string; className?: string }) {
  const name = useDisplayName(id);
  return <span className={className}>{name ?? '…'}</span>;
}
