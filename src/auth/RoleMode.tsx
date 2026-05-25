import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Profile } from './useAuth';

export type Mode = 'trainee' | 'trainer' | 'admin';

export const ROLE_MODE_STORAGE_KEY = 'ahkeung:roleMode';

interface RoleModeContextValue {
  mode: Mode;
  availableModes: Mode[];
  setMode: (m: Mode) => void;          // explicit; persists to localStorage
  setModeTransient: (m: Mode) => void; // implicit; in-memory only
}

const RoleModeContext = createContext<RoleModeContextValue | null>(null);

function deriveAvailable(profile: Profile): Mode[] {
  const out: Mode[] = ['trainee'];
  if (profile.isTrainer) out.push('trainer');
  if (profile.isAdmin)   out.push('admin');
  return out;
}

function readStoredMode(available: Mode[]): Mode {
  try {
    const raw = localStorage.getItem(ROLE_MODE_STORAGE_KEY);
    if (raw && (available as string[]).includes(raw)) return raw as Mode;
  } catch { /* localStorage unavailable */ }
  return 'trainee';
}

export function RoleModeProvider({ profile, children }: { profile: Profile; children: ReactNode }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only the flags affect the result; depending on the whole profile would rerun on every displayName edit
  const availableModes = useMemo(() => deriveAvailable(profile), [profile.isTrainer, profile.isAdmin]);
  const [mode, setModeState] = useState<Mode>(() => readStoredMode(availableModes));

  const setMode = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setModeState(m);
    try { localStorage.setItem(ROLE_MODE_STORAGE_KEY, m); } catch { /* ignore */ }
  }, [availableModes]);

  const setModeTransient = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setModeState(m);
  }, [availableModes]);

  // Mid-session demotion: if availableModes no longer includes the current
  // mode, fall back to trainee and clear the persisted preference.
  useEffect(() => {
    if (!availableModes.includes(mode)) {
      setModeState('trainee');
      try { localStorage.removeItem(ROLE_MODE_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [availableModes, mode]);

  const value = useMemo<RoleModeContextValue>(() => ({
    mode, availableModes, setMode, setModeTransient,
  }), [mode, availableModes, setMode, setModeTransient]);

  return <RoleModeContext.Provider value={value}>{children}</RoleModeContext.Provider>;
}

export function useRoleMode(): RoleModeContextValue {
  const v = useContext(RoleModeContext);
  if (!v) throw new Error('useRoleMode must be used inside <RoleModeProvider>');
  return v;
}
