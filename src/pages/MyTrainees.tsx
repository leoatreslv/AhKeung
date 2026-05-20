import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { useAuth } from '../auth/useAuth';
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { useMyTrainees, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { useInvitations, classifyInvitation, type Invitation, type InvitationStatus } from '../useInvitations';
import { inviteByEmail, cancelInvitation } from '../invitations';

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

      <InviteSection />

      <PendingInvitesSection />

      <DesignationSection title={t.myTrainees.accepted} rows={accepted} chip="bg-emerald-600/30 text-emerald-300 border-emerald-700/50" onRemove={undesignate} canPromote />
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
  title, rows, chip, onRemove, canPromote,
}: {
  title: string;
  rows: { traineeId: string; designatedAt: number }[];
  chip: string;
  onRemove: (traineeId: string) => void;
  canPromote?: boolean;
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
            {canPromote && <PromoteButton traineeId={r.traineeId} />}
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

function PromoteButton({ traineeId }: { traineeId: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | string>('idle');

  async function go() {
    if (status === 'busy' || status === 'done') return;
    if (!confirm(t.myTrainees.promoteConfirm)) return;
    setStatus('busy');
    try {
      const { promoteToTrainer } = await import('../sharing');
      await promoteToTrainer(traineeId);
      setStatus('done');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  if (status === 'done') {
    return <span className="text-[10px] text-emerald-400">{t.myTrainees.promoted}</span>;
  }
  if (status !== 'idle' && status !== 'busy') {
    return <span className="text-[10px] text-rose-400" title={status}>!</span>;
  }
  return (
    <button
      onClick={() => void go()}
      disabled={status === 'busy'}
      className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-keung-600/30 text-keung-300 border-keung-700/50 disabled:opacity-50"
    >
      {status === 'busy' ? '…' : t.myTrainees.promote}
    </button>
  );
}

function TraineeName({ id, className }: { id: string; className?: string }) {
  const name = useDisplayName(id);
  return <span className={className}>{name ?? '…'}</span>;
}

// ─── Invite-by-email ───────────────────────────────────────────────

function InviteSection() {
  const { t } = useI18n();
  const { refresh } = useInvitations();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'already' | 'error'; msg: string } | null>(null);

  async function send() {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await inviteByEmail(trimmed);
      if (!res.ok) {
        const err = res.error ?? '';
        if (/rate limit/i.test(err)) {
          setStatus({ kind: 'error', msg: t.myTrainees.inviteRateLimited });
        } else {
          setStatus({ kind: 'error', msg: `${t.myTrainees.inviteFailed}: ${err}` });
        }
        return;
      }
      if (res.alreadyExisted) {
        setStatus({ kind: 'already', msg: t.myTrainees.inviteAlreadyExisted });
      } else {
        setStatus({ kind: 'ok', msg: t.myTrainees.inviteSent });
      }
      setEmail('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{t.myTrainees.inviteByEmail}</label>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          placeholder={t.myTrainees.inviteEmailPlaceholder}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-base"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !email.trim()}
          className="px-3 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm font-semibold"
        >{busy ? t.myTrainees.inviteSending : t.myTrainees.inviteSend}</button>
      </div>
      {status && (
        <p className={`text-xs mt-2 ${
          status.kind === 'ok'      ? 'text-emerald-400'
          : status.kind === 'already' ? 'text-amber-400'
          :                             'text-rose-400'
        }`}>{status.msg}</p>
      )}
    </div>
  );
}

// ─── Outbound invitations list ─────────────────────────────────────

function PendingInvitesSection() {
  const { t } = useI18n();
  const { list, refresh } = useInvitations();
  if (!list || list.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-slate-400 mb-1.5">{t.myTrainees.pendingInvites}</h3>
      <ul className="space-y-1">
        {list.map((inv) => (
          <InvitationRow key={inv.id} inv={inv} onChange={() => void refresh()} />
        ))}
      </ul>
    </div>
  );
}

function InvitationRow({ inv, onChange }: { inv: Invitation; onChange: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const status = classifyInvitation(inv);
  const statusLabel = statusToLabel(status, t);
  const chipClass = statusToChip(status);

  async function cancel() {
    if (busy) return;
    if (!confirm(t.myTrainees.inviteCancelConfirm)) return;
    setBusy(true);
    try { await cancelInvitation(inv.id); onChange(); }
    finally { setBusy(false); }
  }

  async function resend() {
    if (busy) return;
    setBusy(true);
    try {
      // The Edge Function's on-conflict upsert handles a re-invite:
      // clears cancelled_at, bumps created_at/expires_at, re-issues
      // the auth email.
      await inviteByEmail(inv.email);
      onChange();
    } finally { setBusy(false); }
  }

  const canCancel = status === 'pending';
  const canResend = status === 'pending' || status === 'expired' || status === 'cancelled';

  return (
    <li className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2">
      <span className="flex-1 text-sm truncate" title={inv.email}>{inv.email}</span>
      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${chipClass}`}>{statusLabel}</span>
      {canResend && (
        <button
          type="button"
          onClick={() => void resend()}
          disabled={busy}
          className="text-xs text-keung-500 hover:text-keung-400 disabled:opacity-50 px-1"
        >{t.myTrainees.inviteResend}</button>
      )}
      {canCancel && (
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={busy}
          aria-label={t.myTrainees.inviteCancel}
          className="text-slate-500 hover:text-rose-400 disabled:opacity-50 text-sm px-1"
        >✕</button>
      )}
    </li>
  );
}

function statusToLabel(s: InvitationStatus, t: ReturnType<typeof useI18n>['t']): string {
  switch (s) {
    case 'pending':         return t.myTrainees.inviteStatusPending;
    case 'accepted':        return t.myTrainees.inviteStatusAccepted;
    case 'already-existed': return t.myTrainees.inviteStatusAlreadyExisted;
    case 'cancelled':       return t.myTrainees.inviteStatusCancelled;
    case 'expired':         return t.myTrainees.inviteStatusExpired;
  }
}

function statusToChip(s: InvitationStatus): string {
  switch (s) {
    case 'pending':         return 'bg-amber-600/30 text-amber-300 border-amber-700/50';
    case 'accepted':        return 'bg-emerald-600/30 text-emerald-300 border-emerald-700/50';
    case 'already-existed': return 'bg-slate-600/30 text-slate-300 border-slate-600';
    case 'cancelled':       return 'bg-slate-600/30 text-slate-400 border-slate-600';
    case 'expired':         return 'bg-rose-600/20 text-rose-300 border-rose-700/40';
  }
}
