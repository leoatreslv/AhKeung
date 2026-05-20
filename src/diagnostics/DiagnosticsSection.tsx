// Diagnostics panel embedded in Settings. Collapsible by default.
//
// View: shows the last 100 entries from the persistent ring buffer.
// Copy: serialises the full buffer to JSON and writes to the clipboard.
// Send: POSTs to the submit-diagnostics Edge Function; on success
//   prominently displays the short_code the user reads back to support.
// Clear: wipes the buffer locally (after confirmation).

import { useState } from 'react';
import { useI18n } from '../i18n';
import { recentLog, clearLog, type LogEntry } from './logger';
import { submitDiagnostics } from './submit';

const VIEW_LIMIT = 100;

export function DiagnosticsSection() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [sendStatus, setSendStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'ok'; shortCode: string }
    | { kind: 'error'; msg: string }
  >({ kind: 'idle' });
  const [notes, setNotes] = useState('');

  async function refresh() {
    const all = await recentLog();
    setEntries(all.slice(0, VIEW_LIMIT));
    setTotalCount(all.length);
  }

  async function onExpand() {
    setExpanded(true);
    await refresh();
  }

  async function onCopy() {
    const all = await recentLog();
    const text = JSON.stringify(all);
    await navigator.clipboard.writeText(text);
  }

  async function onSend() {
    setSendStatus({ kind: 'busy' });
    const res = await submitDiagnostics({ notes: notes.trim() || undefined });
    if (res.ok && res.shortCode) {
      setSendStatus({ kind: 'ok', shortCode: res.shortCode });
      setNotes('');
    } else {
      setSendStatus({ kind: 'error', msg: res.error ?? 'unknown error' });
    }
  }

  async function onClear() {
    if (!confirm(t.diagnostics.clearConfirm)) return;
    await clearLog();
    await refresh();
  }

  if (!expanded) {
    return (
      <div className="border-t border-slate-800 pt-4">
        <button
          type="button"
          onClick={() => void onExpand()}
          className="text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300"
        >{t.diagnostics.viewLink}</button>
      </div>
    );
  }

  return (
    <div className="border-t border-slate-800 pt-4 space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wider text-slate-500">{t.diagnostics.title}</p>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs text-slate-400 hover:text-slate-300"
        >{t.diagnostics.hide}</button>
      </div>

      <p className="text-xs text-slate-500">
        {t.diagnostics.summary(entries?.length ?? 0, totalCount)}
      </p>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-2 max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {entries?.length === 0 ? (
          <p className="text-slate-500 italic">{t.diagnostics.empty}</p>
        ) : (
          (entries ?? []).map((e, i) => <EntryRow key={i} entry={e} />)
        )}
      </div>

      <div>
        <label className="text-xs text-slate-400 block mb-1">{t.diagnostics.notesLabel}</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder={t.diagnostics.notesPlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onCopy()}
          className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded"
        >{t.diagnostics.copy}</button>
        <button
          type="button"
          onClick={() => void onSend()}
          disabled={sendStatus.kind === 'busy'}
          className="px-3 py-1.5 text-xs bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white rounded"
        >{sendStatus.kind === 'busy' ? t.diagnostics.sending : t.diagnostics.send}</button>
        <button
          type="button"
          onClick={() => void onClear()}
          className="px-3 py-1.5 text-xs bg-rose-900/40 border border-rose-800 text-rose-300 rounded"
        >{t.diagnostics.clear}</button>
      </div>

      {sendStatus.kind === 'ok' && (
        <div className="bg-emerald-900/30 border border-emerald-700/50 text-emerald-200 text-xs rounded p-2">
          <p className="mb-1">{t.diagnostics.sentSuccess}</p>
          <p className="font-mono text-base tracking-widest">{sendStatus.shortCode}</p>
          <p className="text-[10px] text-emerald-400/80 mt-1">{t.diagnostics.sentHelp}</p>
        </div>
      )}
      {sendStatus.kind === 'error' && (
        <p className="text-rose-400 text-xs">{t.diagnostics.sendFailed}: {sendStatus.msg}</p>
      )}
    </div>
  );
}

function EntryRow({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString();
  const levelColor =
    entry.level === 'error' ? 'text-rose-400'
    : entry.level === 'warn'  ? 'text-amber-400'
    :                           'text-slate-400';
  return (
    <div className="border-b border-slate-800/50 py-1 last:border-b-0">
      <div>
        <span className="text-slate-500">{time}</span>{' '}
        <span className={`uppercase ${levelColor}`}>{entry.level}</span>{' '}
        <span className="text-slate-400">{entry.category}</span>{' '}
        <span className="text-slate-200">{entry.message}</span>
      </div>
      {entry.context && Object.keys(entry.context).length > 0 && (
        <div className="text-slate-500 pl-4 break-all">{JSON.stringify(entry.context)}</div>
      )}
      {entry.errorStack && (
        <pre className="text-slate-600 pl-4 whitespace-pre-wrap text-[10px]">{entry.errorStack}</pre>
      )}
    </div>
  );
}
