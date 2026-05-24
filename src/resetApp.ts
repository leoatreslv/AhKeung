// User-triggered "nuke everything client-side and start fresh" flow.
//
// Reachable from three places:
//   - Loading screen (after 12s) — handles users stuck on bootstrap.
//   - Onboarding screen — handles users who feel something is "off"
//     mid-onboarding (e.g. stale data from a prior installation).
//   - Login screen's troubleshooting <details> — recovery escape hatch.
//
// What it wipes:
//   - The main Dexie database `ah-keung` (sync queue, exercises,
//     plans, trainer_trainees, etc.). The diagnostics DB
//     `ah-keung-diagnostics` is INTENTIONALLY kept so post-reset
//     reports still capture what happened before.
//   - localStorage keys: the cached profile + every Supabase session
//     token (`sb-*-auth-token`). Locale preference is preserved.
//   - All `caches.*` API entries (Workbox precache, exercise-images
//     runtime cache). Without this step, SW unregister is theatre —
//     the browser would just serve the old `index.html` and JS
//     chunks from cache after reload.
//   - Every registered service worker.
//
// Final step: a hard `window.location.replace('/')` reload so the
// page reboots from a known-good network fetch.

import { db } from './db';
import { stopSync } from './sync';
import { LAST_PROFILE_KEY } from './auth/AuthProvider';

export interface ResetAppDeps {
  // Injectable for tests — production calls pass nothing and use the
  // real browser globals.
  localStorage?: Storage;
  caches?: CacheStorage;
  serviceWorker?: ServiceWorkerContainer;
  location?: { replace: (url: string) => void };
}

export async function resetApp(deps: ResetAppDeps = {}): Promise<void> {
  const ls = deps.localStorage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  const cs = deps.caches ?? (typeof globalThis !== 'undefined' ? globalThis.caches : undefined);
  const sw = deps.serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
  const loc = deps.location ?? (typeof window !== 'undefined' ? window.location : undefined);

  // 1. Stop timers/listeners first so nothing races the Dexie wipe.
  stopSync();

  // 2. Wipe the main Dexie DB (`ah-keung`). Open it again so any in-
  // flight component reads against the `db` import don't blow up
  // between this line and the reload below.
  try {
    await db.delete();
    await db.open();
  } catch (e) {
    console.warn('[resetApp] dexie wipe failed:', e instanceof Error ? e.message : String(e));
  }

  // 3. localStorage: clear the cached profile + every supabase-js
  // session token. supabase-js stores tokens under keys shaped like
  // `sb-<project-ref>-auth-token`. Collect keys first, then delete —
  // mutating during iteration breaks Storage's index-based access.
  if (ls) {
    try {
      ls.removeItem(LAST_PROFILE_KEY);
      const sbKeys: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) sbKeys.push(k);
      }
      for (const k of sbKeys) ls.removeItem(k);
    } catch (e) {
      console.warn('[resetApp] localStorage clear failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // 4. Cache Storage API — wipe Workbox's precache + the
  // exercise-images runtime cache. WITHOUT this step the SW
  // unregister below is cosmetic: the next page load gets the same
  // stale index.html from cache and we're back where we started.
  if (cs) {
    try {
      const names = await cs.keys();
      await Promise.all(names.map((n) => cs.delete(n)));
    } catch (e) {
      console.warn('[resetApp] caches clear failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // 5. Unregister every service worker. Combined with the caches
  // clear above, the next load fetches fresh assets from the
  // network.
  if (sw) {
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch (e) {
      console.warn('[resetApp] sw unregister failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // 6. Hard reload. `replace('/')` rather than `assign('/')` so the
  // current entry is replaced in history — back button can't return
  // to the broken state.
  if (loc) loc.replace('/');
}
