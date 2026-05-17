-- 0001_init.sql — Auth & Sync foundation (spec #1)

-- ─── Tables ────────────────────────────────────────────────────────────

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_trainer   boolean      not null default false,
  created_at   timestamptz  not null default now()
);

create table plans (
  id           uuid         primary key default gen_random_uuid(),
  user_id      uuid         not null references profiles(id) on delete cascade,
  assigned_by  uuid         references profiles(id) on delete set null,
  name         text         not null,
  week_start   date         not null,
  focus        text[]       not null,
  exercises    jsonb        not null,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now(),
  deleted_at   timestamptz
);

create table sessions (
  id           uuid         primary key default gen_random_uuid(),
  user_id      uuid         not null references profiles(id) on delete cascade,
  plan_id      uuid         references plans(id) on delete set null,
  date         date         not null,
  exercises    jsonb        not null,
  notes        text,
  started_at   timestamptz  not null,
  ended_at     timestamptz,
  updated_at   timestamptz  not null default now(),
  deleted_at   timestamptz
);

create table metrics (
  id           uuid         primary key default gen_random_uuid(),
  user_id      uuid         not null references profiles(id) on delete cascade,
  date         date         not null,
  weight_kg    numeric,
  height_cm    numeric,
  body_fat_pct numeric,
  notes        text,
  updated_at   timestamptz  not null default now(),
  deleted_at   timestamptz
);

create table favorites (
  user_id      uuid         not null references profiles(id) on delete cascade,
  exercise_id  text         not null,
  added_at     timestamptz  not null default now(),
  updated_at   timestamptz  not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, exercise_id)
);

-- ─── Triggers ──────────────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger plans_touch     before update on plans     for each row execute function touch_updated_at();
create trigger sessions_touch  before update on sessions  for each row execute function touch_updated_at();
create trigger metrics_touch   before update on metrics   for each row execute function touch_updated_at();
create trigger favorites_touch before update on favorites for each row execute function touch_updated_at();

create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, is_trainer)
  values (NEW.id, nullif(NEW.raw_user_meta_data->>'display_name', ''), false);
  return NEW;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Helper function ───────────────────────────────────────────────────

create or replace function public.is_trainer() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select is_trainer from profiles where id = auth.uid()), false)
  $$;

revoke execute on function public.is_trainer() from public;
grant  execute on function public.is_trainer() to authenticated;

-- ─── Trainer-names view (used by spec #2) ─────────────────────────────

create or replace view public.trainer_names with (security_invoker = off) as
  select id, display_name from public.profiles where is_trainer = true;

grant select on public.trainer_names to authenticated;

-- ─── Row Level Security ────────────────────────────────────────────────

alter table profiles  enable row level security;
alter table plans     enable row level security;
alter table sessions  enable row level security;
alter table metrics   enable row level security;
alter table favorites enable row level security;

create policy "plans_read"     on plans     for select using (user_id = auth.uid() OR public.is_trainer());
create policy "sessions_read"  on sessions  for select using (user_id = auth.uid() OR public.is_trainer());
create policy "metrics_read"   on metrics   for select using (user_id = auth.uid() OR public.is_trainer());
create policy "favorites_read" on favorites for select using (user_id = auth.uid() OR public.is_trainer());
create policy "profiles_read"  on profiles  for select using (id      = auth.uid() OR public.is_trainer());

create policy "plans_write"     on plans     for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "sessions_write"  on sessions  for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "metrics_write"   on metrics   for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "favorites_write" on favorites for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profiles_write"  on profiles  for update using (id      = auth.uid()) with check (id      = auth.uid());
