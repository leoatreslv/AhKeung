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
  // `storedMode` is the user's *preference* (what they last picked via the
  // switcher). The *effective* `mode` below is derived: if the preference
  // is still in `availableModes`, use it; otherwise fall back to trainee.
  // This split lets us avoid setState-in-effect for the demotion case —
  // the derivation handles it during render, and an effect only does the
  // external-system side effect (localStorage cleanup).
  const [storedMode, setStoredMode] = useState<Mode>(() => readStoredMode(availableModes));
  const mode: Mode = availableModes.includes(storedMode) ? storedMode : 'trainee';

  const setMode = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setStoredMode(m);
    try { localStorage.setItem(ROLE_MODE_STORAGE_KEY, m); } catch { /* ignore */ }
  }, [availableModes]);

  const setModeTransient = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setStoredMode(m);
  }, [availableModes]);

  // Mid-session demotion: when the stored preference is no longer in
  // availableModes (e.g. admin demoted us while we were active), clear
  // the localStorage entry. The effective `mode` already fell back to
  // 'trainee' via the derivation above, so no setState is needed here —
  // only the external-system sync.
  useEffect(() => {
    if (!availableModes.includes(storedMode)) {
      try { localStorage.removeItem(ROLE_MODE_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [availableModes, storedMode]);

  const value = useMemo<RoleModeContextValue>(() => ({
    mode, availableModes, setMode, setModeTransient,
  }), [mode, availableModes, setMode, setModeTransient]);

  return <RoleModeContext.Provider value={value}>{children}</RoleModeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- hook lives next to its provider; splitting would only help HMR
export function useRoleMode(): RoleModeContextValue {
  const v = useContext(RoleModeContext);
  if (!v) throw new Error('useRoleMode must be used inside <RoleModeProvider>');
  return v;
}
