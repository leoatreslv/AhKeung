import { useEffect, useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';

interface AuditRow {
  id: string;
  user_id: string;
  event_type: string;
  resource: unknown;
  metadata: unknown;
  created_at: string;
}

const PAGE = 50;

type FilterKey = 'invite' | 'designation' | 'promotion' | 'share' | 'sync';

// Map filter chip → which event_type prefixes to keep when active.
const FILTER_PREFIXES: Record<FilterKey, string[]> = {
  invite:      ['invite.'],
  designation: ['designation.'],
  promotion:   ['trainer.promoted', 'admin.promoted'],
  share:       ['share.'],
  sync:        ['sync.'],
};

export function AdminAudit() {
  const { t } = useI18n();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [active, setActive] = useState<Set<FilterKey>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getSupabase().from('audit_events')
        .select('id, user_id, event_type, resource, metadata, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1) as { data: AuditRow[] | null };
      if (!cancelled) setRows(res.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [offset]);

  function toggle(k: FilterKey) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  const visible = active.size === 0 ? rows : rows.filter((r) => {
    for (const k of active) {
      if (FILTER_PREFIXES[k].some((p) => r.event_type.startsWith(p) || r.event_type === p)) return true;
    }
    return false;
  });

  return (
    <div className="p-4 space-y-3 text-slate-100">
      <h2 className="text-lg font-bold">{t.adminAudit.title}</h2>

      <div className="flex flex-wrap gap-1">
        {(Object.keys(FILTER_PREFIXES) as FilterKey[]).map((k) => {
          const on = active.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              className={
                'text-[11px] px-2 py-0.5 rounded-full border ' +
                (on ? 'bg-keung-600/30 border-keung-600/60 text-keung-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400')
              }
            >{t.adminAudit.filters[k]}</button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="text-slate-500 text-sm">{t.adminAudit.empty}</p>
      ) : (
        <ul className="space-y-1">
          {visible.map((r) => (
            <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                className="w-full text-left flex items-center gap-2"
              >
                <span className="text-slate-500 tabular-nums">{new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)}</span>
                <span className="font-mono">{r.event_type}</span>
              </button>
              {expandedId === r.id && (
                <pre className="mt-2 text-[10px] text-slate-300 whitespace-pre-wrap break-words">
{JSON.stringify({ user_id: r.user_id, resource: r.resource, metadata: r.metadata }, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => setOffset(Math.max(0, offset - PAGE))}
          disabled={offset === 0}
          className="text-xs text-slate-400 disabled:opacity-30"
        >{t.adminAudit.newer}</button>
        <button
          type="button"
          onClick={() => setOffset(offset + PAGE)}
          disabled={rows.length < PAGE}
          className="text-xs text-slate-400 disabled:opacity-30"
        >{t.adminAudit.older}</button>
      </div>
    </div>
  );
}
