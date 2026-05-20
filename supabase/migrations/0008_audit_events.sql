-- 0008_audit_events.sql
--
-- Server-side audit trail for business-meaningful state transitions.
-- See docs/logging-plan.md (Layer 4 / Server-side audit trail).
--
-- Sources: triggers + Edge Functions / RPCs (both).
--   - Triggers are the source-of-truth for "did the row change."
--     They read the actor from NEW.* / OLD.* columns directly, since
--     auth.uid() is NULL inside a trigger context running under
--     service_role (every invite-user / share_plan / promote_to_trainer
--     call). See B2 in the plan.
--   - Edge Functions / RPCs emit events that need per-call context
--     the trigger can't see (original_plan_id, promoter, alreadyExisted
--     branch metadata). See B1.
--
-- All trigger functions are SECURITY DEFINER so they can write into
-- audit_events regardless of the caller's role. audit_events has a
-- SELECT-only RLS policy; INSERT happens only via these definer
-- functions (or service_role inside the Edge Functions).
--
-- Deploy:
--   supabase db push
--   supabase functions deploy invite-user

-- ─── Table ──────────────────────────────────────────────────────────

create table audit_events (
  id         uuid        primary key default gen_random_uuid(),
  -- W14: nullable on purpose. NULL means "system event" (cron prune,
  -- scheduled task). Human-attributable events MUST populate from
  -- NEW.* — the triggers below do so explicitly.
  user_id    uuid        references profiles(id) on delete set null,
  event_type text        not null,
  resource   jsonb,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_user on audit_events(user_id, created_at desc);
create index audit_events_type on audit_events(event_type, created_at desc);

alter table audit_events enable row level security;

-- SELECT: owner OR a trainer with an 'accepted' designation to that
-- user (S5 — same tightening as diagnostics_reports). No INSERT /
-- UPDATE / DELETE policies; only the SECURITY DEFINER triggers /
-- functions below write rows.
create policy audit_events_read on audit_events for select using (
  user_id = auth.uid()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = audit_events.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);

-- ─── Helpers ────────────────────────────────────────────────────────

-- Server-side email mask. Mirrors the JS maskEmail in
-- src/diagnostics/logger.ts: `leo@reslv.io` → `l**@reslv.io`.
-- Used by the invitations.insert trigger; the Edge Function emit on
-- the already_existed branch produces the same shape.
create or replace function public.mask_email(s text) returns text
  language sql immutable as $$
    select case
      when s is null or position('@' in s) < 2 then s
      else substring(s from 1 for 1)
        || repeat('*', greatest(1, position('@' in s) - 2))
        || substring(s from position('@' in s))
    end
$$;

-- Centralised insert so trigger functions stay readable. SECURITY
-- DEFINER so it bypasses the audit_events RLS policy regardless of
-- caller role.
create or replace function public.emit_audit_event(
  p_user_id    uuid,
  p_event_type text,
  p_resource   jsonb default null,
  p_metadata   jsonb default null
) returns void
  language sql security definer set search_path = public as $$
    insert into audit_events (user_id, event_type, resource, metadata)
    values (p_user_id, p_event_type, p_resource, p_metadata);
$$;

revoke execute on function public.emit_audit_event(uuid, text, jsonb, jsonb) from public;
grant  execute on function public.emit_audit_event(uuid, text, jsonb, jsonb) to service_role;

-- ─── invitations triggers ─────────────────────────────────────────
-- B1: gate invite.sent on NEW.already_existed=false; the Edge
-- Function emits invite.already_existed for the other branch.

create or replace function public.audit_invitations_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.already_existed then
    return new;
  end if;
  perform public.emit_audit_event(
    new.inviter_id,
    'invite.sent',
    jsonb_build_object('type', 'invitation', 'id', new.id),
    jsonb_build_object('email_masked', public.mask_email(new.email))
  );
  return new;
end $$;

drop trigger if exists invitations_audit_insert on invitations;
create trigger invitations_audit_insert
  after insert on invitations
  for each row execute function public.audit_invitations_insert();

create or replace function public.audit_invitations_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null then
    perform public.emit_audit_event(
      new.inviter_id,
      'invite.cancelled',
      jsonb_build_object('type', 'invitation', 'id', new.id),
      null
    );
  end if;
  if new.accepted_at is not null and old.accepted_at is null then
    perform public.emit_audit_event(
      new.inviter_id,
      'invite.accepted',
      jsonb_build_object('type', 'invitation', 'id', new.id),
      null
    );
  end if;
  return new;
end $$;

drop trigger if exists invitations_audit_update on invitations;
create trigger invitations_audit_update
  after update on invitations
  for each row execute function public.audit_invitations_update();

-- ─── trainer_trainees triggers ────────────────────────────────────
-- Actor: trainer on create / remove; trainee on accept / decline.

create or replace function public.audit_trainer_trainees_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_audit_event(
    new.trainer_id,
    'designation.created',
    jsonb_build_object('type', 'trainer_trainee',
                       'trainer_id', new.trainer_id,
                       'trainee_id', new.trainee_id),
    null
  );
  return new;
end $$;

drop trigger if exists trainer_trainees_audit_insert on trainer_trainees;
create trigger trainer_trainees_audit_insert
  after insert on trainer_trainees
  for each row execute function public.audit_trainer_trainees_insert();

create or replace function public.audit_trainer_trainees_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform public.emit_audit_event(
      new.trainee_id,
      'designation.accepted',
      jsonb_build_object('type', 'trainer_trainee',
                         'trainer_id', new.trainer_id,
                         'trainee_id', new.trainee_id),
      null
    );
  elsif new.status = 'declined' and old.status is distinct from 'declined' then
    perform public.emit_audit_event(
      new.trainee_id,
      'designation.declined',
      jsonb_build_object('type', 'trainer_trainee',
                         'trainer_id', new.trainer_id,
                         'trainee_id', new.trainee_id),
      null
    );
  end if;
  return new;
end $$;

drop trigger if exists trainer_trainees_audit_update on trainer_trainees;
create trigger trainer_trainees_audit_update
  after update on trainer_trainees
  for each row execute function public.audit_trainer_trainees_update();

create or replace function public.audit_trainer_trainees_delete() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_audit_event(
    old.trainer_id,
    'designation.removed',
    jsonb_build_object('type', 'trainer_trainee',
                       'trainer_id', old.trainer_id,
                       'trainee_id', old.trainee_id),
    null
  );
  return old;
end $$;

drop trigger if exists trainer_trainees_audit_delete on trainer_trainees;
create trigger trainer_trainees_audit_delete
  after delete on trainer_trainees
  for each row execute function public.audit_trainer_trainees_delete();

-- ─── shares triggers ──────────────────────────────────────────────

create or replace function public.audit_shares_insert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null then
    perform public.emit_audit_event(
      new.granter_id,
      'share.created',
      jsonb_build_object('type', new.resource_type, 'id', new.resource_id),
      jsonb_build_object('share_id', new.id, 'recipient', new.recipient_id)
    );
  end if;
  return new;
end $$;

drop trigger if exists shares_audit_insert on shares;
create trigger shares_audit_insert
  after insert on shares
  for each row execute function public.audit_shares_insert();

create or replace function public.audit_shares_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform public.emit_audit_event(
      new.granter_id,
      'share.revoked',
      jsonb_build_object('type', new.resource_type, 'id', new.resource_id),
      jsonb_build_object('share_id', new.id, 'recipient', new.recipient_id)
    );
  end if;
  return new;
end $$;

drop trigger if exists shares_audit_update on shares;
create trigger shares_audit_update
  after update on shares
  for each row execute function public.audit_shares_update();

-- ─── exercises / exercise_bundles soft-delete triggers ────────────

create or replace function public.audit_exercises_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform public.emit_audit_event(
      new.owner_id,
      'exercise.deleted',
      jsonb_build_object('type', 'exercise', 'id', new.id),
      null
    );
  end if;
  return new;
end $$;

drop trigger if exists exercises_audit_update on exercises;
create trigger exercises_audit_update
  after update of deleted_at on exercises
  for each row execute function public.audit_exercises_update();

create or replace function public.audit_exercise_bundles_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform public.emit_audit_event(
      new.owner_id,
      'bundle.deleted',
      jsonb_build_object('type', 'bundle', 'id', new.id),
      null
    );
  end if;
  return new;
end $$;

drop trigger if exists exercise_bundles_audit_update on exercise_bundles;
create trigger exercise_bundles_audit_update
  after update of deleted_at on exercise_bundles
  for each row execute function public.audit_exercise_bundles_update();

-- ─── share_plan RPC: emit plan.shared with original→cloned mapping ─
-- The shares-INSERT trigger covers the per-exercise grants the RPC
-- emits, but the trigger can't see the original plan id (the cloned
-- plan row has no back-reference at insert time). Re-defining the RPC
-- here so the emit ships in this migration.

create or replace function public.share_plan(plan_id uuid, recipient uuid)
  returns uuid language plpgsql security definer set search_path = public as $$
declare
  src plans%rowtype;
  new_id uuid;
  prev_id uuid;
  exercise_count int;
begin
  select * into src from plans where id = plan_id and user_id = auth.uid();
  if not found then
    raise exception 'plan not found or not owned by caller';
  end if;

  if not public.has_accepted_designation(auth.uid(), recipient) then
    raise exception 'no accepted designation with recipient';
  end if;

  select id into prev_id from plans
   where user_id = recipient and assigned_by = auth.uid() and superseded_by is null
   order by created_at desc limit 1;

  new_id := gen_random_uuid();
  insert into plans (id, user_id, assigned_by, name, week_start, focus, exercises, created_at)
  values (new_id, recipient, auth.uid(), src.name, src.week_start, src.focus, src.exercises, now());

  if prev_id is not null then
    update plans set superseded_by = new_id where id = prev_id;
  end if;

  insert into shares (granter_id, recipient_id, resource_type, resource_id)
  select auth.uid(), recipient, 'exercise', (elem->>'exerciseId')::uuid
    from jsonb_array_elements(src.exercises) elem
    where elem ? 'exerciseId'
  on conflict (resource_type, resource_id, recipient_id) do nothing;

  select count(*)::int into exercise_count
    from jsonb_array_elements(src.exercises) elem
   where elem ? 'exerciseId';

  perform public.emit_audit_event(
    auth.uid(),
    'plan.shared',
    jsonb_build_object('type', 'plan', 'id', new_id),
    jsonb_build_object(
      'original_plan_id', plan_id,
      'cloned_plan_id',   new_id,
      'recipient',        recipient,
      'exercise_count',   exercise_count,
      'superseded_id',    prev_id
    )
  );

  return new_id;
end $$;

revoke execute on function public.share_plan(uuid, uuid) from public;
grant  execute on function public.share_plan(uuid, uuid) to authenticated;

-- ─── promote_to_trainer RPC: emit trainer.promoted ────────────────

create or replace function public.promote_to_trainer(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trainer() then
    raise exception 'only trainers may promote other users';
  end if;
  update profiles set is_trainer = true where id = target;
  perform public.emit_audit_event(
    auth.uid(),
    'trainer.promoted',
    jsonb_build_object('type', 'profile', 'id', target),
    jsonb_build_object('promoter', auth.uid(), 'promoted', target)
  );
end $$;

revoke execute on function public.promote_to_trainer(uuid) from public;
grant  execute on function public.promote_to_trainer(uuid) to authenticated;

-- ─── 90-day TTL via pg_cron ───────────────────────────────────────
-- S8: at peak this table grows ~15 MB/day at 100 users — ~1.5 GB at
-- 90 days. The TTL job has to actually run; declaring it here keeps
-- the policy alongside the schema.
--
-- pg_cron must be enabled in Dashboard → Database → Extensions. If
-- your tier doesn't include pg_cron, the fallback is a Supabase Edge
-- Function on a GitHub-Actions cron that runs the same DELETE.
-- (See docs/operational-runbook.md — added in this PR.)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'prune-audit-events') then
      perform cron.unschedule('prune-audit-events');
    end if;
    perform cron.schedule(
      'prune-audit-events',
      '0 3 * * *',
      'delete from audit_events where created_at < now() - interval ''90 days'';'
    );
  end if;
end $$;
