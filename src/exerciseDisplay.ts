// Display helpers for trainer-authored exercises. Replaces the
// free-exercise-db `src/exercises.ts` (removed in PR 2).

import type { CustomExercise } from './db';
import type { Locale } from './i18n/types';

/** Build a Supabase Storage public URL from an image_path stored on an
 *  exercise row. Returns null when the exercise has no image (the UI
 *  decides whether to render a placeholder or omit the slot). */
export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/exercise-images/${path}`;
}

/** Locale-aware display name. Falls back to the other language if the
 *  preferred field is empty — `exercises.name_en`/`name_zh` are
 *  individually nullable but the CHECK constraint guarantees at least
 *  one is set. */
export function displayName(ex: Pick<CustomExercise, 'nameEn' | 'nameZh'>, locale: Locale): string {
  if (locale === 'zh-Hant') return ex.nameZh ?? ex.nameEn ?? '';
  return ex.nameEn ?? ex.nameZh ?? '';
}
