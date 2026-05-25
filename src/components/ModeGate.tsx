import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useRoleMode, type Mode } from '../auth/RoleMode';

export function ModeGate({ allowedIn, children }: { allowedIn: Mode[]; children: ReactNode }) {
  const { mode, availableModes, setModeTransient } = useRoleMode();

  const isAllowed = allowedIn.includes(mode);
  const switchable = !isAllowed && allowedIn.find((m) => availableModes.includes(m));

  useEffect(() => {
    if (switchable) setModeTransient(switchable);
  }, [switchable, setModeTransient]);

  if (isAllowed) return <>{children}</>;
  if (switchable) return null; // brief render before the effect flips mode
  return <Navigate to="/" replace />;
}
