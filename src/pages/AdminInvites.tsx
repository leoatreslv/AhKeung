import { useEffect, useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { inviteByEmail, cancelInvitation } from '../invitations';

interface InvitationRow {
  id: string;
  email: string;
  inviter_id: string;
  created_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  designated_at: string | null;
}

export function AdminInvites() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getSupabase().from('invitations')
        .select('id, email, inviter_id, created_at, accepted_at, cancelled_at, designated_at')
        .order('created_at', { ascending: false })
        .limit(100) as { data: InvitationRow[] | null; error: { message: string } | null };
      if (!cancelled) setRows(res.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [reloadAt]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email || sending) return;
    setSending(true);
    setToast(null);
    const result = await inviteByEmail(email.trim());
    setSending(false);
    if (result.ok) {
      setToast(result.alreadyExisted ? t.adminInvites.alreadyExistedToast : t.adminInvites.sentToast);
      setEmail('');
      setReloadAt(Date.now());
    } else {
      setToast(t.adminInvites.failedToast + (result.error ?? 'unknown'));
    }
  }

  async function onCancel(id: string) {
    await cancelInvitation(id);
    setReloadAt(Date.now());
  }

  async function onResend(emailToResend: string) {
    setToast(null);
    const result = await inviteByEmail(emailToResend);
    if (result.ok) {
      setToast(result.alreadyExisted ? t.adminInvites.alreadyExistedToast : t.adminInvites.sentToast);
      setReloadAt(Date.now());
    } else {
      setToast(t.adminInvites.failedToast + (result.error ?? 'unknown'));
    }
  }

  const pending = (rows ?? []).filter((r) => !r.accepted_at && !r.cancelled_at);
  const awaiting = (rows ?? []).filter((r) => r.accepted_at && !r.cancelled_at && !r.designated_at);

  return (
    <div className="p-4 space-y-6 text-slate-100">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.sendTitle}</h2>
        <form onSubmit={onSend} className="flex gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder={t.adminInvites.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          />
          <button
            type="submit"
            disabled={!email || sending}
            className="px-3 py-2 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm"
          >{sending ? '…' : t.adminInvites.sendButton}</button>
        </form>
        {toast && <p className="text-xs text-slate-400 mt-2">{toast}</p>}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.pendingTitle}</h2>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.adminInvites.pendingEmpty}</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((r) => (
              <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{r.email}</span>
                <button onClick={() => void onResend(r.email)} className="text-[11px] text-slate-300 hover:text-white">
                  {t.adminInvites.resend}
                </button>
                <button onClick={() => void onCancel(r.id)} className="text-[11px] text-rose-300 hover:text-rose-200">
                  {t.adminInvites.cancel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.awaitingTitle}</h2>
        {awaiting.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.adminInvites.awaitingEmpty}</p>
        ) : (
          <ul className="space-y-1">
            {awaiting.map((r) => (
              <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-sm truncate">
                {r.email}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
