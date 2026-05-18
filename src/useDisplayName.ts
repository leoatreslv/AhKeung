// Look up a profile's display_name with a tiny module-level cache so
// repeated renders during a session don't re-hit Supabase. Trainer RLS
// allows reading every profile; trainees only see profiles in their own
// trainer_trainees graph (the row is rejected silently otherwise and the
// fallback short-id renders).

import { useEffect, useState } from 'react';
import { getSupabase } from './supabase';

const CACHE = new Map<string, string>();

export function useDisplayName(userId: string | undefined): string | undefined {
  // Synchronously read from cache so callers don't see a flash of '…' for
  // names already fetched this session.
  const cached = userId ? CACHE.get(userId) : undefined;
  const [fetched, setFetched] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;
    if (CACHE.has(userId)) return;
    let cancelled = false;
    void getSupabase().from('profiles').select('display_name').eq('id', userId).limit(1)
      .then((res: { data: { display_name: string | null }[] | null }) => {
        const dn = res.data?.[0]?.display_name ?? userId.slice(0, 8);
        CACHE.set(userId, dn);
        if (!cancelled) setFetched(dn);
      });
    return () => { cancelled = true; };
  }, [userId]);

  return cached ?? fetched;
}
