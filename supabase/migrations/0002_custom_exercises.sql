-- 0002_custom_exercises.sql — Trainer-owned exercises, bundles, sharing,
-- and trainer-trainee designation. See docs/trainer-exercises-plan.md.
--
-- Pre-launch: no data preservation required. Slug-based exerciseId values
-- inside plans.exercises / sessions.exercises / favorites become UUIDs;
-- everything is truncated before column types change.

-- ─── Pre-launch reset ──────────────────────────────────────────────────

truncate table favorites, sessions, plans cascade;

-- ─── Exercises ─────────────────────────────────────────────────────────

create table exercises (
  id            uuid        primary key default gen_random_uuid(),
  owner_id      uuid        not null references profiles(id) on delete cascade,
  name_en       text,
  name_zh       text,
  muscle_group  text        not null,
  equipment     text,
  instructions  text,
  image_path    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- At least one language must be present; the UI falls back at display time.
  check (coalesce(name_en, name_zh) is not null)
);
create index exercises_owner          on exercises(owner_id) where deleted_at is null;
create index exercises_owner_updated  on exercises(owner_id, updated_at);

-- ─── Bundles (named collections of exercises) ─────────────────────────

create table exercise_bundles (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references profiles(id) on delete cascade,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index exercise_bundles_owner on exercise_bundles(owner_id) where deleted_at is null;

create table exercise_bundle_items (
  bundle_id   uuid        not null references exercise_bundles(id) on delete cascade,
  exercise_id uuid        not null references exercises(id) on delete restrict,
  position    int         not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (bundle_id, exercise_id)
);
create index exercise_bundle_items_exercise on exercise_bundle_items(exercise_id);

-- ─── Shares (granter → recipient access grants) ───────────────────────

create table shares (
  id            uuid        primary key default gen_random_uuid(),
  granter_id    uuid        not null references profiles(id) on delete cascade,
  recipient_id  uuid        not null references profiles(id) on delete cascade,
  resource_type text        not null check (resource_type in ('exercise','bundle','plan')),
  resource_id   uuid        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (resource_type, resource_id, recipient_id)
);
create index shares_recipient_resource on shares(recipient_id, resource_type, resource_id) where deleted_at is null;
create index shares_granter            on shares(granter_id) where deleted_at is null;

-- ─── Trainer–trainee designation with consent ─────────────────────────

create table trainer_trainees (
  trainer_id    uuid        not null references profiles(id) on delete cascade,
  trainee_id    uuid        not null references profiles(id) on delete cascade,
  status        text        not null default 'pending'
                check (status in ('pending','accepted','declined')),
  designated_at timestamptz not null default now(),
  responded_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (trainer_id, trainee_id)
);
create index trainer_trainees_trainee on trainer_trainees(trainee_id);

-- ─── Plans gain superseded_by (re-share lineage) ──────────────────────

alter table plans add column superseded_by uuid references plans(id) on delete set null;

-- Switch favorites.exercise_id from free-exercise-db slug (text) to UUID
-- referencing exercises.id. Truncate already happened above; just retype.
alter table favorites
  drop constraint favorites_pkey,
  drop column exercise_id,
  add  column exercise_id uuid not null references exercises(id) on delete restrict,
  add  primary key (user_id, exercise_id);

-- ─── plan_exercises: normalized projection of plans.exercises ────────
-- Re-derived by trigger on every plans write. RLS and access checks join
-- against this table instead of probing plans.exercises::jsonb (which has
-- no usable index). Resolves design-doc finding B2.

create table plan_exercises (
  plan_id     uuid not null references plans(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete restrict,
  position    int  not null,
  primary key (plan_id, exercise_id, position)
);
create index plan_exercises_exercise on plan_exercises(exercise_id);

create or replace function public.sync_plan_exercises() returns trigger
  language plpgsql as $$
begin
  delete from plan_exercises where plan_id = new.id;
  insert into plan_exercises (plan_id, exercise_id, position)
  select new.id,
         (elem->>'exerciseId')::uuid,
         (ord - 1)::int
    from jsonb_array_elements(new.exercises) with ordinality as t(elem, ord)
    where elem ? 'exerciseId';
  return new;
end $$;

create trigger plans_sync_exercises
  after insert or update of exercises on plans
  for each row execute function public.sync_plan_exercises();

-- ─── Touch updated_at triggers ────────────────────────────────────────

create trigger exercises_touch             before update on exercises             for each row execute function touch_updated_at();
create trigger exercise_bundles_touch      before update on exercise_bundles      for each row execute function touch_updated_at();
create trigger exercise_bundle_items_touch before update on exercise_bundle_items for each row execute function touch_updated_at();
create trigger shares_touch                before update on shares                for each row execute function touch_updated_at();
create trigger trainer_trainees_touch      before update on trainer_trainees      for each row execute function touch_updated_at();

-- ─── Helper: is there an accepted designation between two users? ─────

create or replace function public.has_accepted_designation(trainer uuid, trainee uuid)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from trainer_trainees
      where trainer_id = trainer and trainee_id = trainee and status = 'accepted'
    )
  $$;

revoke execute on function public.has_accepted_designation(uuid, uuid) from public;
grant  execute on function public.has_accepted_designation(uuid, uuid) to authenticated;

-- ─── Row-level security ───────────────────────────────────────────────

alter table exercises             enable row level security;
alter table exercise_bundles      enable row level security;
alter table exercise_bundle_items enable row level security;
alter table shares                enable row level security;
alter table trainer_trainees      enable row level security;
alter table plan_exercises        enable row level security;

-- Exercises: owner OR (accepted-designated recipient of a direct exercise
-- share) OR (accepted-designated recipient of a bundle share that contains
-- the exercise). Plan-share visibility is granted by emitting explicit
-- exercise shares from the share_plan RPC, so we don't traverse plans here.
create policy exercises_read on exercises for select using (
  owner_id = auth.uid()
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
create policy exercises_write on exercises for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Bundles: owner OR accepted-designated recipient of a bundle share.
create policy exercise_bundles_read on exercise_bundles for select using (
  owner_id = auth.uid()
  or exists (
    select 1 from shares s
    where s.deleted_at is null
      and s.recipient_id = auth.uid()
      and s.resource_type = 'bundle'
      and s.resource_id = exercise_bundles.id
      and public.has_accepted_designation(s.granter_id, auth.uid())
  )
);
create policy exercise_bundles_write on exercise_bundles for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Bundle items: visible if parent bundle is readable; mutable by parent owner.
create policy exercise_bundle_items_read on exercise_bundle_items for select using (
  exists (
    select 1 from exercise_bundles b
    where b.id = exercise_bundle_items.bundle_id
      and (b.owner_id = auth.uid() or exists (
        select 1 from shares s
        where s.deleted_at is null
          and s.recipient_id = auth.uid()
          and s.resource_type = 'bundle'
          and s.resource_id = b.id
          and public.has_accepted_designation(s.granter_id, auth.uid())
      ))
  )
);
create policy exercise_bundle_items_write on exercise_bundle_items for all
  using (exists (select 1 from exercise_bundles b where b.id = exercise_bundle_items.bundle_id and b.owner_id = auth.uid()))
  with check (exists (select 1 from exercise_bundles b where b.id = exercise_bundle_items.bundle_id and b.owner_id = auth.uid()));

-- Shares: granter writes (any op); recipient and granter can read.
create policy shares_read on shares for select using (
  granter_id = auth.uid() or recipient_id = auth.uid()
);
create policy shares_write on shares for all
  using (granter_id = auth.uid()) with check (granter_id = auth.uid());

-- Trainer-trainees: trainer inserts/deletes pending rows; trainee responds
-- (updates status + responded_at). Both can read their own rows.
create policy trainer_trainees_read on trainer_trainees for select using (
  trainer_id = auth.uid() or trainee_id = auth.uid()
);
create policy trainer_trainees_insert on trainer_trainees for insert
  with check (trainer_id = auth.uid());
create policy trainer_trainees_trainer_remove on trainer_trainees for delete
  using (trainer_id = auth.uid());
-- Trainee may update — application code restricts the columns it sets; a
-- column-level grant could lock this down further if the trainee-side
-- write surface ever expands beyond status/responded_at.
create policy trainer_trainees_trainee_respond on trainer_trainees for update
  using (trainee_id = auth.uid()) with check (trainee_id = auth.uid());

-- plan_exercises: read-only projection; read piggybacks on plans read.
create policy plan_exercises_read on plan_exercises for select using (
  exists (
    select 1 from plans p
    where p.id = plan_exercises.plan_id
      and (p.user_id = auth.uid() or public.is_trainer())
  )
);
-- No write policy — only the sync_plan_exercises trigger touches this table,
-- and it runs as table owner (RLS bypassed). Keeping any client from writing
-- here is a deliberate guardrail.

-- ─── share_plan RPC: clone + emit exercise grants atomically ──────────

create or replace function public.share_plan(plan_id uuid, recipient uuid)
  returns uuid language plpgsql security definer set search_path = public as $$
declare
  src plans%rowtype;
  new_id uuid;
  prev_id uuid;
begin
  -- Caller must own the source plan.
  select * into src from plans where id = plan_id and user_id = auth.uid();
  if not found then
    raise exception 'plan not found or not owned by caller';
  end if;

  -- Caller must have an accepted designation with the recipient.
  if not public.has_accepted_designation(auth.uid(), recipient) then
    raise exception 'no accepted designation with recipient';
  end if;

  -- Supersede any previous current assignment from this trainer to this trainee.
  select id into prev_id from plans
   where user_id = recipient and assigned_by = auth.uid() and superseded_by is null
   order by created_at desc limit 1;

  new_id := gen_random_uuid();
  insert into plans (id, user_id, assigned_by, name, week_start, focus, exercises, created_at)
  values (new_id, recipient, auth.uid(), src.name, src.week_start, src.focus, src.exercises, now());

  if prev_id is not null then
    update plans set superseded_by = new_id where id = prev_id;
  end if;

  -- Emit explicit exercise shares so the trainee can read every exercise the
  -- plan references, regardless of later plan edits. on-conflict-do-nothing
  -- keeps re-shares idempotent.
  insert into shares (granter_id, recipient_id, resource_type, resource_id)
  select auth.uid(), recipient, 'exercise', (elem->>'exerciseId')::uuid
    from jsonb_array_elements(src.exercises) elem
    where elem ? 'exerciseId'
  on conflict (resource_type, resource_id, recipient_id) do nothing;

  return new_id;
end $$;

revoke execute on function public.share_plan(uuid, uuid) from public;
grant  execute on function public.share_plan(uuid, uuid) to authenticated;
