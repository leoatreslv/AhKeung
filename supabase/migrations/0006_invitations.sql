-- 0006_invitations.sql
--
-- Trainer-issued invitations for closed signup. See
-- docs/by-invitation-signup-plan.md for the design.
--
-- Deploy step alongside this migration (not part of the SQL):
--   In Supabase Dashboard → Authentication → Providers → Email,
--   flip "Allow new user sign-ups" → OFF. The invite-user Edge
--   Function uses auth.admin.inviteUserByEmail which bypasses the
--   flag, so the flag doesn't break invitations — it just blocks
--   self-signup, which is the goal.

-- ─── Table ────────────────────────────────────────────────────────────

create table invitations (
  id              uuid        primary key default gen_random_uuid(),
  inviter_id      uuid        not null references profiles(id) on delete cascade,
  email           text        not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '7 days',
  accepted_at     timestamptz,
  cancelled_at    timestamptz,
  -- True when the email was already a registered user at invite time.
  -- The Edge Function records the row without sending an auth email and
  -- the trainer's UI surfaces this as "already had an account" — no
  -- fake accepted_at stamp on the audit trail (S10).
  already_existed boolean     not null default false,
  unique (inviter_id, email)
);

-- Lookup by lowercase email for the auth-signup trigger. Partial index
-- restricts to live (not cancelled / not accepted) rows so the index
-- stays small and writes are cheap.
create index invitations_email_open on invitations(lower(email))
  where accepted_at is null and cancelled_at is null;
create index invitations_inviter on invitations(inviter_id);

alter table invitations enable row level security;

-- Trainer sees their own outbound invitations.
create policy "invitations_read_inviter" on invitations
  for select using (inviter_id = auth.uid());

-- Trainer may UPDATE only `cancelled_at` on their own rows. PostgreSQL
-- RLS can't restrict which columns the user changes, so we pair the
-- policy with a column-level GRANT REVOKE that only allows the column.
-- Other columns are blocked because the role lacks UPDATE on them.
create policy "invitations_cancel_inviter" on invitations
  for update using (inviter_id = auth.uid())
  with check (inviter_id = auth.uid());

revoke update on invitations from authenticated;
grant update (cancelled_at) on invitations to authenticated;

-- INSERT and DELETE: no policy. Only service-role (Edge Function)
-- writes rows; nothing deletes them (cancel + accept are soft).

-- ─── Trigger: stamp accepted_at on signup ────────────────────────────

create or replace function public.handle_invited_signup() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  inviter  uuid;
  email_lc text;
begin
  email_lc := lower(new.email);
  -- Preferred attribution path. NULLIF guards against an empty string
  -- value that would otherwise blow up the ::uuid cast.
  inviter := nullif(new.raw_user_meta_data->>'invited_by', '')::uuid;

  if inviter is not null then
    update invitations
       set accepted_at = coalesce(accepted_at, now())
     where inviter_id = inviter
       and lower(email) = email_lc
       and accepted_at is null
       and cancelled_at is null;
  end if;

  -- Fallback (W13): catch any other still-pending invitations for this
  -- email so audit isn't lost when invited_by drifts across SDK
  -- versions or is missing. coalesce() prevents overwriting an existing
  -- accepted_at on rows the first branch already stamped.
  update invitations
     set accepted_at = coalesce(accepted_at, now())
   where lower(email) = email_lc
     and accepted_at is null
     and cancelled_at is null;

  -- Intentionally NOT inserting into trainer_trainees here. The
  -- inviting trainer may not be the trainee's designated trainer —
  -- designation stays the separate pending → accept ceremony in
  -- MyTrainees.
  return new;
end $$;

drop trigger if exists on_invited_user_created on auth.users;
create trigger on_invited_user_created
  after insert on auth.users
  for each row execute function public.handle_invited_signup();

-- ─── Rate-limit RPC consumed by invite-user Edge Function ────────────
-- Takes a transaction-scoped advisory lock on the inviter, then counts
-- active invitations in the last 24h. The lock guarantees concurrent
-- requests from the same trainer can't both see count=9 and both
-- insert. Returns { exceeded: bool, count: int } so the function can
-- short-circuit with 429 before calling the admin API.

create or replace function public.invite_rate_check(inviter uuid, max_per_day int)
  returns table (exceeded boolean, count_24h int)
  language plpgsql security definer set search_path = public as $$
declare
  c int;
begin
  perform pg_advisory_xact_lock(hashtext(inviter::text));
  select count(*)::int into c
    from invitations
   where inviter_id = inviter
     and created_at > now() - interval '1 day'
     and cancelled_at is null;
  exceeded := c >= max_per_day;
  count_24h := c;
  return next;
end $$;

revoke execute on function public.invite_rate_check(uuid, int) from public;
-- service_role bypasses this anyway, but explicit grant keeps the
-- intent clear: only the Edge Function (running as service role)
-- should call this.
grant execute on function public.invite_rate_check(uuid, int) to service_role;
