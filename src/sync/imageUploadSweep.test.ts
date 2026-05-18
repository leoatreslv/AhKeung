import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { runImageUploadSweep } from './imageUploadSweep';
import { runPushOnce } from './pushWorker';
import { putWithSync } from './putWithSync';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

const UID = 'trainer-x';

beforeEach(async () => {
  await db.delete();
  await db.open();
  stubAuthenticatedUser({ id: UID, isTrainer: true });
});

function makeBlob(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
}

describe('image upload sweep', () => {
  it('uploads pendingImageBlob to Supabase Storage and clears it from the row', async () => {
    await putWithSync('exercises', {
      id: 'ex-1', ownerId: UID,
      nameEn: 'Bench', nameZh: null,
      muscleGroup: 'chest', equipment: null, instructions: null,
      imagePath: null, createdAt: 1,
    }, UID);
    await db.exercises.update('ex-1', { pendingImageBlob: makeBlob() });

    await runImageUploadSweep();

    const fake = getActiveFake();
    expect(fake.storage).toHaveLength(1);
    expect(fake.storage[0].bucket).toBe('exercise-images');
    expect(fake.storage[0].path).toBe(`${UID}/ex-1.jpg`);

    const row = await db.exercises.get('ex-1');
    expect(row?.imagePath).toBe(`${UID}/ex-1.jpg`);
    expect(row?.pendingImageBlob).toBeUndefined();
  });

  it('leaves the row alone when upload fails (network down)', async () => {
    await putWithSync('exercises', {
      id: 'ex-1', ownerId: UID,
      nameEn: 'Bench', nameZh: null,
      muscleGroup: 'chest', equipment: null, instructions: null,
      imagePath: null, createdAt: 1,
    }, UID);
    await db.exercises.update('ex-1', { pendingImageBlob: makeBlob() });

    getActiveFake().setNetworkUp(false);
    await runImageUploadSweep();

    const row = await db.exercises.get('ex-1');
    expect(row?.imagePath).toBeNull();
    expect(row?.pendingImageBlob).toBeDefined();
  });

  it('only uploads exercises owned by the current user', async () => {
    await db.exercises.put({
      id: 'ex-other', ownerId: 'other-trainer',
      nameEn: 'Theirs', nameZh: null,
      muscleGroup: 'chest', equipment: null, instructions: null,
      imagePath: null, createdAt: 1,
      updatedAt: 1, serverVersion: null,
      pendingImageBlob: makeBlob(),
    });
    await runImageUploadSweep();
    expect(getActiveFake().storage).toHaveLength(0);
  });
});

describe('push worker respects pending image', () => {
  it('skips push for a row with pendingImageBlob, processes after sweep clears it', async () => {
    await putWithSync('exercises', {
      id: 'ex-1', ownerId: UID,
      nameEn: 'Bench', nameZh: null,
      muscleGroup: 'chest', equipment: null, instructions: null,
      imagePath: null, createdAt: 1,
    }, UID);
    await db.exercises.update('ex-1', { pendingImageBlob: makeBlob() });

    // Push without sweep — should not send the row, queue entry stays.
    await runPushOnce();
    const fake = getActiveFake();
    expect(fake.tables.exercises ?? []).toHaveLength(0);
    expect(await db.syncQueue.count()).toBe(1);

    // Sweep clears the blob; the next push picks the row up.
    await runImageUploadSweep();
    expect(fake.storage).toHaveLength(1);
    await runPushOnce();
    expect((fake.tables.exercises ?? []).find((r) => r.id === 'ex-1')).toBeDefined();
    expect(await db.syncQueue.count()).toBe(0);
  });
});
