import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

export function useFavoriteIds(): Set<string> {
  const list = useLiveQuery(() => db.favorites.toArray(), []);
  return useMemo(() => new Set((list ?? []).map((f) => f.exerciseId)), [list]);
}

export async function toggleFavorite(exerciseId: string): Promise<void> {
  const existing = await db.favorites.get(exerciseId);
  if (existing) {
    await db.favorites.delete(exerciseId);
  } else {
    await db.favorites.add({ exerciseId, addedAt: Date.now() });
  }
}
