import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { getSupabase } from '../supabase';
import { db } from '../db';
import { stopSync, flushNow } from '../sync';
import { log } from '../diagnostics/logger';
import { CATEGORY } from '../diagnostics/categories';
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

/** Inspect the current URL for ?type=invite / ?type=recovery + token_hash,
 *  exchange them via verifyOtp, and strip the params on success. Returns
 *  the link type so AuthProvider can route into the right gate.
 *
 *  PKCE flow (the project's chosen flow type — see src/supabase.ts) does NOT
 *  auto-consume server-issued links because there's no client verifier.
 *  Without this explicit branch the invite/recovery URL silently lands on
 *  Login with no error. */
const VERIFY_OTP_TIMEOUT_MS = 10_000;

async function consumeAuthLink(): Promise<'invite' | 'recovery' | null> {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const type = url.searchParams.get('type');
  const tokenHash = url.searchParams.get('token_hash');
  if (!tokenHash || (type !== 'invite' && type !== 'recovery')) return null;

  // Race verifyOtp against a 10s timeout. Without the timeout, a network
  // blip or a server-side hang would leave the IIFE awaiting forever and
  // the user stuck on the 'loading' screen with no signal. With it, a
  // hung verifyOtp throws, the IIFE's catch flips status to
  // 'unauthenticated', and the user lands on Login where they can
  // recover via "Forgot password?" or ask the trainer to resend.
  let result: { error: { message: string } | null };
  try {
    result = await Promise.race([
      getSupabase().auth.verifyOtp({ type, token_hash: tokenHash }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`verifyOtp timeout after ${VERIFY_OTP_TIMEOUT_MS}ms`)),
          VERIFY_OTP_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    // Treat timeout / network throw the same as a returned error: log
    // it, strip the URL, return null so the IIFE proceeds to getSession
    // (which will see no session and flip to 'unauthenticated').
    url.searchParams.delete('token_hash');
    url.searchParams.delete('type');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    log.error(CATEGORY.auth, 'verifyOtp threw', {
      type, message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  // Strip whether it worked or not — a failed token shouldn't be retried
  // on hard refresh. The UI will report the error via Login state.
  url.searchParams.delete('token_hash');
  url.searchParams.delete('type');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);

  if (result.error) {
    log.error(CATEGORY.auth, 'verifyOtp failed', { type, message: result.error.message });
    return null;
  }
  log.info(CATEGORY.auth, 'verifyOtp ok', { type });
  return type;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading', user: null, profile: null,
    profileFetchError: null, needsPasswordReset: false,
    signOut: async () => {},
    refreshProfile: async () => {},
    clearPasswordReset: () => {},
  });
  // Refs so the visibilitychange handler always sees the latest user without
  // re-binding (which would tear down the listener on every state change).
  const userIdRef = useRef<string | null>(null);
  const needsResetRef = useRef<boolean>(false);

  const refreshProfile = useCallback(async () => {
    const userId = userIdRef.current;
    if (!userId) return;
    try {
      const p = await fetchProfile(userId);
      if (p) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(p));
      setState((s) => ({ ...s, profile: p, profileFetchError: p ? null : s.profileFetchError }));
    } catch (e) {
      setState((s) => ({ ...s, profileFetchError: e instanceof Error ? e.message : 'profile fetch failed' }));
    }
  }, []);

  const clearPasswordReset = useCallback(() => {
    needsResetRef.current = false;
    setState((s) => ({ ...s, needsPasswordReset: false }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let signedInUserId: string | null = null;

    // Establish 'authenticated' for a session and fetch the profile.
    // Used by both the initial getSession() resolution and the SIGNED_IN
    // event handler. Does NOT call any other supabase.auth.* methods —
    // calling them from inside an onAuthStateChange callback can deadlock
    // the SDK's internal auth lock.
    async function applySession(session: { user: { id: string; email?: string } }) {
      if (signedInUserId === session.user.id) return;  // dedupe re-entry
      signedInUserId = session.user.id;
      let profile: Profile | null = null;
      let profileFetchError: string | null = null;
      try {
        profile = await fetchProfile(session.user.id);
        if (profile) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(profile));
      } catch (e) {
        // Fetch failed (likely network). Fall back to cached if we have one
        // so the user can keep using the app offline; otherwise expose the
        // error so the gate doesn't mistake "no profile" for "first-time
        // user" and silently route to onboarding.
        const cached = localStorage.getItem(LAST_PROFILE_KEY);
        if (cached) {
          try { profile = JSON.parse(cached) as Profile; }
          catch { localStorage.removeItem(LAST_PROFILE_KEY); profile = null; }
        }
        if (!profile) profileFetchError = e instanceof Error ? e.message : 'profile fetch failed';
        log.warn(CATEGORY.auth, 'profile fetch failed', {
          message: e instanceof Error ? e.message : String(e),
          usedCache: !!profile,
        });
      }
      if (cancelled) return;
      userIdRef.current = session.user.id;
      setState((s) => ({
        ...s,
        status: 'authenticated',
        user: { id: session.user.id, email: session.user.email ?? '' },
        profile,
        profileFetchError,
        needsPasswordReset: needsResetRef.current,
      }));
    }

    // Initial check: with detectSessionInUrl: true + PKCE, Supabase JS
    // handles the ?code= exchange internally as part of getSession()'s
    // initialize. We just await the result. If a session already exists
    // (persistSession), this resolves immediately. If a fresh exchange is
    // happening, this resolves once it finishes. If no session, we fall
    // through to 'unauthenticated' so the Login screen renders.
    (async () => {
      try {
        // First, check for ?type=invite / ?type=recovery and exchange those
        // explicitly — PKCE doesn't auto-consume them.
        const linkType = await consumeAuthLink();
        if (linkType === 'recovery') {
          needsResetRef.current = true;
        }

        const { data: { session } } = await getSupabase().auth.getSession();
        // Clean ?code= from the URL once the exchange is resolved (success
        // or otherwise) so a hard reload doesn't try to consume it again.
        const url = new URL(window.location.href);
        if (url.searchParams.has('code')) {
          url.searchParams.delete('code');
          window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        }
        if (!session) {
          userIdRef.current = null;
          if (!cancelled) setState((s) => ({
            ...s, status: 'unauthenticated', user: null, profile: null,
            profileFetchError: null, needsPasswordReset: false,
          }));
          return;
        }
        await applySession(session);
      } catch {
        // Bootstrap threw (network, bad code exchange, etc.) — fall through
        // to the Login screen so the user can retry.
        if (!cancelled) {
          userIdRef.current = null;
          setState((s) => ({
            ...s, status: 'unauthenticated', user: null, profile: null,
            profileFetchError: null, needsPasswordReset: false,
          }));
        }
      }
    })();

    const { data: { subscription } } = getSupabase().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        // Token expired server-side. We can't drain the queue (no auth) — best
        // effort: stop sync first to avoid a race with the wipe.
        stopSync();
        signedInUserId = null;
        needsResetRef.current = false;
        (async () => {
          try { await db.delete(); await db.open(); } catch { /* tolerate */ }
          localStorage.removeItem(LAST_PROFILE_KEY);
          userIdRef.current = null;
          if (!cancelled) setState((s) => ({
            ...s, status: 'unauthenticated', user: null, profile: null,
            profileFetchError: null, needsPasswordReset: false,
          }));
        })();
        return;
      }
      if (event === 'SIGNED_IN' && session) {
        // Don't await inside the listener — that re-enters the SDK's lock.
        // applySession does not call any auth.* methods, so it's safe to
        // fire and forget here.
        void applySession(session);
      }
    });

    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const userId = userIdRef.current;
      if (!userId) return;
      try {
        const p = await fetchProfile(userId);
        if (p) {
          localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(p));
          setState((s) => ({ ...s, profile: p, profileFetchError: null }));
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

  // Wire the latest callbacks into state. (signOut is stable so we set it
  // inline; refreshProfile / clearPasswordReset can be recreated per render
  // safely — they're tiny callbacks.)
  useEffect(() => {
    setState((s) => ({
      ...s,
      signOut: async () => { await performSignOut(); },
      refreshProfile,
      clearPasswordReset,
    }));
  }, [refreshProfile, clearPasswordReset]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
