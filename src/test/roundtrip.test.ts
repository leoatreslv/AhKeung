// End-to-end roundtrip simulating the full trainer → trainee flow over
// the sync layer. Drives the workers directly (no React rendering) so
// the assertions exercise the data path, not the UI; the per-screen
// tests already cover the UI.
//
// Limitation: the fake Supabase doesn't enforce RLS. A trainee's pull
// over the fake returns every row in the relevant tables — including
// rows server-side RLS would deny. That's acceptable for verifying the
// client-side mechanics; RLS denial behaviour is a server-side concern
// best tested via pgTAP (deferred per the design doc's W15).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { runPushOnce } from '../sync/pushWorker';
import { runPullOnce } from '../sync/pullWorker';
import { putWithSync } from '../sync/putWithSync';
import { shareResource } from '../sharing';
import { stubAuthenticatedUser, getActiveFake } from './authStub';

const TRAINER = 'u-trainer';
const TRAINEE = 'u-trainee';
const EX_ID = 'ex-bench-uuid';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('trainer creates exercise → designation → share → trainee uses in plan', () => {
  it('plays the full roundtrip through the sync workers', async () => {
    // ─── Trainer creates an exercise and pushes it to the server ──
    stubAuthenticatedUser({ id: TRAINER, isTrainer: true });
    const fake = getActiveFake();
    fake.tables.profiles.push({
      id: TRAINEE, display_name: 'Trainee', is_trainer: false,
      created_at: new Date().toISOString(),
    });

    await putWithSync('exercises', {
      id: EX_ID, ownerId: TRAINER,
      nameEn: 'Bench Press', nameZh: '臥推',
      muscleGroup: 'chest', equipment: 'barbell', instructions: null,
      imagePath: null, createdAt: 1,
    }, TRAINER);
    await runPushOnce();

    const onServer = fake.tables.exercises.find((r) => r.id === EX_ID);
    expect(onServer).toBeDefined();
    expect(onServer?.owner_id).toBe(TRAINER);
    expect(onServer?.name_en).toBe('Bench Press');
    expect(onServer?.name_zh).toBe('臥推');

    // ─── Trainer designates the trainee ───────────────────────────
    await putWithSync('trainerTrainees', {
      trainerId: TRAINER, traineeId: TRAINEE,
      status: 'pending', designatedAt: 1,
    }, TRAINER);
    await runPushOnce();

    const designation = fake.tables.trainer_trainees?.find(
      (r) => r.trainer_id === TRAINER && r.trainee_id === TRAINEE,
    );
    expect(designation).toBeDefined();
    expect(designation?.status).toBe('pending');

    // ─── Trainee accepts (server-side mutation; real flow uses
    //     the trainer_trainees_trainee_respond RLS update policy) ─
    designation!.status = 'accepted';
    designation!.responded_at = new Date(2).toISOString();
    designation!.updated_at = new Date(2).toISOString();

    // ─── Trainer shares the exercise with the trainee ─────────────
    await shareResource('exercise', EX_ID, TRAINEE, TRAINER);
    await runPushOnce();

    const shareRow = fake.tables.shares?.find(
      (r) => r.recipient_id === TRAINEE && r.resource_id === EX_ID,
    );
    expect(shareRow).toBeDefined();
    expect(shareRow?.granter_id).toBe(TRAINER);
    expect(shareRow?.resource_type).toBe('exercise');

    // ─── Trainee signs in on a fresh device (wipe Dexie) ──────────
    await db.delete();
    await db.open();
    fake.deliverMagicLink('trainee@example.com', TRAINEE);
    await runPullOnce();

    const pulledEx = await db.exercises.get(EX_ID);
    expect(pulledEx?.nameEn).toBe('Bench Press');
    expect(pulledEx?.nameZh).toBe('臥推');
    expect(pulledEx?.ownerId).toBe(TRAINER);

    const pulledShares = await db.shares.toArray();
    expect(pulledShares).toHaveLength(1);
    expect(pulledShares[0]).toMatchObject({
      granterId: TRAINER,
      recipientId: TRAINEE,
      resourceType: 'exercise',
      resourceId: EX_ID,
    });

    // ─── Trainee can't mutate the trainer-owned exercise ──────────
    // The PR 0 / PR 1 writability guard ('own-only' + ownerKind='self')
    // refuses putWithSync against a row whose ownerId is someone else.
    await expect(
      putWithSync('exercises', { id: EX_ID, nameEn: 'Hacked' }, TRAINEE),
    ).rejects.toThrow(/cannot mutate/);

    // ─── Trainee builds a plan referencing the shared exercise ────
    await putWithSync('plans', {
      id: 'plan-1', userId: TRAINEE,
      name: 'My Push Day', weekStart: '2025-03-10',
      focus: ['chest'],
      exercises: [{ exerciseId: EX_ID, targetSets: 3, targetReps: 8 }],
      createdAt: 3,
    }, TRAINEE);

    const trainedPlan = await db.plans.get('plan-1');
    expect(trainedPlan?.userId).toBe(TRAINEE);
    expect(trainedPlan?.exercises[0].exerciseId).toBe(EX_ID);

    // ─── Trainee favourites the trainer's exercise ────────────────
    await putWithSync('favorites', { exerciseId: EX_ID, addedAt: 4 }, TRAINEE);
    const fav = await db.favorites.get([TRAINEE, EX_ID]);
    expect(fav).toBeDefined();
    expect(fav?.userId).toBe(TRAINEE);
    expect(fav?.exerciseId).toBe(EX_ID);

    // ─── Final push from the trainee carries the plan + favourite ─
    await runPushOnce();
    const serverPlan = fake.tables.plans?.find((r) => r.id === 'plan-1');
    expect(serverPlan?.user_id).toBe(TRAINEE);
    const serverFav = fake.tables.favorites?.find(
      (r) => r.user_id === TRAINEE && r.exercise_id === EX_ID,
    );
    expect(serverFav).toBeDefined();
  });
});
