// Trainee-side banner that surfaces pending trainer designations on
// Home. Renders nothing when there are no pending rows. Accept flips
// status → 'accepted' (share visibility kicks in immediately via RLS);
// Decline flips to 'declined' (sticky — the trainer must remove the row
// before re-designating).

import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { useMyTrainers, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';
import { db, type DesignationStatus } from '../db';

export function DesignationBanner() {
  const { t } = useI18n();
  const trainers = useMyTrainers();
  const { pending } = partitionByStatus(trainers);
  if (pending.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.designation.pendingTitle}</h2>
      <ul className="space-y-2">
        {pending.map((d) => (
          <DesignationRow key={d.trainerId} trainerId={d.trainerId} />
        ))}
      </ul>
    </section>
  );
}

function DesignationRow({ trainerId }: { trainerId: string }) {
  const { t } = useI18n();
  const name = useDisplayName(trainerId);
  const [busy, setBusy] = useState(false);

  async function respond(status: DesignationStatus) {
    if (busy) return;
    setBusy(true);
    try {
      // The trainee may only update status + responded_at (server RLS).
      // We update via the Supabase client directly; sync queue picks it
      // up on next pull. Updating Dexie too keeps the UI snappy.
      const { error } = await getSupabase().from('trainer_trainees')
        .update({ status, responded_at: new Date().toISOString() })
        .eq('trainer_id', trainerId)
        .eq('trainee_id', (await getSupabase().auth.getSession()).data.session!.user.id) as
        { error: { message: string } | null };
      if (error) { setBusy(false); return; }
      await db.trainerTrainees
        .where('[trainerId+traineeId]')
        .equals([trainerId, (await getSupabase().auth.getSession()).data.session!.user.id])
        .modify({ status, respondedAt: Date.now(), updatedAt: Date.now() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="bg-slate-800 rounded-xl border border-amber-700/40 p-3">
      <p className="text-sm">
        <span className="font-semibold">{name ?? '…'}</span>
        <span className="text-slate-300"> {t.designation.wantsToTrain}</span>
      </p>
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => void respond('accepted')}
          disabled={busy}
          className="flex-1 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white text-sm py-2 rounded-lg font-semibold"
        >{t.designation.accept}</button>
        <button
          onClick={() => void respond('declined')}
          disabled={busy}
          className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 text-sm py-2 rounded-lg"
        >{t.designation.decline}</button>
      </div>
    </li>
  );
}
