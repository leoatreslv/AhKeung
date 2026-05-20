// Trainer-side helpers for the invitation flow.
// The Edge Function `invite-user` is the single write path. Cancel is a
// direct UPDATE under the column-level grant in migration 0006.

import { getSupabase } from './supabase';

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
    return { ok: false, error: msg };
  }
  return data ?? { ok: false, error: 'no response' };
}

export async function cancelInvitation(id: string): Promise<void> {
  const { error } = await getSupabase().from('invitations')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', id) as { error: { message: string } | null };
  if (error) throw new Error(error.message);
}
