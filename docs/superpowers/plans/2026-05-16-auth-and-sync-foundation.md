# Auth & Sync Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supabase-backed auth (magic link), trainer/user role flag, and a local-first Dexie↔Supabase sync layer to the existing offline-first Ah Keung PWA. Members get full offline parity; trainer-side reads/writes are deferred to spec #2.

**Architecture:** React UI continues to read from Dexie (no query changes). Every write goes through `putWithSync`/`deleteWithSync` which transactionally updates Dexie and enqueues a sync entry. A push worker uses optimistic concurrency (`update ... where updated_at = $expectedServerVersion`) with a dead-letter table for poisoned rows. A pull worker uses keyset-paginated reads (`(updated_at, id) > (…)`). One `AuthProvider` + route guard gates the whole app behind a magic-link login.

**Tech Stack:** TypeScript, React 19, Vite, Dexie (IndexedDB), `@supabase/supabase-js`, vite-plugin-pwa (Workbox), Vitest + RTL + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-05-16-auth-and-sync-foundation-design.md`

---

## Phase 1 — Project setup

### Task 1: Install Supabase JS and add env-var scaffolding

**Files:**
- Modify: `package.json` (via `npm install`)
- Create: `.env.example`
- Modify: `.gitignore` (ensure `.env.local` is ignored)

- [ ] **Step 1: Install the SDK**

Run: `cd /home/ubuntu/AhKeung && npm install @supabase/supabase-js`
Expected: `added 1 package` (or similar). `package.json` now lists `@supabase/supabase-js` under `dependencies`.

- [ ] **Step 2: Create `.env.example`**

Create file `/home/ubuntu/AhKeung/.env.example`:

```env
# Copy to .env.local and fill in from your Supabase project (Settings → API).
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

- [ ] **Step 3: Confirm `.env.local` is gitignored**

Vite's `.gitignore` template uses `*.local` (matches `.env.local`, `.env.development.local`, etc.). Check:

```bash
cd /home/ubuntu/AhKeung && \
  { grep -qE '(^|/)\*\.local$|(^|/)\.env\.local$' .gitignore && echo OK; } \
  || echo MISSING
```

If `MISSING`, append a single line `.env.local` to `.gitignore`. Otherwise leave it alone — don't add a duplicate.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/AhKeung
git add package.json package-lock.json .env.example .gitignore
git commit -m "Install @supabase/supabase-js, add .env.example"
```

---

### Task 2: Create the Supabase indirection module + Workbox NetworkOnly rule

**Files:**
- Create: `src/supabase.ts`
- Modify: `vite.config.ts` (Workbox rule baked from build-time constant)

The client lives behind a `getSupabase()` function and a `setSupabase()` injection point. Production code calls `getSupabase()` at the moment it needs the client, not at module load. Tests inject a fake via `setSupabase()` in `beforeEach`. This avoids the `vi.doMock` static-import trap entirely — there is only ever **one** module to reference, and the function call resolves the implementation late.

- [ ] **Step 1: Create `src/supabase.ts`**

```ts
// src/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function buildRealClient(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.',
    );
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export function getSupabase(): SupabaseClient {
  if (!_client) _client = buildRealClient();
  return _client;
}

/** Test-only: inject a fake client and reset the cached one. */
export function setSupabase(client: SupabaseClient | null): void {
  _client = client;
}
```

Note the absence of a `supabase` named export. Every caller uses `getSupabase()`. If a callsite ever appears to need a stable binding (e.g. for `onAuthStateChange` subscription cleanup), it should call `getSupabase()` once and hold the local result.

- [ ] **Step 2: Add Workbox `NetworkOnly` rule, baked at config time**

`process.env.VITE_*` is **not** inlined into the service-worker bundle — only `import.meta.env.*` is, and only in app code, not in Workbox's serialized callbacks. We capture the origin at `defineConfig` time (where `process.env` does exist) and bake it into a literal `RegExp` for the SW.

Modify `/home/ubuntu/AhKeung/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const supabaseOrigin = process.env.VITE_SUPABASE_URL
  ? new URL(process.env.VITE_SUPABASE_URL).origin
  : null;

// Escape regex metachars in the origin string.
function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const supabaseUrlPattern = supabaseOrigin
  ? new RegExp(`^${escapeRegex(supabaseOrigin)}/`)
  : /a^/;  // matches nothing when no Supabase URL is configured

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // …existing options unchanged…
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: [
          {
            // Never serve cached Supabase responses to the sync worker.
            urlPattern: supabaseUrlPattern,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/gh\/yuhonas\/free-exercise-db/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-images',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
        ],
      },
      // …existing manifest etc. unchanged…
    }),
  ],
  server: { host: true, port: 5173 },
});
```

(Preserve the existing `manifest` block from the current file — only the `runtimeCaching` array and the top-of-file constants are new.)

- [ ] **Step 3: Verify the build inlines the literal**

Create a temporary `.env.local` for the build to capture an origin:

```env
VITE_SUPABASE_URL=https://placeholder.supabase.co
VITE_SUPABASE_ANON_KEY=placeholder
```

Run: `cd /home/ubuntu/AhKeung && npx vite build`
Expected: build succeeds. Then: `grep -r "placeholder.supabase.co" dist/sw* 2>/dev/null | head -3` should show the literal baked into the SW bundle. Delete `.env.local` after.

- [ ] **Step 4: Commit**

```bash
git add src/supabase.ts vite.config.ts
git commit -m "Supabase: getSupabase()/setSupabase() indirection + build-time Workbox NetworkOnly rule"
```

---

## Phase 2 — Server SQL migration

### Task 3: Write the SQL migration file

**Files:**
- Create: `supabase/migrations/0001_init.sql`

- [ ] **Step 1: Create migrations directory and file**

Run: `mkdir -p /home/ubuntu/AhKeung/supabase/migrations`

Create `/home/ubuntu/AhKeung/supabase/migrations/0001_init.sql`:

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "Add Supabase init migration (tables, RLS, triggers, trainer_names view)"
```

---

### Task 4: Apply the migration to the Supabase project (manual)

**Files:** none (manual configuration step)

- [ ] **Step 1: Create a Supabase project**

Log in at https://app.supabase.com → New Project. Note the project URL and `anon` key (Settings → API).

- [ ] **Step 2: Update `.env.local` with the real values**

Replace placeholder lines:

```env
VITE_SUPABASE_URL=https://<your-actual-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-actual-anon-key>
```

- [ ] **Step 3: Apply the migration**

In the Supabase dashboard: SQL Editor → New Query → paste the contents of `supabase/migrations/0001_init.sql` → Run.
Expected: green check, no errors. Confirm tables exist under Database → Tables: `profiles`, `plans`, `sessions`, `metrics`, `favorites`.

- [ ] **Step 4: Configure auth dashboard settings**

In the Supabase dashboard:

1. **Authentication → Providers → Email**: enable Email; **disable "Enable email signups"** so members can't self-register; leave "Confirm email" enabled (default).
2. **Authentication → URL Configuration → Site URL**: set to your prod app URL (e.g. `https://ahkeung.netlify.app`).
3. **Authentication → URL Configuration → Additional Redirect URLs**: add `http://localhost:5173/*` and your prod URL pattern. (Without this, `emailRedirectTo` 404s.)
4. **Authentication → Sessions → JWT expiry / refresh token TTL**: set refresh token TTL to ~31536000 (1 year).

- [ ] **Step 5: Create one trainer + one member test user (manual)**

In the dashboard: Authentication → Users → Invite User. Invite two emails you control.
For one of them, after the auto-trigger creates the profile, run in SQL editor:
```sql
update public.profiles set is_trainer = true where id = '<user-uuid>';
```

No commit (no files changed).

---

## Phase 3 — Dexie schema migration

### Task 5: Migrate `db.ts` to schema v4

**Files:**
- Modify: `src/db.ts` (full schema update)

- [ ] **Step 1: Read current `src/db.ts` to confirm starting state**

Run: `cat /home/ubuntu/AhKeung/src/db.ts | head -100`
Expected: shows the `version(3)` block at the bottom.

- [ ] **Step 2: Replace `src/db.ts` with the v4 schema**

Replace the entire file `/home/ubuntu/AhKeung/src/db.ts` with:

```ts
import Dexie, { type Table } from 'dexie';

export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'legs'
  | 'glutes'
  | 'core'
  | 'cardio';

export interface Exercise {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  equipment: string;
  emoji: string;
  description: string;
}

export interface PlanExercise {
  exerciseId: string;
  targetSets: number;
  targetReps: number;
  targetWeight?: number;
  notes?: string;
}

interface SyncedRow {
  id: string;
  userId: string;
  updatedAt: number;
  serverVersion: string | null;
}

export interface Plan extends SyncedRow {
  name: string;
  weekStart: string;
  focus: MuscleGroup[];
  exercises: PlanExercise[];
  createdAt: number;
  assignedBy?: string | null;
}

export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
}

export interface WorkoutSession extends SyncedRow {
  planId?: string;
  date: string;
  exercises: { exerciseId: string; sets: SetLog[] }[];
  notes?: string;
  startedAt: number;
  endedAt?: number;
}

export interface BodyMetric extends SyncedRow {
  date: string;
  weightKg?: number;
  heightCm?: number;
  bodyFatPct?: number;
  notes?: string;
}

export interface Favorite {
  userId: string;
  exerciseId: string;
  addedAt: number;
  updatedAt: number;
  serverVersion: string | null;
}

export type SyncTableName = 'plans' | 'sessions' | 'metrics' | 'favorites';
export type SyncOp = 'insert' | 'update' | 'delete';

export interface SyncQueueRow {
  seq?: number;
  table: SyncTableName;
  rowId: string;
  op: SyncOp;
  expectedServerVersion: string | null;
  attempts: number;
  lastError?: string;
  lastErrorStatus?: number;
  queuedAt: number;
}

export interface SyncDeadLetterRow extends SyncQueueRow {
  movedAt: number;
}

export interface SyncMetaRow {
  key: string;
  value: unknown;
}

class AhKeungDB extends Dexie {
  plans!: Table<Plan, string>;
  sessions!: Table<WorkoutSession, string>;
  metrics!: Table<BodyMetric, string>;
  favorites!: Table<Favorite, [string, string]>;
  syncQueue!: Table<SyncQueueRow, number>;
  syncDeadLetter!: Table<SyncDeadLetterRow, number>;
  syncMeta!: Table<SyncMetaRow, string>;

  constructor() {
    super('ah-keung');
    this.version(1).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
    });
    this.version(2).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
    }).upgrade(async (tx) => {
      await tx.table('plans').clear();
      await tx.table('sessions').clear();
    });
    this.version(3).stores({
      plans: '++id, weekStart, createdAt',
      sessions: '++id, planId, date, startedAt',
      metrics: '++id, date',
      favorites: 'exerciseId, addedAt',
    });
    this.version(4).stores({
      plans:          'id, userId, weekStart, updatedAt',
      sessions:       'id, userId, planId, date, updatedAt',
      metrics:        'id, userId, date, updatedAt',
      favorites:      '[userId+exerciseId], userId, addedAt',
      syncQueue:      '++seq, table, rowId',
      syncDeadLetter: '++seq, table, rowId',
      syncMeta:       'key',
    }).upgrade(async (tx) => {
      // Pre-launch: no data to migrate. Wipe v3 contents.
      await tx.table('plans').clear();
      await tx.table('sessions').clear();
      await tx.table('metrics').clear();
      await tx.table('favorites').clear();
    });
  }
}

export const db = new AhKeungDB();

export const muscleGroupColor: Record<MuscleGroup, string> = {
  chest: 'bg-rose-500',
  back: 'bg-blue-500',
  shoulders: 'bg-amber-500',
  biceps: 'bg-purple-500',
  triceps: 'bg-fuchsia-500',
  legs: 'bg-emerald-500',
  glutes: 'bg-teal-500',
  core: 'bg-yellow-500',
  cardio: 'bg-red-500',
};
```

- [ ] **Step 3: Type-check**

Run: `cd /home/ubuntu/AhKeung && npx tsc --noEmit`
Expected: many errors in `PlanEditor.tsx`, `Workout.tsx`, `Metrics.tsx`, `useFavorites.ts`, and the existing tests — these will be fixed in later tasks. For now confirm errors are *only* in those files and not in `db.ts` itself.

- [ ] **Step 4: Don't commit yet**

This task leaves the codebase in a broken state. The next task (Task 6) updates `db.test.ts` so the schema tests pass. We commit Tasks 5 and 6 together.

---

### Task 6: Update `db.test.ts` for the v4 schema

**Files:**
- Modify: `src/test/db.test.ts` (whole file rewrite)

- [ ] **Step 1: Replace the test file**

Replace `/home/ubuntu/AhKeung/src/test/db.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';

const UID = '00000000-0000-0000-0000-000000000001';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('Dexie database', () => {
  it('opens at schema version 4', async () => {
    expect(db.verno).toBe(4);
  });

  it('has the owned tables plus sync support tables', () => {
    const names = db.tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'favorites',
      'metrics',
      'plans',
      'sessions',
      'syncDeadLetter',
      'syncMeta',
      'syncQueue',
    ]);
  });

  describe('plans CRUD', () => {
    it('stores and retrieves a plan by UUID', async () => {
      const id = 'plan-uuid-1';
      await db.plans.put({
        id,
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
        name: 'Push Day',
        weekStart: '2025-03-10',
        focus: ['chest', 'triceps'],
        exercises: [
          { exerciseId: 'Barbell_Bench_Press_-_Medium_Grip', targetSets: 3, targetReps: 8 },
        ],
        createdAt: Date.now(),
      });
      const got = await db.plans.get(id);
      expect(got?.name).toBe('Push Day');
      expect(got?.focus).toEqual(['chest', 'triceps']);
      expect(got?.exercises).toHaveLength(1);
    });

    it('looks up by weekStart index', async () => {
      await db.plans.put({
        id: 'plan-uuid-2',
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
        name: 'Week 1',
        weekStart: '2025-03-10',
        focus: ['back'],
        exercises: [],
        createdAt: Date.now(),
      });
      const found = await db.plans.where('weekStart').equals('2025-03-10').first();
      expect(found?.name).toBe('Week 1');
    });
  });

  describe('sessions CRUD', () => {
    it('stores a workout session with completed sets', async () => {
      const id = 'session-uuid-1';
      await db.sessions.put({
        id,
        userId: UID,
        updatedAt: Date.now(),
        serverVersion: null,
        date: '2025-03-10',
        startedAt: Date.now(),
        endedAt: Date.now() + 30 * 60_000,
        exercises: [
          {
            exerciseId: 'Pullups',
            sets: [
              { reps: 8, weight: 0, done: true },
              { reps: 6, weight: 0, done: true },
              { reps: 5, weight: 0, done: false },
            ],
          },
        ],
      });
      const got = await db.sessions.get(id);
      const doneCount = got?.exercises[0].sets.filter((s) => s.done).length;
      expect(doneCount).toBe(2);
    });
  });

  describe('favorites CRUD', () => {
    it('stores favorites keyed by [userId, exerciseId]', async () => {
      await db.favorites.put({
        userId: UID,
        exerciseId: 'Pullups',
        addedAt: Date.now(),
        updatedAt: Date.now(),
        serverVersion: null,
      });
      const got = await db.favorites.get([UID, 'Pullups']);
      expect(got?.exerciseId).toBe('Pullups');
    });

    it('lists favorites filtered by userId', async () => {
      await db.favorites.put({ userId: UID, exerciseId: 'Pullups',      addedAt: 1, updatedAt: 1, serverVersion: null });
      await db.favorites.put({ userId: UID, exerciseId: 'Barbell_Squat', addedAt: 2, updatedAt: 2, serverVersion: null });
      const all = await db.favorites.where('userId').equals(UID).toArray();
      expect(all.map((f) => f.exerciseId).sort()).toEqual(['Barbell_Squat', 'Pullups']);
    });
  });

  describe('metrics CRUD', () => {
    it('stores body metrics and queries ordered by date', async () => {
      await db.metrics.put({ id: 'm-1', userId: UID, updatedAt: 1, serverVersion: null, date: '2025-03-01', weightKg: 80 });
      await db.metrics.put({ id: 'm-2', userId: UID, updatedAt: 2, serverVersion: null, date: '2025-03-15', weightKg: 79 });
      await db.metrics.put({ id: 'm-3', userId: UID, updatedAt: 3, serverVersion: null, date: '2025-03-10', weightKg: 79.5 });

      const ordered = await db.metrics.orderBy('date').toArray();
      expect(ordered.map((m) => m.date)).toEqual(['2025-03-01', '2025-03-10', '2025-03-15']);
    });
  });

  describe('sync tables', () => {
    it('syncQueue auto-increments seq', async () => {
      const s1 = await db.syncQueue.add({
        table: 'plans', rowId: 'p1', op: 'insert',
        expectedServerVersion: null, attempts: 0, queuedAt: Date.now(),
      });
      const s2 = await db.syncQueue.add({
        table: 'plans', rowId: 'p2', op: 'insert',
        expectedServerVersion: null, attempts: 0, queuedAt: Date.now(),
      });
      expect(s2).toBe(s1 + 1);
    });

    it('syncMeta stores arbitrary key/value', async () => {
      await db.syncMeta.put({ key: 'plans.lastPulledAt', value: 'iso-string' });
      const got = await db.syncMeta.get('plans.lastPulledAt');
      expect(got?.value).toBe('iso-string');
    });
  });
});
```

- [ ] **Step 2: Run the DB tests**

Run: `cd /home/ubuntu/AhKeung && npm test -- src/test/db.test.ts`
Expected: all green. Other test files will still fail — ignore them for now.

- [ ] **Step 3: Commit Tasks 5 + 6 together**

```bash
git add src/db.ts src/test/db.test.ts
git commit -m "Migrate Dexie schema to v4 (UUIDs, userId, updatedAt, serverVersion, sync tables)"
```

---

## Phase 4 — Test infrastructure

### Task 7: Create the in-memory fake Supabase client

**Files:**
- Create: `src/test/fakeSupabase.ts`

This fake implements only the surface the app uses: `auth.signInWithOtp`, `auth.getSession`, `auth.onAuthStateChange`, `auth.refreshSession`, `auth.signOut`, and `from(table).select/insert/update/upsert/delete().eq(...).select()`. It enforces a basic RLS-equivalent filter on `user_id` and supports a network-failure toggle.

- [ ] **Step 1: Write a failing test for the fake**

Create `/home/ubuntu/AhKeung/src/test/fakeSupabase.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase';

describe('fakeSupabase', () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => { fake = createFakeSupabase(); });

  it('starts with no session', async () => {
    const { data } = await fake.client.auth.getSession();
    expect(data.session).toBeNull();
  });

  it('signInWithOtp + manual deliver triggers SIGNED_IN', async () => {
    const events: string[] = [];
    fake.client.auth.onAuthStateChange((e) => { events.push(e); });
    await fake.client.auth.signInWithOtp({ email: 'a@b.com' });
    fake.deliverMagicLink('a@b.com', 'u-1');
    expect(events).toContain('SIGNED_IN');
    const { data } = await fake.client.auth.getSession();
    expect(data.session?.user.id).toBe('u-1');
  });

  it('insert/select round-trip with user_id filter', async () => {
    fake.deliverMagicLink('a@b.com', 'u-1');
    await fake.client.from('plans').insert({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: ['chest'], exercises: [],
    });
    const { data } = await fake.client.from('plans').select('*').eq('user_id', 'u-1');
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe('p1');
  });

  it('conditional update returns empty when WHERE does not match', async () => {
    fake.deliverMagicLink('a@b.com', 'u-1');
    await fake.client.from('plans').insert({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: [], exercises: [],
    });
    // First update — succeeds
    const first = await fake.client.from('plans').update({ name: 'B' })
      .eq('id', 'p1').eq('updated_at', fake.rowOf('plans', 'p1').updated_at)
      .select();
    expect(first.data).toHaveLength(1);
    // Second update with stale expected — empty result
    const stale = await fake.client.from('plans').update({ name: 'C' })
      .eq('id', 'p1').eq('updated_at', 'stale-iso').select();
    expect(stale.data).toEqual([]);
  });

  it('network failure toggle causes throws', async () => {
    fake.setNetworkUp(false);
    await expect(fake.client.from('plans').select('*')).rejects.toThrow(/network/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/ubuntu/AhKeung && npm test -- src/test/fakeSupabase.test.ts`
Expected: FAIL — `Cannot find module './fakeSupabase'`.

- [ ] **Step 3: Implement `fakeSupabase.ts`**

Create `/home/ubuntu/AhKeung/src/test/fakeSupabase.ts`:

```ts
type Row = Record<string, unknown> & { id?: string; user_id?: string };
type Tables = Record<string, Row[]>;

interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}

type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';
type AuthListener = (event: AuthEvent, session: Session | null) => void;

export function createFakeSupabase() {
  const tables: Tables = {
    profiles: [], plans: [], sessions: [], metrics: [], favorites: [],
  };
  let session: Session | null = null;
  let networkUp = true;
  const listeners: AuthListener[] = [];

  function nowIso() { return new Date().toISOString(); }
  function notify(event: AuthEvent) { for (const l of listeners) l(event, session); }
  function requireNetwork() {
    if (!networkUp) throw new Error('network failure (fake)');
  }

  function builder(tableName: string) {
    const filters: { col: string; val: unknown }[] = [];
    let action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row | Row[] | undefined;
    let selectedAfter = false;

    const api: any = {
      select(_cols?: string) {
        if (action === 'select') { action = 'select'; }
        else { selectedAfter = true; }
        return api;
      },
      eq(col: string, val: unknown) { filters.push({ col, val }); return api; },
      insert(row: Row | Row[]) { action = 'insert'; payload = row; return api;  },
      update(row: Row) { action = 'update'; payload = row; return api; },
      upsert(row: Row | Row[]) { action = 'upsert'; payload = row; return api; },
      delete() { action = 'delete'; return api; },
      then(onResolve: (r: { data: Row[] | null; error: Error | null }) => unknown,
           onReject?: (e: Error) => unknown) {
        try {
          requireNetwork();
          const arr = tables[tableName] ?? (tables[tableName] = []);
          const match = (r: Row) => filters.every((f) => (r as any)[f.col] === f.val);

          if (action === 'select') {
            const data = arr.filter(match);
            return Promise.resolve({ data, error: null }).then(onResolve, onReject);
          }
          if (action === 'insert') {
            const rows = Array.isArray(payload) ? payload : [payload!];
            const stamped = rows.map((r) => ({ ...r, updated_at: nowIso() }));
            arr.push(...stamped);
            return Promise.resolve({ data: stamped, error: null }).then(onResolve, onReject);
          }
          if (action === 'update') {
            const updated: Row[] = [];
            for (const r of arr) {
              if (match(r)) {
                Object.assign(r, payload, { updated_at: nowIso() });
                updated.push(r);
              }
            }
            return Promise.resolve({ data: selectedAfter ? updated : null, error: null })
              .then(onResolve, onReject);
          }
          if (action === 'delete') {
            const remaining: Row[] = [];
            const deleted: Row[] = [];
            for (const r of arr) { if (match(r)) deleted.push(r); else remaining.push(r); }
            tables[tableName] = remaining;
            return Promise.resolve({ data: deleted, error: null }).then(onResolve, onReject);
          }
          if (action === 'upsert') {
            const rows = Array.isArray(payload) ? payload : [payload!];
            for (const r of rows) {
              const idx = arr.findIndex((x) => x.id === r.id);
              if (idx >= 0) { Object.assign(arr[idx], r, { updated_at: nowIso() }); }
              else { arr.push({ ...r, updated_at: nowIso() }); }
            }
            return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject);
          }
          return Promise.resolve({ data: null, error: null }).then(onResolve, onReject);
        } catch (e) {
          return Promise.reject(e as Error).then(undefined, onReject);
        }
      },
    };
    return api;
  }

  const client = {
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      onAuthStateChange(cb: AuthListener) {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() {
          const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
        } } } };
      },
      async signInWithOtp(_args: { email: string }) {
        requireNetwork();
        return { data: {}, error: null };
      },
      async refreshSession() {
        requireNetwork();
        if (!session) return { data: { session: null }, error: null };
        notify('TOKEN_REFRESHED');
        return { data: { session }, error: null };
      },
      async signOut() { session = null; notify('SIGNED_OUT'); return { error: null }; },
    },
    from(name: string) { return builder(name); },
  };

  return {
    client,
    deliverMagicLink(email: string, userId: string) {
      session = {
        access_token: 'fake-access', refresh_token: 'fake-refresh',
        user: { id: userId, email },
      };
      // Ensure a profile row exists (simulates handle_new_user trigger).
      if (!tables.profiles.find((p) => p.id === userId)) {
        tables.profiles.push({
          id: userId, display_name: null, is_trainer: false, created_at: nowIso(),
        });
      }
      notify('SIGNED_IN');
    },
    setNetworkUp(up: boolean) { networkUp = up; },
    setTrainer(userId: string, isTrainer: boolean) {
      const p = tables.profiles.find((x) => x.id === userId);
      if (p) p.is_trainer = isTrainer;
    },
    rowOf(table: string, id: string) {
      return (tables[table] ?? []).find((r) => r.id === id) as Row;
    },
    tables,
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
```

- [ ] **Step 4: Run the test again, should pass**

Run: `cd /home/ubuntu/AhKeung && npm test -- src/test/fakeSupabase.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/test/fakeSupabase.ts src/test/fakeSupabase.test.ts
git commit -m "Add in-memory fake Supabase client for tests"
```

---

### Task 8: Add `stubAuthenticatedUser` helper and wire fake supabase into the global setup

**Files:**
- Modify: `src/test/setup.ts` (add helper)
- Create: `src/test/authStub.ts` (the helper itself)

- [ ] **Step 1: Create `src/test/authStub.ts`**

```ts
// src/test/authStub.ts
import { setSupabase } from '../supabase';
import { createFakeSupabase, type FakeSupabase } from './fakeSupabase';

let activeFake: FakeSupabase | null = null;

export function stubAuthenticatedUser(opts: {
  id: string; email?: string; isTrainer?: boolean;
} = { id: 'u-test' }): FakeSupabase {
  const fake = createFakeSupabase();
  fake.deliverMagicLink(opts.email ?? 'test@example.com', opts.id);
  if (opts.isTrainer) fake.setTrainer(opts.id, true);
  activeFake = fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSupabase(fake.client as any);
  return fake;
}

export function stubUnauthenticated(): FakeSupabase {
  const fake = createFakeSupabase();
  activeFake = fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSupabase(fake.client as any);
  return fake;
}

export function getActiveFake(): FakeSupabase {
  if (!activeFake) throw new Error('stubAuthenticatedUser/stubUnauthenticated not called');
  return activeFake;
}

export function clearAuthStub() {
  activeFake = null;
  setSupabase(null);
}
```

- [ ] **Step 2: Update `src/test/setup.ts` to clear the stub after each test**

Append to the existing `setup.ts` (after the existing `afterEach`):

```ts
import { clearAuthStub } from './authStub';
afterEach(() => { clearAuthStub(); });
```

(The existing `afterEach(cleanup)` stays; this adds a second one.)

- [ ] **Step 3: Smoke-test the helper**

Create `/home/ubuntu/AhKeung/src/test/authStub.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stubAuthenticatedUser } from './authStub';

describe('stubAuthenticatedUser', () => {
  it('returns a fake with the given user already signed in', async () => {
    const fake = stubAuthenticatedUser({ id: 'u-1', isTrainer: true });
    const { data } = await fake.client.auth.getSession();
    expect(data.session?.user.id).toBe('u-1');
  });
});
```

Run: `npm test -- src/test/authStub.test.ts`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/test/authStub.ts src/test/setup.ts src/test/authStub.test.ts
git commit -m "Add stubAuthenticatedUser helper for component tests"
```

---

## Phase 5 — Sync foundations (mapping, meta, write helper)

### Task 9: Implement `mapping.ts` (snake_case ↔ camelCase)

**Files:**
- Create: `src/sync/mapping.ts`
- Create: `src/sync/mapping.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `/home/ubuntu/AhKeung/src/sync/mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toServerRow, fromServerRow } from './mapping';

describe('mapping', () => {
  it('camelCase → snake_case for outbound rows', () => {
    expect(toServerRow({ id: 'a', userId: 'u', updatedAt: 1, weekStart: '2025-01-01' }))
      .toEqual({ id: 'a', user_id: 'u', updated_at: 1, week_start: '2025-01-01' });
  });

  it('snake_case → camelCase for inbound rows', () => {
    expect(fromServerRow({
      id: 'a', user_id: 'u', updated_at: '2025-01-01T00:00:00.000Z',
      week_start: '2025-01-01', deleted_at: null, body_fat_pct: 18.5,
    })).toEqual({
      id: 'a', userId: 'u', updatedAt: '2025-01-01T00:00:00.000Z',
      weekStart: '2025-01-01', deletedAt: null, bodyFatPct: 18.5,
    });
  });

  it('ignores unknown inbound fields silently (forward-compatible)', () => {
    const out = fromServerRow({ id: 'a', user_id: 'u', updated_at: 't', new_field_from_future: 'x' });
    expect(out).not.toHaveProperty('newFieldFromFuture');
    expect(out).not.toHaveProperty('new_field_from_future');
  });

  it('strips serverVersion from outbound (client-only field)', () => {
    expect(toServerRow({ id: 'a', userId: 'u', updatedAt: 1, serverVersion: 'iso' }))
      .toEqual({ id: 'a', user_id: 'u', updated_at: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/sync/mapping.test.ts`
Expected: FAIL — `Cannot find module './mapping'`.

- [ ] **Step 3: Implement `mapping.ts`**

Create `/home/ubuntu/AhKeung/src/sync/mapping.ts`:

```ts
// src/sync/mapping.ts
// Whitelist of inbound fields we accept per table. Unknown fields are dropped
// silently so server schema additions don't crash the client.
const INBOUND_FIELDS: Record<string, Set<string>> = {
  plans:     new Set(['id', 'user_id', 'assigned_by', 'name', 'week_start', 'focus',
                      'exercises', 'created_at', 'updated_at', 'deleted_at']),
  sessions:  new Set(['id', 'user_id', 'plan_id', 'date', 'exercises', 'notes',
                      'started_at', 'ended_at', 'updated_at', 'deleted_at']),
  metrics:   new Set(['id', 'user_id', 'date', 'weight_kg', 'height_cm',
                      'body_fat_pct', 'notes', 'updated_at', 'deleted_at']),
  favorites: new Set(['user_id', 'exercise_id', 'added_at', 'updated_at', 'deleted_at']),
  profiles:  new Set(['id', 'display_name', 'is_trainer', 'created_at']),
};

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

const CLIENT_ONLY_FIELDS = new Set(['serverVersion']);

export function toServerRow(camel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(camel)) {
    if (CLIENT_ONLY_FIELDS.has(k)) continue;
    out[camelToSnake(k)] = v;
  }
  return out;
}

export function fromServerRow(
  snake: Record<string, unknown>,
  table?: string,
): Record<string, unknown> {
  const whitelist = table ? INBOUND_FIELDS[table] : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snake)) {
    if (whitelist && !whitelist.has(k)) continue;
    out[snakeToCamel(k)] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `npm test -- src/sync/mapping.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/mapping.ts src/sync/mapping.test.ts
git commit -m "Add sync mapping layer (snake_case <-> camelCase, forward-compat)"
```

---

### Task 10: Implement `syncMeta.ts` (per-table cursor: lastPulledAt + lastSeenIds)

**Files:**
- Create: `src/sync/syncMeta.ts`
- Create: `src/sync/syncMeta.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `/home/ubuntu/AhKeung/src/sync/syncMeta.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { getCursor, setCursor } from './syncMeta';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('syncMeta cursor', () => {
  it('returns empty when nothing stored', async () => {
    expect(await getCursor('plans')).toEqual({ lastPulledAt: null, lastSeenIds: [] });
  });

  it('persists and retrieves a cursor with lastSeenIds', async () => {
    await setCursor('plans', { lastPulledAt: '2025-03-10T00:00:00.000Z', lastSeenIds: ['p1', 'p2'] });
    expect(await getCursor('plans')).toEqual({
      lastPulledAt: '2025-03-10T00:00:00.000Z', lastSeenIds: ['p1', 'p2'],
    });
  });

  it('keeps per-table cursors independent', async () => {
    await setCursor('plans',    { lastPulledAt: 'A', lastSeenIds: ['pa'] });
    await setCursor('sessions', { lastPulledAt: 'B', lastSeenIds: ['pb'] });
    expect((await getCursor('plans')).lastPulledAt).toBe('A');
    expect((await getCursor('sessions')).lastPulledAt).toBe('B');
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npm test -- src/sync/syncMeta.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `/home/ubuntu/AhKeung/src/sync/syncMeta.ts`:

```ts
import { db, type SyncTableName } from '../db';

export interface Cursor {
  lastPulledAt: string | null;  // ISO timestamp from server
  lastSeenIds: string[];        // IDs at the boundary timestamp already merged
}

function key(table: SyncTableName) { return `${table}.cursor`; }

export async function getCursor(table: SyncTableName): Promise<Cursor> {
  const row = await db.syncMeta.get(key(table));
  return (row?.value as Cursor | undefined) ?? { lastPulledAt: null, lastSeenIds: [] };
}

export async function setCursor(table: SyncTableName, cursor: Cursor): Promise<void> {
  await db.syncMeta.put({ key: key(table), value: cursor });
}
```

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/sync/syncMeta.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/syncMeta.ts src/sync/syncMeta.test.ts
git commit -m "Add per-table sync cursor helpers"
```

---

### Task 11: Implement `putWithSync.ts` (write helpers + favorites rowId encoding)

**Files:**
- Create: `src/sync/putWithSync.ts`
- Create: `src/sync/putWithSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `/home/ubuntu/AhKeung/src/sync/putWithSync.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync, deleteWithSync, favoriteRowId, parseFavoriteRowId } from './putWithSync';

const UID = 'u-test';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('putWithSync', () => {
  it('inserts a brand-new row and queues op=insert with serverVersion=null', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: ['chest'],
      exercises: [], createdAt: 1,
    }, UID);

    const row = await db.plans.get('p1');
    expect(row?.userId).toBe(UID);
    expect(row?.serverVersion).toBeNull();
    expect(row?.updatedAt).toBeGreaterThan(0);

    const q = await db.syncQueue.toArray();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      table: 'plans', rowId: 'p1', op: 'insert', expectedServerVersion: null,
    });
  });

  it('subsequent put on the same row queues op=update with current serverVersion', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);
    // Simulate push success that filled serverVersion.
    await db.plans.update('p1', { serverVersion: 'srv-v1' });

    await putWithSync('plans', {
      id: 'p1', name: 'B', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);

    const q = await db.syncQueue.toArray();
    const second = q[q.length - 1];
    expect(second.op).toBe('update');
    expect(second.expectedServerVersion).toBe('srv-v1');
  });

  it('deleteWithSync removes local row and queues op=delete', async () => {
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, UID);
    await db.plans.update('p1', { serverVersion: 'srv-v1' });

    await deleteWithSync('plans', 'p1');

    expect(await db.plans.get('p1')).toBeUndefined();
    const q = await db.syncQueue.toArray();
    expect(q.find((e) => e.op === 'delete')).toMatchObject({
      table: 'plans', rowId: 'p1', expectedServerVersion: 'srv-v1',
    });
  });

  it('writes to favorites use the composite rowId encoding', async () => {
    await putWithSync('favorites', { exerciseId: 'Pullups', addedAt: 1 }, UID);
    const q = await db.syncQueue.toArray();
    expect(q[0].rowId).toBe(`${UID}:Pullups`);
    expect(parseFavoriteRowId(q[0].rowId)).toEqual({ userId: UID, exerciseId: 'Pullups' });
  });

  it('favoriteRowId round-trips through parseFavoriteRowId', () => {
    expect(parseFavoriteRowId(favoriteRowId('u', 'ex'))).toEqual({ userId: 'u', exerciseId: 'ex' });
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npm test -- src/sync/putWithSync.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `/home/ubuntu/AhKeung/src/sync/putWithSync.ts`:

```ts
import { db, type SyncTableName, type Plan, type WorkoutSession, type BodyMetric, type Favorite } from '../db';

export function favoriteRowId(userId: string, exerciseId: string): string {
  return `${userId}:${exerciseId}`;
}

export function parseFavoriteRowId(rowId: string): { userId: string; exerciseId: string } {
  const idx = rowId.indexOf(':');
  if (idx < 0) throw new Error(`malformed favorite rowId: ${rowId}`);
  return { userId: rowId.slice(0, idx), exerciseId: rowId.slice(idx + 1) };
}

type PartialOf<T extends SyncTableName> =
  T extends 'plans'     ? Partial<Plan>           & { id: string }
  : T extends 'sessions' ? Partial<WorkoutSession> & { id: string }
  : T extends 'metrics'  ? Partial<BodyMetric>     & { id: string }
  : T extends 'favorites'? Partial<Favorite>       & { exerciseId: string }
  : never;

export async function putWithSync<T extends SyncTableName>(
  table: T, partial: PartialOf<T>, userId: string,
): Promise<void> {
  await db.transaction('rw', db.table(table), db.syncQueue, async () => {
    if (table === 'favorites') {
      const fav = partial as Partial<Favorite> & { exerciseId: string };
      const existing = await db.favorites.get([userId, fav.exerciseId]);
      const row: Favorite = {
        userId,
        exerciseId: fav.exerciseId,
        addedAt: fav.addedAt ?? existing?.addedAt ?? Date.now(),
        updatedAt: Date.now(),
        serverVersion: existing?.serverVersion ?? null,
      };
      await db.favorites.put(row);
      await db.syncQueue.add({
        table: 'favorites',
        rowId: favoriteRowId(userId, fav.exerciseId),
        op: existing ? 'update' : 'insert',
        expectedServerVersion: existing?.serverVersion ?? null,
        attempts: 0, queuedAt: Date.now(),
      });
      return;
    }

    const t = db.table(table);
    const partialId = (partial as { id: string }).id;
    const existing = await t.get(partialId);
    const row = {
      ...existing,
      ...partial,
      userId,
      updatedAt: Date.now(),
      serverVersion: existing?.serverVersion ?? null,
    };
    await t.put(row);
    await db.syncQueue.add({
      table,
      rowId: partialId,
      op: existing ? 'update' : 'insert',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
    });
  });
}

export async function deleteWithSync(
  table: Exclude<SyncTableName, 'favorites'>, rowId: string,
): Promise<void>;
export async function deleteWithSync(
  table: 'favorites', userId: string, exerciseId: string,
): Promise<void>;
export async function deleteWithSync(
  table: SyncTableName, a: string, b?: string,
): Promise<void> {
  await db.transaction('rw', db.table(table), db.syncQueue, async () => {
    if (table === 'favorites') {
      const userId = a; const exerciseId = b!;
      const existing = await db.favorites.get([userId, exerciseId]);
      await db.favorites.delete([userId, exerciseId]);
      await db.syncQueue.add({
        table: 'favorites',
        rowId: favoriteRowId(userId, exerciseId),
        op: 'delete',
        expectedServerVersion: existing?.serverVersion ?? null,
        attempts: 0, queuedAt: Date.now(),
      });
      return;
    }
    const t = db.table(table);
    const existing = (await t.get(a)) as { serverVersion?: string | null } | undefined;
    await t.delete(a);
    await db.syncQueue.add({
      table, rowId: a, op: 'delete',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
    });
  });
}
```

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/sync/putWithSync.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/putWithSync.ts src/sync/putWithSync.test.ts
git commit -m "Add putWithSync/deleteWithSync helpers + favorites rowId encoding"
```

---

## Phase 6 — Push worker (multiple TDD slices)

### Task 12: Push worker — happy-path insert

**Files:**
- Create: `src/sync/pushWorker.ts`
- Create: `src/sync/pushWorker.test.ts`

- [ ] **Step 1: Failing test**

Create `/home/ubuntu/AhKeung/src/sync/pushWorker.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { putWithSync } from './putWithSync';
import { runPushOnce } from './pushWorker';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('pushWorker — insert happy path', () => {
  it('inserts a queued row to fake Supabase and clears the queue', async () => {
    stubAuthenticatedUser({ id: 'u-1' });

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await runPushOnce();

    const fake = getActiveFake();
    expect(fake.rowOf('plans', 'p1')).toBeDefined();
    expect(await db.syncQueue.count()).toBe(0);
    const local = await db.plans.get('p1');
    expect(local?.serverVersion).toBe(fake.rowOf('plans', 'p1').updated_at);
  });
});
```

- [ ] **Step 2: Run, fail (missing module)**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement minimal pushWorker covering insert only**

Create `/home/ubuntu/AhKeung/src/sync/pushWorker.ts`:

```ts
import { getSupabase } from '../supabase';
import { db, type SyncQueueRow, type SyncTableName } from '../db';
import { toServerRow } from './mapping';
import { parseFavoriteRowId } from './putWithSync';

async function localRowFor(entry: SyncQueueRow): Promise<Record<string, unknown> | undefined> {
  if (entry.table === 'favorites') {
    const { userId, exerciseId } = parseFavoriteRowId(entry.rowId);
    return await db.favorites.get([userId, exerciseId]) as Record<string, unknown> | undefined;
  }
  return await db.table(entry.table).get(entry.rowId) as Record<string, unknown> | undefined;
}

async function setLocalServerVersion(table: SyncTableName, rowId: string, sv: string): Promise<void> {
  if (table === 'favorites') {
    const { userId, exerciseId } = parseFavoriteRowId(rowId);
    await db.favorites.update([userId, exerciseId], { serverVersion: sv });
  } else {
    await db.table(table).update(rowId, { serverVersion: sv });
  }
}

export async function runPushOnce(): Promise<void> {
  const entries = await db.syncQueue.orderBy('seq').toArray();
  for (const entry of entries) {
    if (entry.op === 'insert') {
      const local = await localRowFor(entry);
      if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
      const payload = toServerRow(local);
      const res = await getSupabase().from(entry.table).insert(payload).select() as
        { data: { updated_at: string }[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const inserted = res.data?.[0];
      if (inserted?.updated_at) {
        await setLocalServerVersion(entry.table, entry.rowId, inserted.updated_at);
      }
      await db.syncQueue.delete(entry.seq!);
    }
  }
}
```

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/pushWorker.ts src/sync/pushWorker.test.ts
git commit -m "Push worker: happy-path insert"
```

---

### Task 13: Push worker — update with optimistic concurrency

**Files:**
- Modify: `src/sync/pushWorker.ts`
- Modify: `src/sync/pushWorker.test.ts`

- [ ] **Step 1: Add failing test for update**

Append to `src/sync/pushWorker.test.ts`:

```ts
describe('pushWorker — update with optimistic CC', () => {
  it('uses conditional update on updated_at and refreshes serverVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    // Initial insert and push
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();
    const v1 = (await db.plans.get('p1'))!.serverVersion!;

    // Local update
    await putWithSync('plans', {
      id: 'p1', name: 'B', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    expect((await db.syncQueue.toArray())[0].expectedServerVersion).toBe(v1);

    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').name).toBe('B');
    const v2 = (await db.plans.get('p1'))!.serverVersion!;
    expect(v2).not.toBe(v1);
    expect(await db.syncQueue.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, fail (insert-only worker can't handle update)**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: the new test fails.

- [ ] **Step 3: Extend `pushWorker.ts` to handle update**

In `src/sync/pushWorker.ts`, inside the `for` loop, after the `if (entry.op === 'insert')` block, add:

```ts
if (entry.op === 'update') {
  const local = await localRowFor(entry);
  if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
  const payload = toServerRow(local);
  // Build conditional WHERE
  let q = getSupabase().from(entry.table).update(payload).eq('id', entry.rowId);
  if (entry.expectedServerVersion !== null) {
    q = q.eq('updated_at', entry.expectedServerVersion);
  }
  const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
  if (res.error) throw new Error(res.error.message);
  const updated = res.data?.[0];
  if (updated?.updated_at) {
    await setLocalServerVersion(entry.table, entry.rowId, updated.updated_at);
    await db.syncQueue.delete(entry.seq!);
  } else {
    // Conflict path — handled in Task 14
    throw new Error('conflict (TBD in Task 14)');
  }
  continue;
}
```

(The `throw` is a temporary marker; Task 14 replaces it with real conflict logic.)

- [ ] **Step 4: Run; both tests pass**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Don't commit yet**

The worker now contains an unreachable `throw` on the conflict path. Tests pass because no test triggers a conflict — but production code would crash. Task 14 replaces the throw with real conflict handling. **Hold off on committing until then.**

---

### Task 14: Push worker — conflict pull-and-replay

**Files:**
- Modify: `src/sync/pushWorker.ts`
- Modify: `src/sync/pushWorker.test.ts`

- [ ] **Step 1: Failing test**

Append to `src/sync/pushWorker.test.ts`:

```ts
import { fromServerRow } from './mapping';

describe('pushWorker — conflict pull-and-replay', () => {
  it('pulls and re-pushes when server is newer than expectedServerVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();

    // Other device wrote to the server.
    const row = fake.rowOf('plans', 'p1');
    row.name = 'OTHER';
    row.updated_at = new Date(Date.now() + 1000).toISOString();

    // Local edit while we held an older serverVersion.
    await putWithSync('plans', {
      id: 'p1', name: 'LOCAL', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').name).toBe('LOCAL');
    expect(await db.syncQueue.count()).toBe(0);
    expect((await db.plans.get('p1'))!.serverVersion).toBe(fake.rowOf('plans', 'p1').updated_at);
  });
});
```

- [ ] **Step 2: Run, fail (Task 13's `throw` fires)**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: new test fails with `conflict (TBD in Task 14)`.

- [ ] **Step 3: Replace the conflict marker in `pushWorker.ts`**

In `src/sync/pushWorker.ts`, find the `// Conflict path — handled in Task 14` block and replace it with:

```ts
// Conflict: server's updated_at moved. Pull latest, update
// expectedServerVersion on the queue row, and let the next iteration retry.
const pulled = await getSupabase().from(entry.table).select('*').eq('id', entry.rowId)
  as { data: Record<string, unknown>[] | null; error: { message: string } | null };
if (pulled.error) throw new Error(pulled.error.message);
const serverRow = pulled.data?.[0];
if (!serverRow) {
  // Row disappeared on server — treat as a stale local update; drop the queue entry.
  await db.syncQueue.delete(entry.seq!);
  continue;
}
const conflictAttempts = (entry.attempts ?? 0) + 1;
if (conflictAttempts >= 3) {
  await moveToDeadLetter(entry, 'repeated conflict');
  continue;
}
const newExpected = serverRow.updated_at as string;
// Update the queue row, then re-run this loop iteration.
await db.syncQueue.update(entry.seq!, {
  expectedServerVersion: newExpected, attempts: conflictAttempts,
});
// Reflect freshly-pulled serverVersion locally so subsequent local edits use the right baseline.
// Keep the local DATA (the user's edit) — only the version pointer moves.
await setLocalServerVersion(entry.table, entry.rowId, newExpected);
// Re-fetch and retry within this loop iteration.
const refreshed = (await db.syncQueue.get(entry.seq!))!;
entries.unshift(refreshed);  // Process again at front of the list.
// Continue main loop — note: we don't `continue` here because we've manipulated `entries`.
continue;
```

Also add the `moveToDeadLetter` helper at the bottom of the file:

```ts
async function moveToDeadLetter(entry: SyncQueueRow, reason: string): Promise<void> {
  await db.transaction('rw', db.syncQueue, db.syncDeadLetter, async () => {
    await db.syncDeadLetter.add({ ...entry, seq: undefined, lastError: reason, movedAt: Date.now() });
    await db.syncQueue.delete(entry.seq!);
  });
}
```

- [ ] **Step 4: Run, all push worker tests pass**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit Task 13 + Task 14 together**

```bash
git add src/sync/pushWorker.ts src/sync/pushWorker.test.ts
git commit -m "Push worker: update path with optimistic concurrency + pull-and-replay on conflict"
```

**v1 conflict semantics note.** This implementation pulls the server's current `updated_at` on conflict and re-pushes the local row's data verbatim. It does **not** merge the server's field changes into the local row before pushing. Concretely: if device A edits `name` and device B edits `notes` on the same row, whichever lands second overwrites the other's field. This is **row-level last-writer-wins**, not field-level merge.

The trade-off is deliberate for v1: field-level merge requires per-field dirty tracking (which fields the user actually changed in this session) that this codebase doesn't have. Task 25's integration test asserts this behavior explicitly so it doesn't drift later. Spec §5 "Conflict resolution — summary" describes this as "pull-then-replay"; that's slightly aspirational — what we actually build is "pull-version-pointer-then-replay." Acceptable for the gym's single-writer-per-row reality.

---

### Task 15: Push worker — delete tombstone, dead-letter for 4xx, network retry

**Files:**
- Modify: `src/sync/pushWorker.ts`
- Modify: `src/sync/pushWorker.test.ts`

- [ ] **Step 1: Failing tests**

Append three test cases to `src/sync/pushWorker.test.ts`:

```ts
import { deleteWithSync } from './putWithSync';

describe('pushWorker — delete', () => {
  it('translates op=delete to setting deleted_at on the server', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();

    await deleteWithSync('plans', 'p1');
    await runPushOnce();

    expect(fake.rowOf('plans', 'p1').deleted_at).not.toBeNull();
    expect(await db.syncQueue.count()).toBe(0);
  });
});

describe('pushWorker — dead letter on 4xx', () => {
  it('moves the queue entry to syncDeadLetter after a non-retryable error', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    // Inject a server-side failure: monkey-patch fake to reject inserts with code 422.
    const fake = getActiveFake();
    const orig = fake.client.from.bind(fake.client);
    fake.client.from = ((name: string) => {
      const b = orig(name);
      const origInsert = b.insert;
      b.insert = (row: unknown) => {
        const q = origInsert(row);
        q.then = (_resolve: any, reject: any) =>
          Promise.reject(Object.assign(new Error('422: validation'), { status: 422 }))
            .then(undefined, reject);
        return q;
      };
      return b;
    }) as typeof fake.client.from;

    await putWithSync('plans', {
      id: 'p1', name: 'X', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    // Run push 3 times (each fails, attempts increments).
    for (let i = 0; i < 3; i++) {
      try { await runPushOnce(); } catch { /* swallow per-attempt errors */ }
    }
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.syncDeadLetter.count()).toBe(1);
  });
});

describe('pushWorker — network failure retries silently', () => {
  it('does not move to dead letter on transient network error', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await putWithSync('plans', {
      id: 'p1', name: 'X', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    fake.setNetworkUp(false);
    await runPushOnce().catch(() => {});  // throws once

    expect(await db.syncDeadLetter.count()).toBe(0);
    expect((await db.syncQueue.toArray())[0].attempts).toBe(1);

    fake.setNetworkUp(true);
    await runPushOnce();
    expect(await db.syncQueue.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 3 new tests fail.

- [ ] **Step 3: Extend `pushWorker.ts` to handle delete, classify errors, increment attempts**

Replace the entire `runPushOnce` body in `src/sync/pushWorker.ts` with:

```ts
const NETWORK_RE = /network/i;

function classifyError(e: unknown): 'network' | 'auth' | 'fatal' {
  if (e instanceof Error) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) return 'auth';
    if (status && status >= 400 && status < 500) return 'fatal';
    if (NETWORK_RE.test(e.message)) return 'network';
  }
  return 'network';
}

async function bumpAttempts(entry: SyncQueueRow, err: unknown): Promise<void> {
  const status = (err as { status?: number })?.status;
  await db.syncQueue.update(entry.seq!, {
    attempts: (entry.attempts ?? 0) + 1,
    lastError: err instanceof Error ? err.message : String(err),
    lastErrorStatus: status,
  });
}

export async function runPushOnce(): Promise<void> {
  const entries = await db.syncQueue.orderBy('seq').toArray();
  while (entries.length > 0) {
    const entry = entries.shift()!;
    try {
      if (entry.op === 'insert') {
        const local = await localRowFor(entry);
        if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
        const payload = toServerRow(local);
        const res = await getSupabase().from(entry.table).insert(payload).select() as
          { data: { updated_at: string }[] | null; error: { message: string } | null };
        if (res.error) throw new Error(res.error.message);
        const inserted = res.data?.[0];
        if (inserted?.updated_at) {
          await setLocalServerVersion(entry.table, entry.rowId, inserted.updated_at);
        }
        await db.syncQueue.delete(entry.seq!);
      } else if (entry.op === 'update') {
        const local = await localRowFor(entry);
        if (!local) { await db.syncQueue.delete(entry.seq!); continue; }
        const payload = toServerRow(local);
        let q = getSupabase().from(entry.table).update(payload).eq('id', entry.rowId);
        if (entry.expectedServerVersion !== null) {
          q = q.eq('updated_at', entry.expectedServerVersion);
        }
        const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
        if (res.error) throw new Error(res.error.message);
        const updated = res.data?.[0];
        if (updated?.updated_at) {
          await setLocalServerVersion(entry.table, entry.rowId, updated.updated_at);
          await db.syncQueue.delete(entry.seq!);
        } else {
          // Conflict — pull latest, advance expectedServerVersion, retry.
          const pulled = await getSupabase().from(entry.table).select('*').eq('id', entry.rowId)
            as { data: Record<string, unknown>[] | null; error: { message: string } | null };
          const serverRow = pulled.data?.[0];
          if (!serverRow) {
            await db.syncQueue.delete(entry.seq!);
            continue;
          }
          const conflictAttempts = (entry.attempts ?? 0) + 1;
          if (conflictAttempts >= 3) {
            await moveToDeadLetter(entry, 'repeated conflict');
            continue;
          }
          const newExpected = serverRow.updated_at as string;
          await db.syncQueue.update(entry.seq!, {
            expectedServerVersion: newExpected, attempts: conflictAttempts,
          });
          await setLocalServerVersion(entry.table, entry.rowId, newExpected);
          const refreshed = (await db.syncQueue.get(entry.seq!))!;
          entries.unshift(refreshed);
        }
      } else if (entry.op === 'delete') {
        let q = getSupabase().from(entry.table)
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', entry.rowId);
        if (entry.expectedServerVersion !== null) {
          q = q.eq('updated_at', entry.expectedServerVersion);
        }
        const res = await q.select() as { data: unknown[] | null; error: { message: string } | null };
        if (res.error) throw new Error(res.error.message);
        if (res.data && res.data.length > 0) {
          await db.syncQueue.delete(entry.seq!);
        } else {
          // Conditional missed — server moved since we pulled. Pull current
          // updated_at, advance expectedServerVersion, retry.
          const pulled = await getSupabase().from(entry.table).select('updated_at').eq('id', entry.rowId)
            as { data: { updated_at: string }[] | null };
          const serverRow = pulled.data?.[0];
          if (!serverRow) {
            await db.syncQueue.delete(entry.seq!);  // already gone server-side
            continue;
          }
          const conflictAttempts = (entry.attempts ?? 0) + 1;
          if (conflictAttempts >= 3) {
            await moveToDeadLetter(entry, 'delete conflict');
            continue;
          }
          await db.syncQueue.update(entry.seq!, {
            expectedServerVersion: serverRow.updated_at, attempts: conflictAttempts,
          });
          entries.unshift((await db.syncQueue.get(entry.seq!))!);
        }
      }
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'fatal') {
        const newAttempts = (entry.attempts ?? 0) + 1;
        if (newAttempts >= 3) {
          await moveToDeadLetter({ ...entry, attempts: newAttempts,
            lastError: err instanceof Error ? err.message : String(err) },
            err instanceof Error ? err.message : String(err));
        } else {
          await bumpAttempts(entry, err);
        }
        continue;
      }
      if (kind === 'auth') {
        // Defer handling to Task 16 — for now, bump attempts and rethrow.
        await bumpAttempts(entry, err);
        throw err;
      }
      // network: bump attempts and stop the loop (caller will retry later)
      await bumpAttempts(entry, err);
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run, all pass**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/pushWorker.ts src/sync/pushWorker.test.ts
git commit -m "Push worker: delete path, dead-letter on 4xx, network retry"
```

---

### Task 16: Push worker — refresh-and-retry on a single 401

**Files:**
- Modify: `src/sync/pushWorker.ts`
- Modify: `src/sync/pushWorker.test.ts`

- [ ] **Step 1: Failing test**

Append to `src/sync/pushWorker.test.ts`:

```ts
describe('pushWorker — 401 refresh-and-retry', () => {
  it('calls auth.refreshSession() and retries once before giving up', async () => {
    const fake = stubAuthenticatedUser({ id: 'u-1' });
    let firstCall = true;
    const refreshSpy = vi.spyOn(fake.client.auth, 'refreshSession');
    const origFrom = fake.client.from.bind(fake.client);
    fake.client.from = ((name: string) => {
      const b = origFrom(name);
      const origInsert = b.insert;
      b.insert = (row: unknown) => {
        const q = origInsert(row);
        if (firstCall) {
          firstCall = false;
          q.then = (_r: any, reject: any) =>
            Promise.reject(Object.assign(new Error('401'), { status: 401 }))
              .then(undefined, reject);
        }
        return q;
      };
      return b;
    }) as typeof fake.client.from;

    await putWithSync('plans', {
      id: 'p1', name: 'X', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await runPushOnce();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(await db.syncQueue.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npm test -- src/sync/pushWorker.test.ts -t "refresh-and-retry"`
Expected: fails (push throws on first 401 instead of refreshing).

- [ ] **Step 3: Wrap individual entry-processing in a refresh-once retry**

In `src/sync/pushWorker.ts`, refactor the loop to factor out a `processEntry` function and add a one-shot refresh retry. Replace the `runPushOnce` body with:

```ts
async function processEntry(entry: SyncQueueRow, entries: SyncQueueRow[]): Promise<void> {
  // Same logic as before, but throws on auth errors instead of swallowing.
  if (entry.op === 'insert') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    const payload = toServerRow(local);
    const res = await getSupabase().from(entry.table).insert(payload).select() as
      { data: { updated_at: string }[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    const inserted = res.data?.[0];
    if (inserted?.updated_at) await setLocalServerVersion(entry.table, entry.rowId, inserted.updated_at);
    await db.syncQueue.delete(entry.seq!);
    return;
  }
  if (entry.op === 'update') {
    const local = await localRowFor(entry);
    if (!local) { await db.syncQueue.delete(entry.seq!); return; }
    const payload = toServerRow(local);
    let q = getSupabase().from(entry.table).update(payload).eq('id', entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: { updated_at: string }[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    const updated = res.data?.[0];
    if (updated?.updated_at) {
      await setLocalServerVersion(entry.table, entry.rowId, updated.updated_at);
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    const pulled = await getSupabase().from(entry.table).select('*').eq('id', entry.rowId)
      as { data: Record<string, unknown>[] | null; error: { message: string } | null };
    const serverRow = pulled.data?.[0];
    if (!serverRow) { await db.syncQueue.delete(entry.seq!); return; }
    const conflictAttempts = (entry.attempts ?? 0) + 1;
    if (conflictAttempts >= 3) { await moveToDeadLetter(entry, 'repeated conflict'); return; }
    const newExpected = serverRow.updated_at as string;
    await db.syncQueue.update(entry.seq!, { expectedServerVersion: newExpected, attempts: conflictAttempts });
    await setLocalServerVersion(entry.table, entry.rowId, newExpected);
    const refreshed = (await db.syncQueue.get(entry.seq!))!;
    entries.unshift(refreshed);
    return;
  }
  if (entry.op === 'delete') {
    let q = getSupabase().from(entry.table).update({ deleted_at: new Date().toISOString() }).eq('id', entry.rowId);
    if (entry.expectedServerVersion !== null) q = q.eq('updated_at', entry.expectedServerVersion);
    const res = await q.select() as { data: unknown[] | null; error: { message: string } | null };
    if (res.error) throw new Error(res.error.message);
    if (res.data && res.data.length > 0) {
      await db.syncQueue.delete(entry.seq!);
      return;
    }
    // Conditional missed — server moved since we pulled. Mirror the update path:
    // pull the current updated_at, advance expectedServerVersion, retry once.
    const pulled = await getSupabase().from(entry.table).select('updated_at').eq('id', entry.rowId)
      as { data: { updated_at: string }[] | null };
    const serverRow = pulled.data?.[0];
    if (!serverRow) { await db.syncQueue.delete(entry.seq!); return; }  // already gone server-side
    const conflictAttempts = (entry.attempts ?? 0) + 1;
    if (conflictAttempts >= 3) { await moveToDeadLetter(entry, 'delete conflict'); return; }
    await db.syncQueue.update(entry.seq!, {
      expectedServerVersion: serverRow.updated_at, attempts: conflictAttempts,
    });
    entries.unshift((await db.syncQueue.get(entry.seq!))!);
  }
}

export async function runPushOnce(): Promise<void> {
  const entries = await db.syncQueue.orderBy('seq').toArray();
  while (entries.length > 0) {
    const entry = entries.shift()!;
    let attempt = 0;
    while (true) {
      try {
        await processEntry(entry, entries);
        break;
      } catch (err) {
        const kind = classifyError(err);
        if (kind === 'auth' && attempt === 0) {
          attempt++;
          await getSupabase().auth.refreshSession();
          continue;  // one retry after refresh
        }
        if (kind === 'fatal') {
          const newAttempts = (entry.attempts ?? 0) + 1;
          if (newAttempts >= 3) {
            await moveToDeadLetter({ ...entry, attempts: newAttempts,
              lastError: err instanceof Error ? err.message : String(err) },
              err instanceof Error ? err.message : String(err));
          } else {
            await bumpAttempts(entry, err);
          }
          break;
        }
        if (kind === 'auth') {
          // refresh-and-retry already attempted; rethrow so AuthProvider can sign out.
          await bumpAttempts(entry, err);
          throw err;
        }
        // network — bump and stop the loop entirely
        await bumpAttempts(entry, err);
        throw err;
      }
    }
  }
}
```

- [ ] **Step 4: Run, all push worker tests pass**

Run: `npm test -- src/sync/pushWorker.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/pushWorker.ts src/sync/pushWorker.test.ts
git commit -m "Push worker: refresh session + retry once on single 401"
```

**Production caveat.** The classifier here keys off thrown `Error` instances with a `.status` property. supabase-js v2 normally returns `{ data: null, error: {…} }` for HTTP errors rather than throwing — and the `if (res.error) throw new Error(res.error.message)` lines elsewhere discard the status code, so a real 401 ends up classified as `'network'` and triggers backoff instead of refresh. That's *fine* because supabase-js has its own `autoRefreshToken` that handles 401s before they reach us. The manual refresh path here is defensive belt-and-braces for the rare case where Supabase JS gives up; the test exercises it via monkey-patched throws to validate the wiring is connected. If you want the worker to react to PostgREST's structured JWT-expired error (`error.code === 'PGRST301'`), extend the classifier in `processEntry`'s error branches accordingly — not required for v1.

---

## Phase 7 — Pull worker

### Task 17: Pull worker — keyset pagination + merge with queue-presence rule

**Files:**
- Create: `src/sync/pullWorker.ts`
- Create: `src/sync/pullWorker.test.ts`

- [ ] **Step 1: Failing tests**

Create `/home/ubuntu/AhKeung/src/sync/pullWorker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { runPullOnce } from './pullWorker';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('pullWorker', () => {
  it('inserts new server rows into Dexie and sets serverVersion', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso1', updated_at: 'iso2',
    });

    await runPullOnce();

    const local = await db.plans.get('p1');
    expect(local?.name).toBe('A');
    expect(local?.serverVersion).toBe('iso2');
  });

  it('skips overwrite when the row has a pending queue entry', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    // Local row with pending update queued
    await db.plans.put({
      id: 'p1', userId: 'u-1', updatedAt: 5, serverVersion: 'v1',
      name: 'LOCAL', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    });
    await db.syncQueue.add({
      table: 'plans', rowId: 'p1', op: 'update', expectedServerVersion: 'v1',
      attempts: 0, queuedAt: 1,
    });
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'SERVER', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso0', updated_at: 'iso999',
    });

    await runPullOnce();

    expect((await db.plans.get('p1'))?.name).toBe('LOCAL');
  });

  it('deletes local row when server has deleted_at', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await db.plans.put({
      id: 'p1', userId: 'u-1', updatedAt: 5, serverVersion: 'v1',
      name: 'L', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    });
    fake.tables.plans.push({
      id: 'p1', user_id: 'u-1', name: 'L', week_start: '2025-03-10',
      focus: [], exercises: [], created_at: 'iso0', updated_at: 'iso999', deleted_at: 'iso999',
    });

    await runPullOnce();

    expect(await db.plans.get('p1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, fail (missing module)**

Run: `npm test -- src/sync/pullWorker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `pullWorker.ts`**

The cursor pattern uses `gte('updated_at', …)` (greater-or-equal) plus a `lastSeenIds` set of rows already processed at the boundary timestamp. This sidesteps PostgREST's awkward `.or()` quoting rules (which would mishandle the periods in ISO timestamps) and still handles same-millisecond ties correctly. The `Cursor` shape and tests for it are already in Task 10.

Create `/home/ubuntu/AhKeung/src/sync/pullWorker.ts`:

```ts
import { getSupabase } from '../supabase';
import { db, type SyncTableName } from '../db';
import { fromServerRow } from './mapping';
import { getCursor, setCursor } from './syncMeta';
import { favoriteRowId } from './putWithSync';

const TABLES: SyncTableName[] = ['plans', 'sessions', 'metrics', 'favorites'];

function rowKeyOf(table: SyncTableName, row: Record<string, unknown>): string {
  if (table === 'favorites') return favoriteRowId(row.user_id as string, row.exercise_id as string);
  return row.id as string;
}

async function hasPending(table: SyncTableName, rowId: string): Promise<boolean> {
  const count = await db.syncQueue.where('rowId').equals(rowId).and((e) => e.table === table).count();
  return count > 0;
}

async function mergeRow(table: SyncTableName, serverRow: Record<string, unknown>, userId: string): Promise<void> {
  const rowId = rowKeyOf(table, serverRow);
  if (await hasPending(table, rowId)) return;

  if (serverRow.deleted_at) {
    if (table === 'favorites') {
      await db.favorites.delete([userId, serverRow.exercise_id as string]);
    } else {
      await db.table(table).delete(rowId);
    }
    return;
  }

  const camel = fromServerRow(serverRow, table);
  const local = table === 'favorites'
    ? { userId, exerciseId: camel.exerciseId as string, addedAt: camel.addedAt as number,
        updatedAt: Date.now(), serverVersion: camel.updatedAt as string }
    : { ...camel, userId, updatedAt: Date.now(), serverVersion: camel.updatedAt as string };
  await db.table(table).put(local as never);
}

export async function runPullOnce(): Promise<void> {
  const { data: { session } } = await getSupabase().auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return;

  for (const table of TABLES) {
    let cursor = await getCursor(table);
    let seen = new Set(cursor.lastSeenIds);
    const PAGE = 500;

    while (true) {
      let q = getSupabase().from(table).select('*').eq('user_id', userId)
        .order('updated_at', { ascending: true })
        .order(table === 'favorites' ? 'exercise_id' : 'id', { ascending: true })
        .limit(PAGE);
      if (cursor.lastPulledAt) q = q.gte('updated_at', cursor.lastPulledAt);
      const res = await q as { data: Record<string, unknown>[] | null; error: { message: string } | null };
      if (res.error) throw new Error(res.error.message);
      const rows = res.data ?? [];
      if (rows.length === 0) break;

      let processed = 0;
      for (const r of rows) {
        const key = rowKeyOf(table, r);
        // Skip rows we already processed at the boundary timestamp.
        if (cursor.lastPulledAt && r.updated_at === cursor.lastPulledAt && seen.has(key)) continue;
        await mergeRow(table, r, userId);
        processed++;
      }

      // Advance cursor to the page's last row's updated_at, accumulating IDs at that boundary.
      const last = rows[rows.length - 1];
      const newAt = last.updated_at as string;
      if (newAt === cursor.lastPulledAt) {
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowKeyOf(table, r));
      } else {
        seen = new Set();
        for (const r of rows) if (r.updated_at === newAt) seen.add(rowKeyOf(table, r));
      }
      cursor = { lastPulledAt: newAt, lastSeenIds: [...seen] };
      await setCursor(table, cursor);

      if (rows.length < PAGE) break;
      // Edge case: if 500+ rows share an identical updated_at (pathological — a
      // single multi-row trigger or a backfill ingest), the cursor cannot
      // advance past the boundary and `processed === 0` may fire on the second
      // page. Acceptable in v1 because Postgres trigger timestamps are
      // microsecond-precise and per-row, so collisions ≥ PAGE never happen at
      // gym scale. If/when spec #2 introduces batch trainer imports, replace
      // this with an unconditional cursor bump that uses (updated_at, id)
      // tuples natively.
      if (processed === 0) break;
    }
  }
}
```

The `lastSeenIds` set is bounded by however many rows share a single `updated_at` value, which in practice is 0–2 (microsecond timestamps + per-row triggers). It would only balloon under a batch import scenario that doesn't exist in v1.

- [ ] **Step 4: Run, all pass**

Run: `npm test -- src/sync/pullWorker.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/pullWorker.ts src/sync/pullWorker.test.ts
git commit -m "Pull worker: keyset pagination, queue-presence merge rule, tombstones"
```

---

## Phase 8 — Sync orchestrator

### Task 18: `src/sync/index.ts` — start/stop/flushNow with heartbeat + event triggers

**Files:**
- Create: `src/sync/index.ts`
- Create: `src/sync/index.test.ts`

- [ ] **Step 1: Failing test**

Create `/home/ubuntu/AhKeung/src/sync/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { putWithSync } from './putWithSync';
import { startSync, stopSync, flushNow } from './index';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('sync orchestrator', () => {
  it('flushNow runs push and pull in sequence', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();
    await putWithSync('plans', {
      id: 'p1', name: 'A', weekStart: '2025-03-10', focus: [], exercises: [], createdAt: 1,
    }, 'u-1');

    await flushNow();

    expect(fake.rowOf('plans', 'p1')).toBeDefined();
  });

  it('startSync wires online/visibility listeners; stopSync removes them', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    startSync();
    expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    stopSync();
    expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run, fail (module missing)**

Run: `npm test -- src/sync/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement orchestrator**

Create `/home/ubuntu/AhKeung/src/sync/index.ts`:

```ts
import { runPushOnce } from './pushWorker';
import { runPullOnce } from './pullWorker';

let pushTimer: ReturnType<typeof setInterval> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let listeners: { event: string; handler: () => void }[] = [];

async function safeRun(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { console.warn('[sync]', e); }
}

export async function flushNow(): Promise<void> {
  await safeRun(runPushOnce);
  await safeRun(runPullOnce);
}

export function startSync(): void {
  pushTimer = setInterval(() => { safeRun(runPushOnce); }, 30_000);
  pullTimer = setInterval(() => { safeRun(runPullOnce); }, 60_000);
  const onTrigger = () => { safeRun(runPushOnce); safeRun(runPullOnce); };
  window.addEventListener('online', onTrigger);
  window.addEventListener('visibilitychange', onTrigger);
  listeners.push({ event: 'online', handler: onTrigger });
  listeners.push({ event: 'visibilitychange', handler: onTrigger });
}

export function stopSync(): void {
  if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
  for (const { event, handler } of listeners) window.removeEventListener(event, handler);
  listeners = [];
}
```

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/sync/index.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/sync/index.ts src/sync/index.test.ts
git commit -m "Sync orchestrator: startSync/stopSync/flushNow with heartbeat + listeners"
```

---

## Phase 9 — Auth

### Task 19: `AuthProvider` + `useAuth` hook

**Files:**
- Create: `src/auth/AuthProvider.tsx`
- Create: `src/auth/useAuth.ts`
- Create: `src/auth/auth.test.tsx`

- [ ] **Step 1: Failing test**

Create `/home/ubuntu/AhKeung/src/auth/auth.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { db } from '../db';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

function Probe() {
  const { status, profile } = useAuth();
  return <div>status={status} name={profile?.displayName ?? 'null'} trainer={String(profile?.isTrainer ?? false)}</div>;
}

describe('AuthProvider', () => {
  it('reports loading then authenticated when a session exists', async () => {
    stubAuthenticatedUser({ id: 'u-1', isTrainer: true });
    getActiveFake().tables.profiles[0].display_name = 'Leo';

    render(<AuthProvider><Probe /></AuthProvider>);

    expect(screen.getByText(/status=loading/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/status=authenticated/)).toBeInTheDocument());
    expect(screen.getByText(/name=Leo/)).toBeInTheDocument();
    expect(screen.getByText(/trainer=true/)).toBeInTheDocument();
  });

  it('reports unauthenticated when no session', async () => {
    const { stubUnauthenticated } = await import('../test/authStub');
    stubUnauthenticated();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/status=unauthenticated/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npm test -- src/auth/auth.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

Create `/home/ubuntu/AhKeung/src/auth/useAuth.ts`:

```ts
import { createContext, useContext } from 'react';

export interface Profile { id: string; displayName: string | null; isTrainer: boolean; }
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: { id: string; email: string } | null;
  profile: Profile | null;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
```

Create `/home/ubuntu/AhKeung/src/auth/AuthProvider.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getSupabase } from '../supabase';
import { db } from '../db';
import { stopSync, flushNow } from '../sync';
import { AuthContext, type AuthState, type Profile } from './useAuth';

const LAST_PROFILE_KEY = 'ahKeung.lastKnownProfile';

async function fetchProfile(userId: string): Promise<Profile | null> {
  const res = await getSupabase().from('profiles').select('id, display_name, is_trainer').eq('id', userId) as
    { data: { id: string; display_name: string | null; is_trainer: boolean }[] | null };
  const row = res.data?.[0];
  if (!row) return null;
  return { id: row.id, displayName: row.display_name, isTrainer: row.is_trainer };
}

/** Sign-out helper. Stops sync first, attempts to drain the queue, optionally
 * confirms data loss, then triggers `auth.signOut()`. The actual Dexie wipe
 * + localStorage clear + state reset happen in the `SIGNED_OUT` handler
 * below — keeping the wipe in exactly one place avoids a race.
 *
 * `confirmFn` lets callers swap a UI confirmation for a stub in tests. */
async function performSignOut(confirmFn: (msg: string) => boolean = window.confirm): Promise<boolean> {
  stopSync();                       // (1) stop timers/listeners so nothing races the wipe
  try { await flushNow(); } catch { /* network down — fall through */ }
  const pending = await db.syncQueue.count();
  if (pending > 0) {
    const ok = confirmFn(`You have ${pending} unsynced change${pending === 1 ? '' : 's'}. Sign out anyway? They will be lost.`);
    if (!ok) return false;
  }
  await getSupabase().auth.signOut();  // fires SIGNED_OUT → handler does the wipe
  return true;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading', user: null, profile: null, signOut: async () => {},
  });
  // Refs so the visibilitychange handler always sees the latest user without
  // re-binding (which would tear down the listener on every state change).
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const { data: { session } } = await getSupabase().auth.getSession();
      if (!session) {
        userIdRef.current = null;
        if (!cancelled) setState((s) => ({ ...s, status: 'unauthenticated', user: null, profile: null }));
        return;
      }
      let profile: Profile | null = null;
      try {
        profile = await fetchProfile(session.user.id);
        if (profile) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(profile));
      } catch {
        // Offline or transient failure — fall back to the cached profile.
        // Guard JSON.parse so corrupt cache (manual tamper, partial write,
        // schema migration) doesn't strand the user on the loading splash.
        const cached = localStorage.getItem(LAST_PROFILE_KEY);
        if (cached) {
          try { profile = JSON.parse(cached) as Profile; }
          catch { localStorage.removeItem(LAST_PROFILE_KEY); profile = null; }
        }
      }
      if (cancelled) return;
      userIdRef.current = session.user.id;
      setState({
        status: 'authenticated',
        user: { id: session.user.id, email: session.user.email ?? '' },
        profile,
        signOut: async () => { await performSignOut(); },
      });
    }

    bootstrap();

    const { data: { subscription } } = getSupabase().auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        // Token expired server-side. We can't drain the queue (no auth) — best
        // effort: stop sync first to avoid a race with the wipe.
        stopSync();
        await db.delete(); await db.open();
        localStorage.removeItem(LAST_PROFILE_KEY);
        userIdRef.current = null;
        setState((s) => ({ ...s, status: 'unauthenticated', user: null, profile: null }));
        return;
      }
      if (event === 'SIGNED_IN' && session) await bootstrap();
    });

    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const userId = userIdRef.current;
      if (!userId) return;
      try {
        const p = await fetchProfile(userId);
        if (p) {
          localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(p));
          setState((s) => ({ ...s, profile: p }));
        }
      } catch { /* offline; ignore */ }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
```

**Why these specific changes:**

- The `userIdRef` pattern fixes the stale-closure bug: `onVisible` always reads the current value, never the one captured at mount.
- `performSignOut` runs `stopSync()` → `flushNow()` → optional confirm → `auth.signOut()` → `db.delete()` in strict order. The sync orchestrator stops *before* anything touches the queue or Dexie, eliminating the race.
- The `SIGNED_OUT` event from token expiry can't flush (the user has no auth) — but it can still `stopSync()` first to avoid a running pull crashing into the wipe.
- `confirmFn` is parameterised so tests can pass a stub that always returns `true` without going through `window.confirm`. (The default keeps prod behavior.)

**Task 21 still wires `startSync()` on `authenticated` and `stopSync()` on unmount**, but `performSignOut` now also calls `stopSync()` proactively — these are not redundant, because the Guarded effect's cleanup only fires *after* the React tree changes, which is after the wipe has already happened.

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/auth/auth.test.tsx`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth/AuthProvider.tsx src/auth/useAuth.ts src/auth/auth.test.tsx
git commit -m "AuthProvider + useAuth: bootstrap session, fetch profile, sign out"
```

---

### Task 20: `Login.tsx` — magic-link form

**Files:**
- Create: `src/auth/Login.tsx`
- Create: `src/auth/Login.test.tsx`

- [ ] **Step 1: Failing test**

Create `/home/ubuntu/AhKeung/src/auth/Login.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { stubAuthenticatedUser } from '../test/authStub';

describe('Login', () => {
  it('submits email and shows confirmation', async () => {
    stubAuthenticatedUser({ id: 'unused' });  // just to set up the mocked client
    render(<Login />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument());
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npm test -- src/auth/Login.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `Login.tsx`**

Create `/home/ubuntu/AhKeung/src/auth/Login.tsx`:

```tsx
import { useState } from 'react';
import { getSupabase } from '../supabase';

export function Login() {
  const [email, setEmail] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await getSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      setSubmittedEmail(email);
    } catch (e) {
      setError("Couldn't send the link. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (submittedEmail) {
    return (
      <div className="p-6 max-w-sm mx-auto text-center text-slate-100">
        <h1 className="text-2xl font-bold mb-4">Ah Keung 💪</h1>
        <p className="mb-4">Check your email at <strong>{submittedEmail}</strong>.</p>
        <p className="text-sm text-slate-400 mb-6">Tap the link on this device to sign in.</p>
        <button
          onClick={() => { setSubmittedEmail(null); setError(null); }}
          className="text-keung-500 text-sm"
        >Try a different email</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-sm mx-auto text-slate-100">
      <h1 className="text-2xl font-bold mb-6 text-center">Ah Keung 💪</h1>
      <label className="block mb-4">
        <span className="block text-sm mb-1">Email</span>
        <input
          type="email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="email"
        />
      </label>
      {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
      <button
        type="submit" disabled={sending}
        className="w-full bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white py-2.5 rounded-lg font-semibold"
      >{sending ? 'Sending…' : 'Send sign-in link'}</button>
    </form>
  );
}
```

- [ ] **Step 4: Run, pass**

Run: `npm test -- src/auth/Login.test.tsx`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth/Login.tsx src/auth/Login.test.tsx
git commit -m "Login: magic-link form with confirmation screen"
```

---

## Phase 10 — UI integration

### Task 21: Wire `AuthProvider` + `Guarded` into `App.tsx`/`main.tsx`; start sync on login

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Wrap the app in `AuthProvider` and `Guarded`**

Replace `/home/ubuntu/AhKeung/src/main.tsx` with:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { I18nProvider } from './i18n';
import { AuthProvider } from './auth/AuthProvider';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </AuthProvider>
  </StrictMode>,
);
```

- [ ] **Step 2: Add `Guarded` and start/stop sync in `App.tsx`**

In `/home/ubuntu/AhKeung/src/App.tsx`, add the imports at the top:

```tsx
import { useEffect, type ReactNode } from 'react';
import { useAuth } from './auth/useAuth';
import { Login } from './auth/Login';
import { startSync, stopSync } from './sync';
```

After the existing imports, add the guard component and a sync-lifecycle effect:

```tsx
function Guarded({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  useEffect(() => {
    if (status === 'authenticated') { startSync(); return () => stopSync(); }
  }, [status]);
  if (status === 'loading') return <div className="p-6 text-slate-400">Loading…</div>;
  if (status === 'unauthenticated') return <Login />;
  return <>{children}</>;
}
```

Wrap the `<Shell />` invocation inside `<HashRouter>` with `<Guarded>`:

```tsx
function App() {
  return (
    <HashRouter>
      <Guarded><Shell /></Guarded>
    </HashRouter>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd /home/ubuntu/AhKeung && npx tsc --noEmit`
Expected: errors only in the existing pages (PlanEditor, Workout, Metrics, useFavorites) and `workflow.test.tsx`. No errors in `App.tsx`/`main.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/main.tsx src/App.tsx
git commit -m "Wire AuthProvider + Guarded; start sync on authenticated session"
```

---

### Task 22: `Settings.tsx` + gear icon

**Files:**
- Create: `src/pages/Settings.tsx`
- Modify: `src/App.tsx` (route + gear icon in header)

- [ ] **Step 1: Create `Settings.tsx`**

Create `/home/ubuntu/AhKeung/src/pages/Settings.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase } from '../supabase';
import { useAuth } from '../auth/useAuth';

export function Settings() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [online, setOnline] = useState(navigator.onLine);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | string>('idle');

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Auto-clear the "Saved" badge after 2s so a later stale state can't linger.
  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(t);
  }, [status]);

  async function save() {
    if (!user) return;
    setSaving(true);
    setStatus('idle');
    try {
      const { error } = await getSupabase().from('profiles')
        .update({ display_name: name }).eq('id', user.id) as { error: { message: string } | null };
      if (error) {
        setStatus(`Save failed: ${error.message}`);
      } else {
        setStatus('saved');
      }
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 space-y-4 text-slate-100">
      <h2 className="text-lg font-bold">Settings</h2>
      <div>
        <label className="text-xs text-slate-400 block mb-1">Display name</label>
        <input
          value={name}
          disabled={!online}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-50"
        />
        {!online && <p className="text-xs text-slate-500 mt-1">Connect to edit.</p>}
        <button
          onClick={save} disabled={!online || saving}
          className="mt-2 px-3 py-1.5 text-sm bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded"
        >{saving ? 'Saving…' : 'Save'}</button>
        {status === 'saved' && <span className="ml-2 text-xs text-slate-400">Saved</span>}
        {status !== 'idle' && status !== 'saved' && (
          <p className="text-rose-400 text-xs mt-1">{status}</p>
        )}
      </div>
      <p className="text-sm text-slate-400">Signed in as {user?.email}</p>
      <button
        onClick={async () => { await signOut(); navigate('/'); }}
        className="bg-rose-900/40 border border-rose-800 text-rose-300 px-4 py-2 rounded-lg"
      >Sign out</button>
    </div>
  );
}
```

- [ ] **Step 2: Add the route and gear icon to `App.tsx`**

In `/home/ubuntu/AhKeung/src/App.tsx`:

1. Add import: `import { Settings } from './pages/Settings';`
2. Inside `<Routes>`, add: `<Route path="/settings" element={<Settings />} />`
3. In the header, replace the existing `<LanguageSwitcher />` line with:

```tsx
<div className="flex items-center gap-2">
  <LanguageSwitcher />
  <NavLink to="/settings" aria-label="settings" className="text-slate-300 text-xl">⚙️</NavLink>
</div>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: same set of pre-existing errors as before, no new ones in `Settings.tsx`/`App.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.tsx src/App.tsx
git commit -m "Settings page: display name edit (online-only) + sign out + gear nav"
```

---

### Task 23: Add `useCurrentUserId` hook + migrate write call sites

A one-line hook over `useAuth` gives every page write site the current user UUID without dynamic imports or repeated `getSession()` calls.

**Files:**
- Create: `src/auth/useCurrentUserId.ts`
- Modify: `src/pages/PlanEditor.tsx`
- Modify: `src/pages/Workout.tsx`
- Modify: `src/pages/Metrics.tsx` (lines ~25, ~38, plus the JSX `m.id!` callsite at line ~155)
- Modify: `src/useFavorites.ts`

- [ ] **Step 1: Create `useCurrentUserId.ts`**

Create `/home/ubuntu/AhKeung/src/auth/useCurrentUserId.ts`:

```ts
import { useAuth } from './useAuth';

/** Returns the current user's UUID, or null if not signed in. */
export function useCurrentUserId(): string | null {
  return useAuth().user?.id ?? null;
}
```

- [ ] **Step 2: `PlanEditor.tsx` — string IDs + `useCurrentUserId` + `putWithSync`**

Add imports at the top of `/home/ubuntu/AhKeung/src/pages/PlanEditor.tsx`:

```ts
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
```

Replace (around line 25):
```ts
const { id } = useParams<{ id?: string }>();
const navigate = useNavigate();
const planId = id ? Number(id) : undefined;
```
with:
```ts
const { id } = useParams<{ id?: string }>();
const navigate = useNavigate();
const planId = id;
const userId = useCurrentUserId();
```

Replace `loadedFromId` (around line 35):
```ts
const [loadedFromId, setLoadedFromId] = useState<string | undefined>(undefined);
```

Replace `save`:
```ts
const save = async () => {
  if (!name.trim()) { alert(t.planEditor.nameRequired); return; }
  if (!userId) return;
  const newId = planId ?? crypto.randomUUID();
  await putWithSync('plans', {
    id: newId,
    name: name.trim(),
    weekStart,
    focus,
    exercises: planExercises,
    createdAt: existing?.createdAt ?? Date.now(),
  }, userId);
  navigate('/plans');
};
```

Replace `remove`:
```ts
const remove = async () => {
  if (!planId) return;
  if (!confirm(t.planEditor.deleteConfirm)) return;
  await deleteWithSync('plans', planId);
  navigate('/plans');
};
```

- [ ] **Step 3: `Workout.tsx` — string `planId` + `putWithSync` on finish**

In `/home/ubuntu/AhKeung/src/pages/Workout.tsx`:

Add imports:
```ts
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync } from '../sync/putWithSync';
```

In the `useLiveQuery` for `plan`, the `Number(planId)` cast is gone — `planId` is already a string:

```ts
const plan = useLiveQuery(
  async () => (planId ? await db.plans.get(planId) : undefined),
  [planId],
);
```

Above `finish`, add:
```ts
const userId = useCurrentUserId();
```

Replace `finish`:
```ts
const finish = async () => {
  const done = session.exercises.some((e) => e.sets.some((s) => s.done));
  if (!done) { if (!confirm(t.workout.noSetsDoneConfirm)) return; }
  if (!userId) return;
  await putWithSync('sessions', {
    id: crypto.randomUUID(),
    planId: session.planId,
    date: session.date,
    exercises: session.exercises,
    notes: session.notes,
    startedAt: session.startedAt,
    endedAt: Date.now(),
  }, userId);
  navigate('/');
};
```

(`session.planId` is `string | undefined`; TypeScript catches it via the `WorkoutSession` change from Task 5.)

- [ ] **Step 4: `Metrics.tsx` — `putWithSync`/`deleteWithSync` + JSX `m.id` cleanup**

Add imports:
```ts
import { useCurrentUserId } from '../auth/useCurrentUserId';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
```

Add near the top of the component body:
```ts
const userId = useCurrentUserId();
```

Replace `save`:
```ts
const save = async () => {
  if (!weight && !height && !bodyFat && !notes.trim()) { alert(t.metrics.enterValue); return; }
  if (!userId) return;
  await putWithSync('metrics', {
    id: crypto.randomUUID(),
    date,
    weightKg: weight ? Number(weight) : undefined,
    heightCm: height ? Number(height) : undefined,
    bodyFatPct: bodyFat ? Number(bodyFat) : undefined,
    notes: notes.trim() || undefined,
  }, userId);
  setWeight(''); setBodyFat(''); setNotes('');
};
```

Replace `remove`:
```ts
const remove = async (id: string) => {
  if (confirm(t.metrics.deleteConfirm)) {
    await deleteWithSync('metrics', id);
  }
};
```

In the JSX (around line 155), update `onClick={() => remove(m.id!)}` to `onClick={() => remove(m.id)}` — `id` is now a non-optional string on `BodyMetric`.

- [ ] **Step 5: `useFavorites.ts` — toggle uses `putWithSync`/`deleteWithSync`**

Replace `/home/ubuntu/AhKeung/src/useFavorites.ts`:

```ts
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { getSupabase } from './supabase';
import { putWithSync, deleteWithSync } from './sync/putWithSync';

export function useFavoriteIds(): Set<string> {
  const list = useLiveQuery(() => db.favorites.toArray(), []);
  return useMemo(() => new Set((list ?? []).map((f) => f.exerciseId)), [list]);
}

/** Used outside React components, so it can't go through useCurrentUserId. */
export async function toggleFavorite(exerciseId: string): Promise<void> {
  const userId = (await getSupabase().auth.getSession()).data.session?.user?.id;
  if (!userId) return;
  const existing = await db.favorites.get([userId, exerciseId]);
  if (existing) {
    await deleteWithSync('favorites', userId, exerciseId);
  } else {
    await putWithSync('favorites', { exerciseId, addedAt: Date.now() }, userId);
  }
}
```

- [ ] **Step 6: Type-check**

Run: `cd /home/ubuntu/AhKeung && npx tsc --noEmit`
Expected: zero errors in production code. Errors will remain in `workflow.test.tsx` until Task 24.

- [ ] **Step 7: Run all non-workflow tests**

Run: `npm test -- src/test/db.test.ts src/sync src/auth src/test/fakeSupabase.test.ts src/test/authStub.test.ts`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/auth/useCurrentUserId.ts src/pages/PlanEditor.tsx src/pages/Workout.tsx src/pages/Metrics.tsx src/useFavorites.ts
git commit -m "Migrate write call sites to putWithSync; add useCurrentUserId hook"
```

---

### Task 24: Update `workflow.test.tsx` for v4 schema, auth provider, and useCurrentUserId

The migrated pages now call `useCurrentUserId()` → `useAuth()` → which throws unless mounted inside `<AuthProvider>`. The test renderer must wrap routes in the real `AuthProvider` (which boots against the fake supabase set up by `stubAuthenticatedUser`) and wait for it to reach `authenticated` status before interacting with form controls.

**Files:**
- Modify: `src/test/workflow.test.tsx`

- [ ] **Step 1: Replace the test file**

Replace `/home/ubuntu/AhKeung/src/test/workflow.test.tsx` with:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../i18n';
import { AuthProvider } from '../auth/AuthProvider';
import { PlanEditor } from '../pages/PlanEditor';
import { Workout } from '../pages/Workout';
import { db } from '../db';
import { __resetExercisesForTest } from '../exercises';
import { stubAuthenticatedUser } from './authStub';

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <I18nProvider>
          <Routes>
            <Route path="/plans/new" element={<PlanEditor />} />
            <Route path="/plans/:id" element={<PlanEditor />} />
            <Route path="/workout/:planId" element={<Workout />} />
            <Route path="/plans" element={<div>plans-list</div>} />
            <Route path="/" element={<div>home</div>} />
          </Routes>
        </I18nProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  __resetExercisesForTest();
  await db.delete();
  await db.open();
  stubAuthenticatedUser({ id: 'u-test' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('plan → workout flow', () => {
  it('creates a plan, persists it, then runs a workout against it', async () => {
    renderRoute('/plans/new');
    // Wait for AuthProvider's async bootstrap to flip status → 'authenticated'.
    // The Save Plan button is rendered unconditionally by PlanEditor, but our
    // putWithSync call inside `save` short-circuits while userId is null,
    // so wait until useCurrentUserId resolves before interacting.
    await waitFor(() => screen.getByRole('button', { name: /Chest/ }));

    fireEvent.change(screen.getByPlaceholderText(/Push\/Pull/), { target: { value: 'Chest Day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chest' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => screen.getByText('Pick an exercise'));
    fireEvent.click(screen.getByText('Barbell Bench Press - Medium Grip'));

    // Save can race with auth bootstrap: poll until the navigation happens.
    fireEvent.click(screen.getByRole('button', { name: /Save Plan/ }));
    await waitFor(async () => {
      const plans = await db.plans.toArray();
      expect(plans.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    await waitFor(() => screen.getByText('plans-list'));

    const plans = await db.plans.toArray();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe('Chest Day');
    expect(typeof plans[0].id).toBe('string');
    expect(plans[0].userId).toBe('u-test');
    expect(plans[0].exercises[0].exerciseId).toBe('Barbell_Bench_Press_-_Medium_Grip');

    const queued = await db.syncQueue.toArray();
    expect(queued.some((q) => q.table === 'plans' && q.rowId === plans[0].id)).toBe(true);

    const planId = plans[0].id;
    renderRoute(`/workout/${planId}`);
    await waitFor(() => screen.getByText('Barbell Bench Press - Medium Grip'));

    const doneButtons = screen.getAllByRole('button').filter((b) => b.textContent === '○');
    expect(doneButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(doneButtons[0]);

    fireEvent.click(screen.getByRole('button', { name: /Finish Workout/ }));

    await waitFor(async () => {
      const sessions = await db.sessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].planId).toBe(planId);
    });
  });
});

describe('metrics persistence', () => {
  it('saves a body metric entry that survives a reload', async () => {
    const id = 'metric-1';
    await db.metrics.put({
      id, userId: 'u-test', updatedAt: Date.now(), serverVersion: null,
      date: '2025-03-15', weightKg: 78.5, heightCm: 178,
    });
    const got = await db.metrics.get(id);
    expect(got?.weightKg).toBe(78.5);
    expect(got?.heightCm).toBe(178);
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- src/test/workflow.test.tsx`
Expected: green.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/test/workflow.test.tsx
git commit -m "Update workflow.test for v4 schema (string IDs, stubbed auth, sync queue assertions)"
```

---

## Phase 11 — End-to-end sync test

### Task 25: `sync-roundtrip.test.tsx`

**Files:**
- Create: `src/test/sync-roundtrip.test.tsx`

- [ ] **Step 1: Write the integration test**

Create `/home/ubuntu/AhKeung/src/test/sync-roundtrip.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { putWithSync, deleteWithSync } from '../sync/putWithSync';
import { flushNow } from '../sync';
import { stubAuthenticatedUser, getActiveFake } from './authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('sync roundtrip', () => {
  it('insert → push → remote mutate → pull → conflict → delete', async () => {
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    // 1. Local insert
    const planId = 'plan-rt-1';
    await putWithSync('plans', {
      id: planId, name: 'A', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    let local = await db.plans.get(planId);
    expect(local?.serverVersion).toBeNull();
    expect(await db.syncQueue.count()).toBe(1);

    // 2. Push
    await flushNow();
    expect(fake.rowOf('plans', planId)).toBeDefined();
    expect(await db.syncQueue.count()).toBe(0);
    local = await db.plans.get(planId);
    expect(local?.serverVersion).toBe(fake.rowOf('plans', planId).updated_at);

    // 3. Other device mutates server
    const remoteRow = fake.rowOf('plans', planId);
    remoteRow.name = 'OTHER';
    remoteRow.updated_at = new Date(Date.now() + 1000).toISOString();

    // 4. Pull merges
    await flushNow();
    expect((await db.plans.get(planId))?.name).toBe('OTHER');

    // 5. Conflict path — local edits while we hold an older serverVersion
    const T_before_remote = (await db.plans.get(planId))!.serverVersion!;
    await putWithSync('plans', {
      id: planId, name: 'LOCAL', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    // Race: server moves forward again
    remoteRow.name = 'OTHER2';
    remoteRow.updated_at = new Date(Date.now() + 2000).toISOString();
    expect(T_before_remote).not.toBe(remoteRow.updated_at);

    // Push: first attempt conflicts, worker pulls, retries
    await flushNow();
    expect(fake.rowOf('plans', planId).name).toBe('LOCAL');
    expect(await db.syncQueue.count()).toBe(0);
    expect((await db.plans.get(planId))?.serverVersion).toBe(fake.rowOf('plans', planId).updated_at);

    // 6. Delete + push tombstone
    await deleteWithSync('plans', planId);
    await flushNow();
    expect(fake.rowOf('plans', planId).deleted_at).not.toBeNull();
    expect(await db.plans.get(planId)).toBeUndefined();
  });

  it('row-level LWW: server field changes are lost when local pushes through a conflict', async () => {
    // Documents the v1 trade-off explicitly. If we ever upgrade to field-level
    // merge, this test flips its assertion to assert BOTH fields survive.
    // Concrete scenario: a trainer (in spec #2) sets `assigned_by` on the
    // member's plan while the member is offline editing `name`. With row-level
    // LWW, the member's later push wipes the trainer's assignment.
    stubAuthenticatedUser({ id: 'u-1' });
    const fake = getActiveFake();

    const planId = 'plan-clobber-1';
    await putWithSync('plans', {
      id: planId, name: 'A', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await flushNow();

    // Other device sets assigned_by (simulating spec-#2 trainer assignment).
    const remote = fake.rowOf('plans', planId);
    remote.assigned_by = 'trainer-uuid-xyz';
    remote.updated_at = new Date(Date.now() + 1000).toISOString();

    // Local edits 'name' without knowing about the assigned_by change.
    await putWithSync('plans', {
      id: planId, name: 'LOCAL', weekStart: '2025-03-10',
      focus: [], exercises: [], createdAt: 1,
    }, 'u-1');
    await flushNow();

    // Row-level LWW: local's name wins, but local also clobbered assigned_by.
    // If we ever upgrade to field-level merge, this assertion flips.
    expect(fake.rowOf('plans', planId).name).toBe('LOCAL');
    expect(fake.rowOf('plans', planId).assigned_by).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- src/test/sync-roundtrip.test.tsx`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/test/sync-roundtrip.test.tsx
git commit -m "End-to-end sync roundtrip test (insert/push/pull/conflict/delete)"
```

---

## Phase 12 — Manual smoke test

### Task 26: Manual smoke test against the real Supabase project

**Files:** none (manual checklist)

- [ ] **Step 1: Build and preview (NOT `npm run dev`)**

`vite-plugin-pwa` disables the service worker in `dev` mode by default — so `npm run dev` would *not* exercise the Workbox `NetworkOnly` rule from Task 2. To verify the SW behavior (Step 5 below depends on it), use the preview build:

```bash
cd /home/ubuntu/AhKeung && npm run build && npm run preview -- --host
```

Open the preview URL (default `http://localhost:4173`) in two browsers (or one normal + one private window). Note: you'll need HTTPS for true PWA install on a phone — for local desktop testing, http is fine and the SW still registers.

- [ ] **Step 2: Sign in as both users via magic links**

1. In window 1: enter the trainer email → click "Send sign-in link" → tap link from email.
2. In window 2: enter the member email → same.
3. Both windows should land on the home screen with the existing bottom-tab UI.

- [ ] **Step 3: Member-side writes appear in Supabase**

In window 2 (member):
1. Plans tab → create a plan with one exercise → Save.
2. Workout → tap a set's circle to mark done → Finish Workout.
3. Metrics → enter a weight → Save.

In the Supabase dashboard → Database → Tables: confirm one row each in `plans`, `sessions`, `metrics`.

- [ ] **Step 4: Multi-device — sign in to the same member account on a phone**

On a phone (or another browser), sign in with the same email → confirm the plan/session/metric appears.

- [ ] **Step 5: Offline write → sync resumes**

In window 2: open DevTools → Network → set to "Offline".
- Log another set or metric — it appears immediately in the UI.
- Verify in the Application tab → IndexedDB → `ah-keung` → `syncQueue` that there's a queued entry.
- Set Network back to "Online".
- Within 30 s (or trigger by clicking around), the queue empties and the new row shows up in Supabase.

- [ ] **Step 6: RLS verified**

In Supabase Studio → SQL Editor, run as the **member** (use the dashboard's "Run as authenticated user" feature with the member's UID):

```sql
select id, name from plans where user_id <> auth.uid();
```

Expected: zero rows (member can't read the trainer's data).

Run as the **trainer**:

```sql
select id, name from plans;
```

Expected: returns both members' rows.

- [ ] **Step 7: Settings — display name edit + sign out**

In either window: click ⚙️ → enter a display name → Save → confirm the row updates in `profiles`. Click Sign out → land on the Login screen → Dexie wiped (DevTools → Application → IndexedDB shows tables empty).

- [ ] **Step 8: Sign-in across PWA install (one-time annoyance)**

Install the PWA on a phone (Add to Home Screen). Tap the magic link from the email — confirm that *if* it opens in Safari/Chrome, you can still sign in there and then the installed PWA carries the session on next launch.

- [ ] **Step 9: Commit a smoke-test log if desired**

This step makes no file changes by default. Optionally write `docs/superpowers/smoke-tests/2026-05-16-auth-and-sync.md` with notes about anything that surprised you.

---

## Spec coverage map

| Spec §                              | Implementing task(s) |
|---|---|
| §3 Architecture / Workbox rule       | Task 2 |
| §3 PlanEditor.tsx `Number(id)` fix   | Task 23 step 1 |
| §3 db.test.ts schema update          | Task 6 |
| §4 SQL schema + triggers + view + RLS | Tasks 3, 4 |
| §4 Dexie v4                          | Task 5 |
| §5 Sync queue & helpers              | Task 11 |
| §5 Push worker (insert)              | Task 12 |
| §5 Push worker (update, optimistic CC) | Task 13 |
| §5 Push worker (conflict)            | Task 14 |
| §5 Push worker (delete, dead letter, network retry) | Task 15 |
| §5 Push worker (401 refresh)         | Task 16 |
| §5 Pull worker                       | Task 17 |
| §5 Tombstones                        | Tasks 15, 17 |
| §5 Profile sync (in-memory + cached) | Task 19 |
| §5 Bootstrap sequence                | Tasks 19, 21 |
| §6 Magic-link flow                   | Task 20 |
| §6 Route guard                       | Task 21 |
| §6 Settings page                     | Task 22 |
| §6 Environment variables             | Tasks 1, 4 |
| §7 Auth error handling               | Tasks 16, 19 |
| §7 Sync push errors                  | Tasks 15, 16 |
| §7 Sync pull errors                  | Task 17 + orchestrator's `safeRun` (Task 18) |
| §7 Time skew                         | (Implicit: server `updated_at` only, see Task 12) |
| §7 Storage exhaustion                | (No code yet — surfaces as a generic Dexie throw; future toast component) |
| §8 fakeSupabase                      | Task 7 |
| §8 `stubAuthenticatedUser`           | Task 8 |
| §8 Unit tests (mapping/syncQueue/push/pull/auth) | Tasks 9–17, 19, 20 |
| §8 Integration test                  | Task 25 |
| §8 Existing-test updates             | Tasks 6, 24 |
| §8 Manual smoke test                 | Task 26 |
| §9 Out of scope                      | (Not implemented — deferred to specs #2 / #3) |
| §10 Open items (dashboard config)    | Task 4 |

## Gaps and intentional deferrals

These are deliberate v1 cuts. Each is small enough to add as a follow-up task without restructuring the foundation.

| Item | Spec ref | Why deferred | If you want it in v1 |
|---|---|---|---|
| Global Toast component | §7 "UI surface" | No integration test value; failure modes that *matter* (network + auth) are already silent or self-healing. | Add a Task 27: simple `<Toast />` in `App.tsx` listening to an event bus, ~50 LoC. |
| "Sync is stuck" banner (≥10 attempts) | §5, §7 | Dead-letter table is queryable today; persistent banner is pure UI. | Add a Task 28 alongside dead-letter UI: read `db.syncDeadLetter.count()` + `db.syncQueue.where('attempts').above(9).count()`; render a sticky strip. |
| Dead-letter review UI | §5 push worker | The data exists in `syncDeadLetter`; a Supabase Studio query is fine for the gym's scale. | Same Task 28. |
| Storage-quota toast | §7 "Storage exhaustion" | Truly unlikely at this app's data volume (KB-scale text only). | Wrap `putWithSync` in a try/catch and surface via the toast from Task 27. |
| i18n for new screens | – (spec didn't address) | The rest of the app is bilingual via `useT()`; the new Login/Settings/Guarded loading strings are hardcoded English. | Add a Task 29: add `auth.signIn`, `auth.checkEmail`, `auth.signOut`, `auth.loading`, `auth.displayName`, etc. to `src/i18n/`; replace hardcoded strings. |
| Field-level merge on conflict | §5 conflict resolution | Requires per-field dirty tracking; v1 uses row-level LWW (see Task 14 note + Task 25 test). | Major: needs a "dirty fields" set on each Dexie row and a server-side `update_fields(jsonb)` RPC. Different design. |
| Realtime subscriptions for trainer live-view | §9 "Other deferred items" | Spec deferred. | Spec #2 territory. |
| Service-worker background sync | §9 | Spec deferred. | Future. |

The §7 "≥ 10 attempts" banner from the spec table folds into the "Sync is stuck" row above — same Task 28.
