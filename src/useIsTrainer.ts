// Look up a user's `is_trainer` flag with a tiny module-level cache
// so repeated renders during a session don't re-hit Supabase. Mirrors
// useDisplayName's caching pattern.
//
// Resolves via the `trainer_names` view (granted to every
// authenticated user) — a row exists iff the user is a trainer.
// We don't need to read the `is_trainer` column directly because
// the view's WHERE clause already encodes it.

import { useEffect, useState } from 'react';
import { getSupabase } from './supabase';

const CACHE = new Map<string, boolean>();

async function fetchIsTrainer(userId: string): Promise<boolean> {
  const res = await getSupabase()
    .from('trainer_names').select('id').eq('id', userId).limit(1) as
    { data: { id: string }[] | null };
  return (res.data?.length ?? 0) > 0;
}

export function useIsTrainer(userId: string | undefined): boolean | undefined {
  const cached = userId ? CACHE.get(userId) : undefined;
  const [fetched, setFetched] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;
    if (CACHE.has(userId)) return;
    let cancelled = false;
    void fetchIsTrainer(userId).then((v) => {
      CACHE.set(userId, v);
      if (!cancelled) setFetched(v);
    });
    return () => { cancelled = true; };
  }, [userId]);

  return cached ?? fetched;
}

/** Write-through cache setter for callers that have just changed
 *  someone's trainer status (e.g. the PromoteButton after a
 *  successful promote_to_trainer RPC). Without this, the cache
 *  keeps the stale `false` and any later component mount shows
 *  the Promote button again until the page reloads. */
export function setIsTrainerCache(userId: string, value: boolean): void {
  CACHE.set(userId, value);
}