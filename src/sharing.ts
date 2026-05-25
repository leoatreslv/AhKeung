// Sharing primitives. Three callable shapes:
//
//   shareResource('exercise' | 'bundle', resourceId, recipientId)
//     — writes a shares row via putWithSync; the trainee sees the
//     resource on next pull (gated by has_accepted_designation server-side).
//
//   sharePlan(planId, recipientId)
//     — invokes the share_plan RPC, which clones the plan into the
//     trainee's plans table with assigned_by set, emits exercise share
//     rows for each referenced exercise, and supersedes any previous
//     assignment from this trainer.

import { getSupabase } from './supabase';
import { db, type ShareResourceType } from './db';
import { putWithSync, deleteWithSync } from './sync/putWithSync';
import { log } from './diagnostics/logger';
import { CATEGORY } from './diagnostics/categories';

export async function shareResource(
  resourceType: 'exercise' | 'bundle',
  resourceId: string,
  recipientId: string,
  granterId: string,
): Promise<void> {
  // Check whether this exact share already exists locally; re-emit as an
  // update no-op if so, otherwise create. Deleted shares (deletedAt set)
  // are re-shared as a new row to avoid undeleting via tombstone races.
  const existing = await db.shares
    .where('[resourceType+resourceId]').equals([resourceType, resourceId])
    .and((s) => s.recipientId === recipientId && !s.deletedAt)
    .first();
  if (existing) return;

  const id = crypto.randomUUID();
  await putWithSync('shares', {
    id,
    granterId,
    recipientId,
    resourceType: resourceType as ShareResourceType,
    resourceId,
    createdAt: Date.now(),
  }, granterId);
  log.info(CATEGORY.share, 'created', { type: resourceType, resourceId, recipientId });
}

export async function unshareResource(shareId: string): Promise<void> {
  await deleteWithSync('shares', shareId);
  log.info(CATEGORY.share, 'revoked', { shareId });
}

/** Calls the share_plan RPC. Server clones the plan into the trainee's
 *  plans, sets assigned_by, supersedes any previous current assignment
 *  from this trainer to this trainee, and emits exercise shares for
 *  every exerciseId in the plan. Returns the new plan id. */
export async function sharePlan(planId: string, recipientId: string): Promise<string> {
  const res = await getSupabase().rpc('share_plan', {
    plan_id: planId,
    recipient: recipientId,
  }) as { data: string | null; error: { message: string } | null };
  if (res.error) {
    log.error(CATEGORY.share, 'sharePlan failed', { planId, recipientId, message: res.error.message });
    throw new Error(res.error.message);
  }
  if (!res.data) {
    log.error(CATEGORY.share, 'sharePlan returned no id', { planId, recipientId });
    throw new Error('share_plan returned no id');
  }
  log.info(CATEGORY.share, 'plan shared', { originalPlanId: planId, clonedPlanId: res.data, recipientId });
  return res.data;
}

/** Promotes another user to trainer. Callable only by admins; the
 *  promote_to_trainer SECURITY DEFINER RPC enforces that and bypasses
 *  the profiles_write tightening that otherwise forbids self-elevation. */
export async function promoteToTrainer(target: string): Promise<void> {
  const res = await getSupabase().rpc('promote_to_trainer', { target }) as
    { error: { message: string } | null };
  if (res.error) {
    log.error(CATEGORY.auth, 'promote failed', { target, message: res.error.message });
    throw new Error(res.error.message);
  }
  log.info(CATEGORY.auth, 'promoted', { target });
}

/** Promotes another user to admin. Callable only by admins; the
 *  promote_to_admin SECURITY DEFINER RPC enforces that. */
export async function promoteToAdmin(target: string): Promise<void> {
  const res = await getSupabase().rpc('promote_to_admin', { target }) as
    { error: { message: string } | null };
  if (res.error) {
    log.error(CATEGORY.auth, 'promote admin failed', { target, message: res.error.message });
    throw new Error(res.error.message);
  }
  log.info(CATEGORY.auth, 'promoted admin', { target });
}
