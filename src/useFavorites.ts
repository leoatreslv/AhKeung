import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { getSupabase } from './supabase';
import { putWithSync, deleteWithSync } from './sync/putWithSync';

export function useFavoriteIds(): Set<string> {
  const list = useLiveQuery(() => db.favorites.toArray(), []);
  return useMemo(() => new Set((list ?? []).map((f) => f.exerciseId)), [list]);
}

/** Used outside React components, so it can't go through useCurrentUserId. */
export async function toggleFavorite(exerciseId: string): Promise<void> {
  const userId = (await getSupabase().auth.getSession()).data.session?.user?.id;
  if (!userId) return;
  const existing = await db.favorites.get([userId, exerciseId]);
  if (existing) {
    await deleteWithSync('favorites', userId, exerciseId);
  } else {
    await putWithSync('favorites', { exerciseId, addedAt: Date.now() }, userId);
  }
}
