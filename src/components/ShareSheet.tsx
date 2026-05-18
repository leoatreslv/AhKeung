// Multi-select bottom sheet for picking which accepted trainees to share
// with. Reused by exercises, bundles, and plans. Returns the selected
// trainee ids via onConfirm; caller handles the actual share writes.

import { useState } from 'react';
import { useI18n } from '../i18n';
import { useMyTrainees, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';

export function ShareSheet({
  title,
  onConfirm,
  onClose,
}: {
  title: string;
  onConfirm: (recipientIds: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const designations = useMyTrainees();
  const { accepted } = partitionByStatus(designations);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (selected.size === 0) return;
    setConfirming(true);
    try {
      await onConfirm([...selected]);
      onClose();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-30 flex items-end" onClick={onClose}>
      <div
        className="w-full max-w-md mx-auto bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-slate-800 flex items-center">
          <h3 className="font-bold flex-1">{title}</h3>
          <button onClick={onClose} className="text-slate-400 text-xl leading-none">×</button>
        </div>

        {accepted.length === 0 ? (
          <div className="p-6 text-center text-slate-400 text-sm">
            <p>{t.share.noAcceptedTrainees}</p>
          </div>
        ) : (
          <ul className="overflow-y-auto flex-1 divide-y divide-slate-800">
            {accepted.map((d) => (
              <li key={d.traineeId}>
                <button
                  onClick={() => toggle(d.traineeId)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-800"
                >
                  <span className={`w-5 h-5 rounded border ${selected.has(d.traineeId) ? 'bg-keung-600 border-keung-600' : 'border-slate-600'} flex items-center justify-center text-xs text-white`}>
                    {selected.has(d.traineeId) ? '✓' : ''}
                  </span>
                  <TraineeName id={d.traineeId} className="flex-1 text-sm" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="p-3 border-t border-slate-800 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-2.5 rounded-lg"
          >{t.common.cancel}</button>
          <button
            onClick={() => void confirm()}
            disabled={selected.size === 0 || confirming}
            className="flex-1 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white py-2.5 rounded-lg font-semibold"
          >{confirming ? t.share.sharing : t.share.shareWithCount(selected.size)}</button>
        </div>
      </div>
    </div>
  );
}

function TraineeName({ id, className }: { id: string; className?: string }) {
  const name = useDisplayName(id);
  return <span className={className}>{name ?? '…'}</span>;
}
