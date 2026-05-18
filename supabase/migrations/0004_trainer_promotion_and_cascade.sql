-- 0004_trainer_promotion_and_cascade.sql
--
-- (1) Lets an existing trainer promote any user to trainer via the
--     promote_to_trainer(target) RPC. Also tightens the profiles_write
--     RLS so users can't flip their own is_trainer flag (only the RPC
--     can change it). This partially addresses O17 from the design
--     doc — the bootstrap problem (creating the very first trainer)
--     remains a service-role-only step, but normal users can no
--     longer self-elevate.
--
-- (2) Cascades exercise soft-deletes into exercise_bundle_items: when
--     a trainer marks one of their exercises as deleted_at, every
--     bundle_items row that referenced it is hard-deleted. Without
--     this, bundles linger with ghost items the trainee can't tell
--     apart from a real exercise. Client also cascades locally so
--     the trainer's Dexie reflects the change immediately.

-- ─── promote_to_trainer RPC ──────────────────────────────────────────

create or replace function public.promote_to_trainer(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trainer() then
    raise exception 'only trainers may promote other users';
  end if;
  update profiles set is_trainer = true where id = target;
end $$;

revoke execute on function public.promote_to_trainer(uuid) from public;
grant  execute on function public.promote_to_trainer(uuid) to authenticated;

-- ─── Tighten profiles_write to forbid self-elevation ─────────────────
-- Keeps the existing "update your own row" semantics for display_name
-- etc., but the WITH CHECK requires that is_trainer in the new row
-- matches the existing value. Any UPDATE that changes is_trainer fails
-- the check; only the SECURITY DEFINER RPC above (which runs as the
-- function owner and bypasses RLS) can flip it.

drop policy if exists "profiles_write" on profiles;
create policy "profiles_write" on profiles for update
  using  (id = auth.uid())
  with check (
    id = auth.uid()
    and is_trainer = (select is_trainer from profiles where id = auth.uid())
  );

-- ─── Cascade exercise soft-delete → bundle_items ─────────────────────

create or replace function public.cascade_exercise_soft_delete() returns trigger
  language plpgsql as $$
begin
  if new.deleted_at is not null and (old.deleted_at is null) then
    delete from exercise_bundle_items where exercise_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists exercises_cascade_delete on exercises;
create trigger exercises_cascade_delete
  after update of deleted_at on exercises
  for each row execute function public.cascade_exercise_soft_delete();
