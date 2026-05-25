// Admin's outbound invitations. RLS scopes the query to the
// current admin's own rows (inviter_id = auth.uid()), so we just
// SELECT * and order client-side.
//
// Not Dexie-backed: invitations are inherently online (sending one
// hits the Edge Function, listing them hits Supabase directly), so
// caching adds little. The admin's invitations screen calls
// refresh() after every mutation.

import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from './supabase';
import { useCurrentUserId } from './auth/useCurrentUserId';

export interface Invitation {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
  designatedAt: string | null;
  alreadyExisted: boolean;
}

export type InvitationStatus =
  | 'pending'
  | 'accepted'
  | 'already-existed'
  | 'cancelled'
  | 'expired';

export function classifyInvitation(inv: Invitation): InvitationStatus {
  if (inv.cancelledAt) return 'cancelled';
  if (inv.alreadyExisted) return 'already-existed';
  if (inv.acceptedAt) return 'accepted';
  if (Date.parse(inv.expiresAt) < Date.now()) return 'expired';
  return 'pending';
}

interface ServerRow {
  id: string;
  email: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  designated_at: string | null;
  already_existed: boolean;
}

function rowsToInvitations(rows: ServerRow[]): Invitation[] {
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    cancelledAt: r.cancelled_at,
    designatedAt: r.designated_at,
    alreadyExisted: r.already_existed,
  }));
}

async function fetchInvitations(userId: string): Promise<{ rows: Invitation[]; error: string | null }> {
  // `designated_at is null` filter: once a recipient has been
  // designated (via the `+ Designate` button or the search flow),
  // the invitation row is "done." Hiding it from the pending list
  // keeps the trainer's view focused on rows that still need
  // action. The row stays in the DB as audit; if it ever needs
  // resurfacing, clear designated_at in the SQL editor.
  const res = await getSupabase().from('invitations')
    .select('id, email, created_at, expires_at, accepted_at, cancelled_at, designated_at, already_existed')
    .eq('inviter_id', userId)
    .is('designated_at', null)
    .order('created_at', { ascending: false }) as
    { data: ServerRow[] | null; error: { message: string } | null };
  if (res.error) return { rows: [], error: res.error.message };
  return { rows: rowsToInvitations(res.data ?? []), error: null };
}

export function useInvitations(): {
  list: Invitation[] | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const userId = useCurrentUserId();
  const [list, setList] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch on userId change. The setState calls live inside a
  // .then() callback (async boundary), satisfying the lint rule's
  // "no setState directly in effect body" check. AdminInvites is wrapped in
  // ModeGate allowedIn={['admin']}, so userId is non-null in practice.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void fetchInvitations(userId).then((res) => {
      if (cancelled) return;
      setError(res.error);
      setList(res.rows);
    });
    return () => { cancelled = true; };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const res = await fetchInvitations(userId);
    setError(res.error);
    setList(res.rows);
  }, [userId]);

  return { list, error, refresh };
}
