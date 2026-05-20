-- 0007_diagnostics_reports.sql
--
-- User-initiated diagnostics uploads. The Settings → Diagnostics panel
-- (client side) collects the in-memory ring buffer + an environment
-- snapshot and POSTs it to the submit-diagnostics Edge Function, which
-- writes a row here. The user reads back a short_code to support.

-- ─── Table ─────────────────────────────────────────────────────────────

create table diagnostics_reports (
  id           uuid        primary key default gen_random_uuid(),
  -- 6-char Crockford base32 generated server-side by the Edge Function.
  -- Unambiguous alphabet (no 0/O/1/I/L); ~1 billion combinations.
  short_code   text        not null unique,
  user_id      uuid        not null references profiles(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  app_version  text,
  user_agent   text,
  locale       text,
  payload      jsonb       not null,  -- entries + env snapshot
  notes        text                    -- optional free-text from the user
);

create index diagnostics_user on diagnostics_reports(user_id, submitted_at desc);

-- ─── RLS ───────────────────────────────────────────────────────────────
--
-- Per docs/logging-plan.md S5: diagnostics payloads include the full
-- client log and are MORE sensitive than display names. Don't use the
-- broader is_trainer() predicate; restrict to the report owner OR a
-- trainer who has an `accepted` designation with this trainee.

alter table diagnostics_reports enable row level security;

create policy "diagnostics_reports_read" on diagnostics_reports for select using (
  user_id = auth.uid()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = diagnostics_reports.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);

-- No INSERT / UPDATE / DELETE policies — only service_role (the
-- submit-diagnostics Edge Function) writes rows. Reports are immutable.
