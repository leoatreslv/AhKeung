-- 0011_designate_invited_user.sql
--
-- One-tap "Designate" from an accepted invitation row. The
-- invitations table only carries the recipient's email; the
-- trainer_trainees table needs their auth.users.id. The client
-- can't read auth.users directly, so this RPC bridges the gap:
-- resolves email → user_id, then inserts trainer_trainees with
-- status='pending'.
--
-- Closes the UX gap left by 0006's deliberate decision to NOT
-- auto-designate on invite acceptance (since the inviter may not
-- be the trainee's designated trainer). With PR 1 in place to
-- stamp accepted_at correctly, the trainer can now see "this
-- recipient joined" and tap one button to start the designation
-- ceremony.

create or replace function public.designate_invited_user(invitation_id uuid)
  returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  inv     invitations%rowtype;
  trainee uuid;
begin
  -- Caller must own the invitation row. RLS already enforces this
  -- on SELECT, but a SECURITY DEFINER function reads with elevated
  -- privileges — re-check explicitly so a tampered invitation_id
  -- can't escalate access.
  select * into inv from invitations
   where id = invitation_id
     and inviter_id = auth.uid();
  if not found then
    raise exception 'invitation not found or not owned by caller';
  end if;

  -- Caller must be a trainer.
  if not public.is_trainer() then
    raise exception 'only trainers may designate';
  end if;

  -- Recipient must have actually joined (display_name set, which
  -- is what the 0010 trigger keys off when stamping accepted_at).
  if inv.accepted_at is null then
    raise exception 'invitation not yet accepted';
  end if;
  if inv.cancelled_at is not null then
    raise exception 'invitation has been cancelled';
  end if;

  -- Resolve email → user_id. Case-insensitive because the trigger
  -- in 0006 normalises by lower(email).
  select id into trainee from auth.users
   where lower(email) = lower(inv.email)
   limit 1;
  if trainee is null then
    -- accepted_at was stamped but the user has since deleted their
    -- account. Surface as a real error so the UI can react.
    raise exception 'recipient no longer has an account';
  end if;

  -- Insert or refresh the designation. Idempotent:
  --   - no existing row → new 'pending' row.
  --   - already pending  → leave it (no spurious updated_at bump).
  --   - already accepted → leave it (don't reset their consent).
  --   - previously declined → flip back to 'pending' so the
  --     trainee gets another chance to accept (responded_at cleared
  --     so the trainee-side banner re-appears).
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

  return trainee;
end $$;

revoke execute on function public.designate_invited_user(uuid) from public;
grant  execute on function public.designate_invited_user(uuid) to authenticated;
