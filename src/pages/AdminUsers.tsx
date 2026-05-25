import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { promoteToTrainer, promoteToAdmin } from '../sharing';

interface UserRow { id: string; display_name: string | null; is_trainer: boolean; is_admin: boolean }

export function AdminUsers() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<UserRow[]>([]);
  const [searching, setSearching] = useState(false);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    try {
      const res = await getSupabase().from('profiles')
        .select('id, display_name, is_trainer, is_admin')
        .ilike('display_name', `%${q.trim()}%`)
        .limit(50) as { data: UserRow[] | null; error: { message: string } | null };
      setRows(res.data ?? []);
    } finally {
      setSearching(false);
    }
  }

  function applyPromotion(id: string, what: 'trainer' | 'admin') {
    setRows((prev) => prev.map((r) =>
      r.id === id ? { ...r, is_trainer: what === 'trainer' ? true : r.is_trainer, is_admin: what === 'admin' ? true : r.is_admin } : r
    ));
  }

  return (
    <div className="p-4 space-y-4 text-slate-100">
      <form onSubmit={runSearch} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.adminUsers.searchPlaceholder}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
        />
        <button
          type="submit"
          disabled={searching}
          className="px-3 py-2 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm"
        >{searching ? '…' : t.common.search.replace('…', '')}</button>
      </form>

      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm">{t.adminUsers.empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((u) => <UserRowItem key={u.id} u={u} onPromote={applyPromotion} />)}
        </ul>
      )}
    </div>
  );
}

function UserRowItem({ u, onPromote }: { u: UserRow; onPromote: (id: string, what: 'trainer'|'admin') => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<null | 'trainer' | 'admin'>(null);

  async function doPromote(what: 'trainer' | 'admin') {
    const msg = what === 'trainer' ? t.adminUsers.confirmPromoteTrainer : t.adminUsers.confirmPromoteAdmin;
    if (!confirm(msg)) return;
    setBusy(what);
    try {
      if (what === 'trainer') await promoteToTrainer(u.id);
      else                    await promoteToAdmin(u.id);
      onPromote(u.id, what);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2 text-sm">
      <span className="flex-1 truncate">{u.display_name ?? '(no name)'}</span>
      {u.is_trainer && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-keung-600/30 border-keung-600/60 text-keung-300">{t.adminUsers.badgeTrainer}</span>}
      {u.is_admin   && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-amber-600/30 border-amber-600/60 text-amber-300">{t.adminUsers.badgeAdmin}</span>}
      {!u.is_trainer && (
        <button onClick={() => void doPromote('trainer')} disabled={busy !== null}
          className="text-[11px] text-slate-300 hover:text-white disabled:opacity-50">
          {busy === 'trainer' ? '…' : t.adminUsers.promoteTrainer}
        </button>
      )}
      {!u.is_admin && (
        <button onClick={() => void doPromote('admin')} disabled={busy !== null}
          className="text-[11px] text-slate-300 hover:text-white disabled:opacity-50">
          {busy === 'admin' ? '…' : t.adminUsers.promoteAdmin}
        </button>
      )}
    </li>
  );
}
