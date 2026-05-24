// Display helpers for trainer-authored exercises. Replaces the
// free-exercise-db `src/exercises.ts` (removed in PR 2).

import type { CustomExercise } from './db';
import type { Locale } from './i18n/types';

/** Build a Supabase Storage public URL from an image_path stored on an
 *  exercise row. Returns null when the exercise has no image (the UI
 *  decides whether to render a placeholder or omit the slot).
 *
 *  `version` is appended as `?v=<n>` for cache-busting. The image
 *  path itself is content-addressed-by-row (`<owner>/<exerciseId>.jpg`)
 *  so it stays stable when a trainer replaces a photo — the URL
 *  alone wouldn't tell the PWA's CacheFirst service worker that the
 *  bytes changed, and the recipient would see the OLD image for the
 *  60-day cache TTL. Passing the row's `updatedAt` flips the cache
 *  key on every edit so the next fetch goes to the network. */
export function imageUrl(path: string | null | undefined, version?: number): string | null {
  if (!path) return null;
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) return null;
  const url = `${base}/storage/v1/object/public/exercise-images/${path}`;
  return version != null ? `${url}?v=${version}` : url;
}

/** Locale-aware display name. Falls back to the other language if the
 *  preferred field is empty — `exercises.name_en`/`name_zh` are
 *  individually nullable but the CHECK constraint guarantees at least
 *  one is set. */
export function displayName(ex: Pick<CustomExercise, 'nameEn' | 'nameZh'>, locale: Locale): string {
  if (locale === 'zh-Hant') return ex.nameZh ?? ex.nameEn ?? '';
  return ex.nameEn ?? ex.nameZh ?? '';
}
