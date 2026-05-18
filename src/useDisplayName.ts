// Look up a user's display_name with a tiny module-level cache so
// repeated renders during a session don't re-hit Supabase.
//
// Profile visibility:
//   - profiles RLS grants SELECT to self OR is_trainer().
//   - trainer_names view is granted to every authenticated user.
// So a trainee looking up their own trainer's name can't reach
// profiles (the trainer is someone else's profile), but CAN reach
// trainer_names. We try profiles first (returns 0 rows for a
// trainee → trainer lookup) and fall through to trainer_names.
// Trainers looking up trainees still resolve via the first query.

import { useEffect, useState } from 'react';
import { getSupabase } from './supabase';

const CACHE = new Map<string, string>();

async function fetchDisplayName(userId: string): Promise<string> {
  const fromProfiles = await getSupabase()
    .from('profiles').select('display_name').eq('id', userId).limit(1) as
    { data: { display_name: string | null }[] | null };
  const fromProfile = fromProfiles.data?.[0]?.display_name;
  if (fromProfile) return fromProfile;

  const fromView = await getSupabase()
    .from('trainer_names').select('display_name').eq('id', userId).limit(1) as
    { data: { display_name: string | null }[] | null };
  const fromTrainer = fromView.data?.[0]?.display_name;
  if (fromTrainer) return fromTrainer;

  return userId.slice(0, 8);
}

export function useDisplayName(userId: string | undefined): string | undefined {
  const cached = userId ? CACHE.get(userId) : undefined;
  const [fetched, setFetched] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;
    if (CACHE.has(userId)) return;
    let cancelled = false;
    void fetchDisplayName(userId).then((dn) => {
      CACHE.set(userId, dn);
      if (!cancelled) setFetched(dn);
    });
    return () => { cancelled = true; };
  }, [userId]);

  return cached ?? fetched;
}
