// Pre-push sweep: every Dexie row with a pendingImageBlob is uploaded to
// Supabase Storage at `{ownerId}/{rowId}.jpg`, then the imagePath is set
// and the pending blob cleared. The row's existing syncQueue entry picks
// up the new imagePath on the next push.
//
// Resolves W14 in the design doc: image upload survives offline because
// the blob lives in Dexie until upload succeeds; the sync orchestrator
// runs this sweep before each push.

import { getSupabase } from '../supabase';
import { db } from '../db';

export async function runImageUploadSweep(): Promise<void> {
  const { data: { session } } = await getSupabase().auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return;

  const pending = await db.exercises
    .filter((e) => !!e.pendingImageBlob && e.ownerId === userId)
    .toArray();

  for (const ex of pending) {
    if (!ex.pendingImageBlob) continue;
    const path = `${userId}/${ex.id}.jpg`;
    const res = await getSupabase().storage
      .from('exercise-images')
      .upload(path, ex.pendingImageBlob, {
        contentType: ex.pendingImageBlob.type || 'image/jpeg',
        upsert: true,
      });
    if (res.error) {
      // Leave the row alone; the next sweep retries. Surface in console for
      // diagnostics; the sync orchestrator already wraps in safeRun.
      console.warn('[image upload]', ex.id, res.error.message);
      continue;
    }
    await db.exercises.update(ex.id, {
      imagePath: path,
      pendingImageBlob: undefined,
    });
  }
}
