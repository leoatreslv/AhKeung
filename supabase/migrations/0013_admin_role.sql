-- 0013_admin_role.sql
--
-- Adds a third role (`is_admin`) that owns invite/promote/audit-read
-- power. Reworks several RLS policies and RPCs accordingly:
--   - profiles_write/profiles_read: extend to is_admin
--   - invitations_*: widen READ to admin; replace cancel with admin-only
--   - audit_events_read: add admin (preserves trainer-of-accepted clause)
--   - promote_to_trainer: guard swap is_trainer -> is_admin (preserves
--     trainer.promoted audit emit from 0008)
--   - promote_to_admin (new): admin-only with admin.promoted audit emit
--   - designate_invited_user: dropped (path replaced by AdminInvites'
--     read-only "awaiting designation" list + trainer search-designate)
--
-- Triggers verified unaffected: handle_new_user (0001), mark_invitation_accepted
-- (0010), trainer_trainees_mark_invitation_designated (0012), all audit_*
-- triggers (0008), cascade_exercise_soft_delete (0004). The new is_admin
-- column gets default false on signups.
--
-- See docs/superpowers/specs/2026-05-25-role-separation-ui-design.md

-- 1. Column
alter table profiles
  add column is_admin boolean not null default false;

-- 2. Seed Leo as the first admin.
update profiles p
   set is_admin = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'leo@reslv.io';

-- 3. Helper, mirrors is_trainer() defined in 0001.
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select is_admin from profiles where id = auth.uid()), false)
  $$;
revoke execute on function public.is_admin() from public;
grant  execute on function public.is_admin() to authenticated;

-- 4. Tighten profiles_write so is_admin cannot be self-flipped.
drop policy if exists "profiles_write" on profiles;
create policy "profiles_write" on profiles for update
  using  (id = auth.uid())
  with check (
    id = auth.uid()
    and is_trainer = (select is_trainer from profiles where id = auth.uid())
    and is_admin   = (select is_admin   from profiles where id = auth.uid())
  );

-- 5. profiles_read gains admin visibility (needed for AdminUsers search).
drop policy if exists "profiles_read" on profiles;
create policy "profiles_read" on profiles for select
  using (id = auth.uid() OR public.is_trainer() OR public.is_admin());

-- 6. promote_to_trainer RPC: guard swap is_trainer -> is_admin.
--    PRESERVES the trainer.promoted audit emit from 0008.
create or replace function public.promote_to_trainer(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins may promote users to trainer';
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

-- 7. New: promote_to_admin RPC (admin-only), matching audit emit.
create or replace function public.promote_to_admin(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins may promote users to admin';
  end if;
  update profiles set is_admin = true where id = target;
  perform public.emit_audit_event(
    auth.uid(),
    'admin.promoted',
    jsonb_build_object('type', 'profile', 'id', target),
    jsonb_build_object('promoter', auth.uid(), 'promoted', target)
  );
end $$;
revoke execute on function public.promote_to_admin(uuid) from public;
grant  execute on function public.promote_to_admin(uuid) to authenticated;

-- 8. Invitations policies: replace inviter-only with widened READ
--    + admin-only UPDATE. Column-level grant on cancelled_at from
--    0006 stays in force (admin still updates only cancelled_at).
drop policy if exists "invitations_read_inviter" on invitations;
create policy "invitations_read" on invitations for select
  using (inviter_id = auth.uid() OR public.is_admin());

drop policy if exists "invitations_cancel_inviter" on invitations;
create policy "invitations_cancel_admin" on invitations for update
  using (public.is_admin()) with check (public.is_admin());

-- 9. audit_events read: keep trainer-of-accepted clause, add admin.
drop policy if exists audit_events_read on audit_events;
create policy audit_events_read on audit_events for select using (
  user_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = audit_events.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);

-- 10. designate_invited_user RPC dropped. Lineage: introduced in 0011,
--     redefined in 0012. AdminInvites surfaces orphaned invitees as
--     a read-only signal; trainer designates via search.
drop function if exists public.designate_invited_user(uuid);
