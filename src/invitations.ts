// Trainer-side helpers for the invitation flow.
// The Edge Function `invite-user` is the single write path. Cancel is a
// direct UPDATE under the column-level grant in migration 0006.

import { getSupabase } from './supabase';
import { log } from './diagnostics/logger';
import { CATEGORY } from './diagnostics/categories';

export interface InviteResult {
  ok: boolean;
  invitationId?: string;
  alreadyExisted?: boolean;
  error?: string;
}

interface FunctionsHttpError {
  message?: string;
  context?: { json?: () => Promise<{ error?: string }> };
}

export async function inviteByEmail(email: string): Promise<InviteResult> {
  const { data, error } = await getSupabase()
    .functions.invoke<InviteResult>('invite-user', { body: { email } });
  if (error) {
    let body: { error?: string } | null = null;
    try {
      const json = await (error as FunctionsHttpError).context?.json?.();
      if (json) body = json;
    } catch { /* ignore — the function may have returned a non-JSON body */ }
    const msg = body?.error ?? (error as FunctionsHttpError).message ?? 'invite failed';
    log.error(CATEGORY.invite, 'failed', { message: msg });
    return { ok: false, error: msg };
  }
  log.info(CATEGORY.invite, 'sent', {
    alreadyExisted: data?.alreadyExisted ?? false,
    invitationId: data?.invitationId,
  });
  return data ?? { ok: false, error: 'no response' };
}

/** Calls the designate_invited_user RPC. The server resolves the
 *  recipient's auth.users.id from the invitation's email and inserts
 *  a 'pending' trainer_trainees row. Returns the trainee's user_id
 *  so the caller can refresh local state. */
export async function designateInvitedUser(invitationId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('designate_invited_user', {
    invitation_id: invitationId,
  }) as { data: string | null; error: { message: string } | null };
  if (error) {
    log.error(CATEGORY.invite, 'designate failed', { invitationId, message: error.message });
    throw new Error(error.message);
  }
  if (!data) throw new Error('designate_invited_user returned no id');
  log.info(CATEGORY.invite, 'designated', { invitationId, traineeId: data });
  return data;
}

export async function cancelInvitation(id: string): Promise<void> {
  const { error } = await getSupabase().from('invitations')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', id) as { error: { message: string } | null };
  if (error) {
    log.error(CATEGORY.invite, 'cancel failed', { id, message: error.message });
    throw new Error(error.message);
  }
  log.info(CATEGORY.invite, 'cancelled', { id });
}
