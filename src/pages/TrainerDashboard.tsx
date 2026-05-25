import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useMyTrainees, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';

export function TrainerDashboard() {
  const { t } = useI18n();
  const designations = useMyTrainees();
  const { pending } = partitionByStatus(designations);

  return (
    <div className="p-4 space-y-6 text-slate-100">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">
          {t.trainerDashboard.pendingTitle}
        </h2>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.trainerDashboard.empty}</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((d) => (
              <PendingRow key={d.traineeId} traineeId={d.traineeId} />
            ))}
          </ul>
        )}
      </section>

      <Link
        to="/trainer/trainees?focus=search"
        className="block text-center bg-keung-600 hover:bg-keung-700 text-white text-sm font-semibold py-2 rounded-lg"
      >
        {t.trainerDashboard.designateButton}
      </Link>
    </div>
  );
}

function PendingRow({ traineeId }: { traineeId: string }) {
  const name = useDisplayName(traineeId);
  return (
    <li className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-sm">
      {name ?? '…'}
    </li>
  );
}
