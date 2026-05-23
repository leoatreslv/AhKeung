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
import { resizeImage } from '../imageResize';
import { log } from '../diagnostics/logger';
import { CATEGORY } from '../diagnostics/categories';

// Defensive ceiling: anything above this gets re-resized before upload,
// even if it was already resized at pick time. Catches stale rows that
// were stored before imageResize started enforcing the size cap.
const SAFE_UPLOAD_BYTES = 500 * 1024;

export async function runImageUploadSweep(): Promise<void> {
  const { data: { session } } = await getSupabase().auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return;

  const pending = await db.exercises
    .filter((e) => !!e.pendingImageBlob && e.ownerId === userId)
    .toArray();

  for (const ex of pending) {
    if (!ex.pendingImageBlob) continue;

    let blob = ex.pendingImageBlob;
    const inputSize = blob.size;
    if (blob.size > SAFE_UPLOAD_BYTES) {
      try {
        blob = await resizeImage(blob);
        // Persist the smaller blob so a later retry doesn't redo the work.
        await db.exercises.update(ex.id, { pendingImageBlob: blob });
      } catch (err) {
        log.error(CATEGORY['image-upload'], 'pre-upload resize failed', {
          id: ex.id, message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const path = `${userId}/${ex.id}.jpg`;
    const res = await getSupabase().storage
      .from('exercise-images')
      .upload(path, blob, {
        // Always announce image/jpeg — resizeImage produces JPEG, and a
        // few Android builds return blobs with empty .type which would
        // trip the bucket's MIME allowlist.
        contentType: 'image/jpeg',
        upsert: true,
      });
    if (res.error) {
      // Leave the row alone; the next sweep retries. Logged as error so
      // the diagnostics dump shows what the sweep tried and why it
      // failed (storage RLS issues, MIME-type mismatch, size-cap hit).
      log.error(CATEGORY['image-upload'], 'storage upload failed', {
        id: ex.id, path, size: blob.size, message: res.error.message,
      });
      continue;
    }
    await db.exercises.update(ex.id, {
      imagePath: path,
      pendingImageBlob: undefined,
    });
    log.info(CATEGORY['image-upload'], 'uploaded', {
      id: ex.id, path, inputSize, uploadSize: blob.size,
    });
  }
}
