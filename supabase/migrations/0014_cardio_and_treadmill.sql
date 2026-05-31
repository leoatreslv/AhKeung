-- 0014_cardio_and_treadmill.sql
--
-- Adds a cardio exercise modality and a default, globally-readable
-- Treadmill so every user can plan/log/share it. Treadmill is a real
-- exercises row (not a client constant) because plan_exercises (trigger,
-- 0002:113-115), favorites (0002:93) and exercise_bundle_items (0002:47)
-- all `references exercises(id)` with a uuid cast — a client-only id would
-- fail those FKs.
--
-- See docs/superpowers/specs/2026-05-31-cardio-exercises-treadmill-design.md

-- 1. Modality column; existing + custom rows default to strength.
alter table exercises
  add column if not exists kind text not null default 'strength'
    check (kind in ('strength', 'cardio'));

-- 2. Global-visibility flag (server-only; never synced to clients).
alter table exercises
  add column if not exists is_global boolean not null default false;

-- 3. Widen the read policy to expose global rows. Owner + share clauses
--    are copied verbatim from 0002:160-179; only the is_global line is new.
drop policy if exists exercises_read on exercises;
create policy exercises_read on exercises for select using (
  owner_id = auth.uid()
  or exercises.is_global
  or exists (
    select 1 from shares s
    where s.deleted_at is null
      and s.recipient_id = auth.uid()
      and s.resource_type = 'exercise'
      and s.resource_id = exercises.id
      and public.has_accepted_designation(s.granter_id, auth.uid())
  )
  or exists (
    select 1 from shares s
    join exercise_bundle_items i on i.bundle_id = s.resource_id
    where s.deleted_at is null
      and s.recipient_id = auth.uid()
      and s.resource_type = 'bundle'
      and i.exercise_id = exercises.id
      and public.has_accepted_designation(s.granter_id, auth.uid())
  )
);

-- 4. Seed the default Treadmill (fixed UUID so the id is stable across
--    environments), owned by the first admin per 0013. Idempotent.
insert into exercises (id, owner_id, name_en, name_zh, muscle_group, kind, is_global)
select '11111111-1111-4111-8111-111111111111',
       p.id, 'Treadmill', '跑步機', 'cardio', 'cardio', true
  from profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'leo@reslv.io'
on conflict (id) do nothing;
