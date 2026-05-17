import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getSupabase } from '../supabase';
import { db } from '../db';
import { stopSync, flushNow } from '../sync';
import { AuthContext, type AuthState, type Profile } from './useAuth';

const LAST_PROFILE_KEY = 'ahKeung.lastKnownProfile';

async function fetchProfile(userId: string): Promise<Profile | null> {
  const res = await getSupabase().from('profiles').select('id, display_name, is_trainer').eq('id', userId) as { data: { id: string; display_name: string | null; is_trainer: boolean }[] | null };
  const row = res.data?.[0];
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isTrainer: row.is_trainer };
}

/** Sign-out helper. Stops sync first, attempts to drain the queue, optionally
 * confirms data loss, then triggers `auth.signOut()`. The actual Dexie wipe
 * + localStorage clear + state reset happen in the `SIGNED_OUT` handler
 * below — keeping the wipe in exactly one place avoids a race.
 *
 * `confirmFn` lets callers swap a UI confirmation for a stub in tests. */
async function performSignOut(confirmFn: (msg: string) => boolean = window.confirm): Promise<boolean> {
  stopSync();                       // (1) stop timers/listeners so nothing races the wipe
  try { await flushNow(); } catch { /* network down — fall through */ }
  const pending = await db.syncQueue.count();
  if (pending > 0) {
    const ok = confirmFn(`You have ${pending} unsynced change${pending === 1 ? '' : 's'}. Sign out anyway? They will be lost.`);
    if (!ok) return false;
  }
  await getSupabase().auth.signOut();  // fires SIGNED_OUT → handler does the wipe
  return true;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading', user: null, profile: null, signOut: async () => {},
  });
  // Refs so the visibilitychange handler always sees the latest user without
  // re-binding (which would tear down the listener on every state change).
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const { data: { session } } = await getSupabase().auth.getSession();
      if (!session) {
        userIdRef.current = null;
        if (!cancelled) setState((s) => ({ ...s, status: 'unauthenticated', user: null, profile: null }));
        return;
      }
      let profile: Profile | null = null;
      try {
        profile = await fetchProfile(session.user.id);
        if (profile) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(profile));
      } catch {
        // Offline or transient failure — fall back to the cached profile.
        // Guard JSON.parse so corrupt cache (manual tamper, partial write,
        // schema migration) doesn't strand the user on the loading splash.
        const cached = localStorage.getItem(LAST_PROFILE_KEY);
        if (cached) {
          try { profile = JSON.parse(cached) as Profile; }
          catch { localStorage.removeItem(LAST_PROFILE_KEY); profile = null; }
        }
      }
      if (cancelled) return;
      userIdRef.current = session.user.id;
      setState({
        status: 'authenticated',
        user: { id: session.user.id, email: session.user.email ?? '' },
        profile,
        signOut: async () => { await performSignOut(); },
      });
    }

    bootstrap();

    const { data: { subscription } } = getSupabase().auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        // Token expired server-side. We can't drain the queue (no auth) — best
        // effort: stop sync first to avoid a race with the wipe.
        stopSync();
        await db.delete(); await db.open();
        localStorage.removeItem(LAST_PROFILE_KEY);
        userIdRef.current = null;
        setState((s) => ({ ...s, status: 'unauthenticated', user: null, profile: null }));
        return;
      }
      if (event === 'SIGNED_IN' && session) await bootstrap();
    });

    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const userId = userIdRef.current;
      if (!userId) return;
      try {
        const p = await fetchProfile(userId);
        if (p) {
          localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(p));
          setState((s) => ({ ...s, profile: p }));
        }
      } catch { /* offline; ignore */ }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
