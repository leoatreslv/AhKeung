import { useNavigate } from 'react-router-dom';
import { useRoleMode, type Mode } from '../auth/RoleMode';
import { useI18n } from '../i18n';

const DEFAULT_ROUTE_BY_MODE: Record<Mode, string> = {
  trainee: '/',
  trainer: '/trainer',
  admin:   '/admin/invites',
};

const ICON_BY_MODE: Record<Mode, string> = {
  trainee: '👤', trainer: '🏋️', admin: '🛡️',
};

export function ModeSwitcher() {
  const { mode, availableModes, setMode } = useRoleMode();
  const { t } = useI18n();
  const navigate = useNavigate();

  if (availableModes.length <= 1) return null;

  return (
    <div data-testid="mode-switcher" className="flex items-center bg-slate-800 rounded-full border border-slate-700 text-[11px]">
      {availableModes.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              navigate(DEFAULT_ROUTE_BY_MODE[m]);
            }}
            className={
              'px-2 py-1 rounded-full transition-colors ' +
              (active ? 'bg-keung-600 text-white' : 'text-slate-300 hover:text-white')
            }
          >
            <span className="mr-1">{ICON_BY_MODE[m]}</span>
            {t.modeSwitcher[m]}
          </button>
        );
      })}
    </div>
  );
}
