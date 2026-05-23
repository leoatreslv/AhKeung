-- 0010_invitation_accepted_via_profile.sql
--
-- Fix the long-standing "accepted_at is never stamped" bug.
--
-- The pre-existing trigger from 0006 was wired on `auth.users INSERT`
-- and tried to UPDATE the invitations row keyed by email. But our
-- Edge Function `invite-user` calls `inviteUserByEmail` (auth.users
-- INSERT → trigger fires) BEFORE inserting the invitations row.
-- There was never a matching row to update; the trigger noop'd on
-- every call. The "already_existed" branch we added later doesn't
-- INSERT a new auth.users at all, so the trigger was doubly broken
-- for that path. Net effect: `accepted_at` was permanently NULL for
-- every invitation in the system, and trainers never saw recipients
-- flip to "Accepted" even after the recipient finished onboarding.
--
-- New approach: a trigger on `profiles UPDATE` keyed off the
-- display_name NULL → non-NULL transition. The Onboarding screen
-- (src/auth/Onboarding.tsx) is the single place display_name gets
-- set for an invited user — covers both code paths uniformly:
--   - Fresh invite: Supabase creates auth.users → handle_new_user
--     (0001) inserts a profile with display_name NULL → recipient
--     clicks invite link → Onboarding submit sets display_name →
--     our new trigger fires → accepted_at stamped.
--   - Already-existed/recovery: no new auth.users INSERT, the user
--     already has a profile (with display_name NULL, since they
--     didn't onboard previously) → recovery link → Onboarding sets
--     display_name → our trigger fires → accepted_at stamped.
--
-- Semantic note: if multiple trainers invited the same email, all
-- matching open invitation rows get stamped at once. "Accepted"
-- means "this recipient finished onboarding," not "this specific
-- link was clicked." Documented here so future readers don't try to
-- disambiguate by trainer — we deliberately don't track which
-- invitation link was actually consumed (Supabase doesn't expose
-- that signal cleanly, and the user-facing semantic of "this person
-- is in the app now" is the one that matters).

-- ─── Tear down the old trigger ──────────────────────────────────────

drop trigger if exists on_invited_user_created on auth.users;
drop function if exists public.handle_invited_signup();

-- ─── New trigger function ───────────────────────────────────────────
--
-- SECURITY DEFINER so it can read auth.users (which lives in the auth
-- schema) and write the invitations row regardless of the caller's
-- role. Runs as the function owner (typically postgres on Supabase),
-- which has SELECT on auth.users by default. Explicit search_path
-- prevents shadowing-attacks via the user's search_path.

create or replace function public.mark_invitation_accepted() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  user_email text;
begin
  -- The trigger is gated by the WHEN clause below so we only get here
  -- when display_name flipped from NULL to non-NULL — i.e. the user
  -- just finished onboarding. NEW is a profiles row, which doesn't
  -- carry email; pull it from auth.users explicitly.
  select au.email into user_email
    from auth.users au
   where au.id = new.id;

  if user_email is null then
    -- No corresponding auth.users row (shouldn't happen — profiles.id
    -- is FK'd to auth.users.id). Defensive bail so the UPDATE doesn't
    -- accidentally stamp every NULL-email invitation.
    return new;
  end if;

  update invitations
     set accepted_at = now()
   where lower(email) = lower(user_email)
     and accepted_at is null
     and cancelled_at is null;

  return new;
end $$;

-- ─── Wire the trigger with a column-level WHEN gate ─────────────────
--
-- The WHEN clause avoids running the auth.users lookup on every
-- profile UPDATE (display name changes in Settings, is_trainer flips
-- via promote_to_trainer, etc.). Fires only on the specific
-- transition we care about: first-time onboarding.

drop trigger if exists profiles_mark_invitation_accepted on profiles;
create trigger profiles_mark_invitation_accepted
  after update of display_name on profiles
  for each row
  when (old.display_name is null and new.display_name is not null)
  execute function public.mark_invitation_accepted();

-- ─── One-time backfill ──────────────────────────────────────────────
--
-- Flip every still-pending invitation whose recipient is already in
-- the app (profile exists with a non-NULL display_name). This
-- rescues all the pre-fix invitations that were stuck on NULL even
-- after the user onboarded — Alex from the bug report is the
-- canonical example.

update invitations inv
   set accepted_at = now()
 where inv.accepted_at is null
   and inv.cancelled_at is null
   and exists (
     select 1
       from auth.users au
       join profiles  p on p.id = au.id
      where lower(au.email) = lower(inv.email)
        and p.display_name is not null
   );

-- ─── Audit + verify recipe (commented out — paste into SQL editor) ──
--
-- After deploying this migration:
--   1. Confirm the trigger is registered:
--        select tgname from pg_trigger
--         where tgrelid = 'public.profiles'::regclass
--           and tgname = 'profiles_mark_invitation_accepted';
--   2. Confirm Alex's row got backfilled:
--        select email, accepted_at, already_existed, cancelled_at
--          from invitations
--         where email = 'alexelmo@gmail.com';
--   3. Smoke-test for a new invite end-to-end: invite a fresh
--      address, have the recipient onboard, then re-run query (2)
--      with that address and confirm accepted_at is non-NULL.
