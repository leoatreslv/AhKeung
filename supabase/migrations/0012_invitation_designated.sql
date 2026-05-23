-- 0012_invitation_designated.sql
--
-- The "+ Designate" button on JOINED invitation rows stays visible
-- after tapping because nothing tracks whether the trainer has
-- already designated the recipient — same problem applies to
-- recipients who were designated via the search flow before PR 3
-- shipped (AhNa is the canonical example).
--
-- This migration adds `invitations.designated_at`, stamped whenever
-- the trainer creates a trainer_trainees row for the recipient
-- (via either the `+ Designate` button on the invitation or the
-- search-based flow). The client filters out invitations with
-- `designated_at IS NOT NULL` so the row drops out of the pending
-- list once the workflow completes.

-- ─── Column ──────────────────────────────────────────────────────────

alter table invitations
  add column if not exists designated_at timestamptz;

-- ─── Trigger covering the search-flow path ───────────────────────────
-- AFTER INSERT on trainer_trainees so that any new designation (no
-- matter which code path created it) marks the matching invitation
-- as completed. We don't add an AFTER UPDATE variant — re-designating
-- a previously-declined row uses the RPC path, which stamps
-- designated_at explicitly. See migration comments.
--
-- Scoped to `inviter_id = NEW.trainer_id` so a designation by
-- trainer A can never touch trainer B's invitations.

create or replace function public.mark_invitation_designated() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  trainee_email text;
begin
  -- Look up the trainee's email — trainer_trainees only carries the
  -- user_id, but invitations are keyed by email.
  select au.email into trainee_email
    from auth.users au
   where au.id = new.trainee_id;
  if trainee_email is null then return new; end if;

  update invitations
     set designated_at = now()
   where inviter_id = new.trainer_id
     and lower(email) = lower(trainee_email)
     and designated_at is null
     and cancelled_at is null;

  return new;
end $$;

drop trigger if exists trainer_trainees_mark_invitation_designated on trainer_trainees;
create trigger trainer_trainees_mark_invitation_designated
  after insert on trainer_trainees
  for each row execute function public.mark_invitation_designated();

-- ─── Update the designate_invited_user RPC ───────────────────────────
-- The RPC's upsert can take the ON CONFLICT DO UPDATE path, which
-- doesn't fire AFTER INSERT triggers in Postgres. Stamp
-- designated_at explicitly here so re-designations also mark the
-- invitation as completed (idempotent — re-stamping a non-NULL
-- value is a no-op because of the `designated_at IS NULL` guard).

create or replace function public.designate_invited_user(invitation_id uuid)
  returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  inv     invitations%rowtype;
  trainee uuid;
begin
  select * into inv from invitations
   where id = invitation_id
     and inviter_id = auth.uid();
  if not found then
    raise exception 'invitation not found or not owned by caller';
  end if;

  if not public.is_trainer() then
    raise exception 'only trainers may designate';
  end if;

  if inv.accepted_at is null then
    raise exception 'invitation not yet accepted';
  end if;
  if inv.cancelled_at is not null then
    raise exception 'invitation has been cancelled';
  end if;

  select id into trainee from auth.users
   where lower(email) = lower(inv.email)
   limit 1;
  if trainee is null then
    raise exception 'recipient no longer has an account';
  end if;

  insert into trainer_trainees (trainer_id, trainee_id, status, designated_at)
  values (auth.uid(), trainee, 'pending', now())
  on conflict (trainer_id, trainee_id) do update
    set status = case
                   when trainer_trainees.status = 'declined' then 'pending'
                   else trainer_trainees.status
                 end,
        responded_at = case
                         when trainer_trainees.status = 'declined' then null
                         else trainer_trainees.responded_at
                       end,
        updated_at = now();

  -- Stamp the invitation as designated so the pending-list filter
  -- drops it from the trainer's UI. The AFTER INSERT trigger above
  -- handles the actual-INSERT path; this UPDATE covers the
  -- ON CONFLICT DO UPDATE path where the trigger doesn't fire.
  update invitations
     set designated_at = coalesce(designated_at, now())
   where id = invitation_id;

  return trainee;
end $$;

revoke execute on function public.designate_invited_user(uuid) from public;
grant  execute on function public.designate_invited_user(uuid) to authenticated;

-- ─── Backfill ────────────────────────────────────────────────────────
-- Stamp every invitation whose inviter currently has an active
-- (not soft-deleted) trainer_trainees row with the recipient.
-- Single-pass; idempotent (only touches rows where designated_at
-- is still NULL). AhNa's row from the bug report falls under this.

update invitations inv
   set designated_at = now()
  from auth.users au
  join trainer_trainees tt
    on tt.trainee_id = au.id
   and tt.deleted_at is null
 where lower(au.email) = lower(inv.email)
   and tt.trainer_id = inv.inviter_id
   and inv.designated_at is null
   and inv.cancelled_at is null;

-- ─── Verify recipe (paste into SQL editor after deploy) ──────────────
-- 1. Confirm AhNa's row got the backfill stamp:
--      select email, accepted_at, designated_at, cancelled_at
--        from invitations
--       where email = 'leowong8888@yahoo.com';
-- 2. Confirm the trigger registered:
--      select tgname from pg_trigger
--       where tgrelid = 'public.trainer_trainees'::regclass
--         and tgname = 'trainer_trainees_mark_invitation_designated';
-- 3. Smoke-test new invite end-to-end: invite a fresh address, have
--    the recipient onboard, tap `+ Designate` → confirm the row
--    drops from the pending invitations list and the recipient
--    appears under Pending designations.
