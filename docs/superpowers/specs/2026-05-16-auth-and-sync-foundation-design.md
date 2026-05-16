# Auth & Sync Foundation — Design

**Status**: Draft for review
**Date**: 2026-05-16
**Scope**: First of three planned sub-projects. This spec covers authentication, user identity, role flag, and the local-first sync layer between Dexie and Supabase. It does **not** cover the trainer dashboard (spec #2) or selfie / equipment-photo capture (spec #3).

---

## 1. Motivation

Ah Keung today is an offline-first PWA with no concept of user identity — all data lives in IndexedDB on a single device. The gym wants:

1. Trainers to formulate plans and assign them to members, and to view members' metrics and exercise history for analysis.
2. Members to continue tracking workouts and health metrics, with their data following them across devices.
3. Trainers to eventually edit a shared exercise library (photos, notes).

None of those features can be built without a cloud backend, user identity, and a way to sync local data to that backend. This spec lays that foundation. Everything in specs #2 and #3 builds on what's defined here.

## 2. Constraints and decisions

These were agreed during brainstorming and are not revisited in this document.

| Decision | Choice |
|---|---|
| Tenancy | Single gym. Not multi-tenant. |
| Permissions | Members read their own data; trainers read everyone's. Writes are owner-only. |
| Roles | Single boolean `is_trainer` flag on the profile. Admin work happens in the Supabase dashboard. |
| Backend | Supabase (Postgres + Auth + RLS + Storage). |
| Auth method | Magic-link first sign-in. No public sign-up. No passwords in v1. |
| Account provisioning | Admin pre-creates rows in the Supabase dashboard. |
| Offline | Members work fully offline. Trainer reads of other members' data (spec #2) require online. |
| Local data migration | None. Pre-launch. Existing Dexie data is wiped on first login. |
| Sync model | Local-first. Dexie is the local source of truth; a queue pushes writes; a pull merges remote changes. |
| Conflict resolution | Optimistic-concurrency push (`update ... where updated_at = $expected`), pull-and-replay on conflict, dead-letter for 4xx/repeated conflicts. Effectively last-writer-wins by *server arrival order*, never client clock. |
| PWA | Stays a PWA. Service worker, manifest, install-to-home-screen all unchanged. |

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│  React UI  (pages/, components/)                │  unchanged
├─────────────────────────────────────────────────┤
│  Hooks  (useAuth NEW, useExercises, useFavorites)│  +1 hook
├─────────────────────────────────────────────────┤
│  Dexie  (local source of truth for reads)       │  +userId, +updatedAt, +serverVersion
├─────────────────────────────────────────────────┤
│  Sync layer  src/sync/   ←  NEW                 │
│   • pushQueue: outbound writes (optimistic CC)  │
│   • pull: inbound merge (keyset pagination)     │
│   • deadLetter: poisoned rows                   │
│   • mapping: snake_case ↔ camelCase             │
├─────────────────────────────────────────────────┤
│  Supabase JS client  (auth + Postgres + RLS)    │  NEW
└─────────────────────────────────────────────────┘
```

Reading direction: **always Dexie**. Reads never wait on the network.
Writing direction: write Dexie → enqueue sync row → background push to Supabase.
Trainer reads of *other* members' data in spec #2 will bypass Dexie and read Supabase directly. Dexie always and only contains the current user's own data.

### Key simplification

Dexie holds **only the current user's data, ever**. On login we pull the user's rows. On logout (or user switch) we wipe Dexie. Existing pages' Dexie *queries* remain naturally scoped to "me" because that's all Dexie contains — no `where(userId).equals(...)` clauses needed.

**What does change**: TypeScript types tighten (IDs become `string`, `userId` and `updatedAt` become required, `serverVersion` is added — see §5). Concretely this requires:

- Updating `src/test/db.test.ts` (the `verno === 3` assertion and the raw `db.plans.add({...})` calls that omit the new required fields).
- Updating `src/pages/PlanEditor.tsx`'s `Number(id)` URL parse — IDs are now UUID strings.
- Updating any other direct `db.<table>.add()` calls to populate the new fields (or to go through `putWithSync`, which fills them).

These are mechanical edits, but they exist and the spec must own them.

### Service worker / PWA caching

`vite-plugin-pwa`'s Workbox default can cache cross-origin GETs depending on `runtimeCaching`. A stale-while-revalidate hit against a Supabase REST URL would return cached JSON to the pull worker and silently corrupt local state. We add an explicit rule that Supabase traffic is **never** served from cache:

```ts
// vite.config.ts — within VitePWA({ workbox: { runtimeCaching: [...] } })
{
  urlPattern: ({ url }) => url.origin === import.meta.env.VITE_SUPABASE_URL_ORIGIN,
  handler: 'NetworkOnly',
}
```

Auth endpoints under `*.supabase.co/auth/v1/*` are also covered by this rule. The app shell (HTML/JS/CSS) keeps its existing cache-first behavior — that's the part that makes the PWA offline-launchable.

## 4. Data model

### Supabase Postgres schema

```sql
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,                                       -- nullable; UI prompts user to set on first launch
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

-- Auto-bump updated_at on update.
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger plans_touch     before update on plans     for each row execute function touch_updated_at();
create trigger sessions_touch  before update on sessions  for each row execute function touch_updated_at();
create trigger metrics_touch   before update on metrics   for each row execute function touch_updated_at();
create trigger favorites_touch before update on favorites for each row execute function touch_updated_at();

-- Auto-create a profile row when an auth user is created (admin in dashboard).
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
```

Admin sets `is_trainer = true` via the dashboard. `display_name` is `null` initially — the UI prompts the user to fill it on first launch. (We don't fall back to the email address because surfacing an email as a display name leaks contact info to other trainers.)

The `profiles.display_name` column is nullable accordingly (already reflected in the schema above).

Two changes from today's Dexie schema:

- IDs become UUIDs (strings) so clients can mint them offline.
- Every owned row carries `user_id`.

`plans.assigned_by` is included now so spec #2 needs no migration when it adds the assignment UI.

`deleted_at` enables tombstones for multi-device deletes (see §5).

### Row Level Security

```sql
alter table profiles  enable row level security;
alter table plans     enable row level security;
alter table sessions  enable row level security;
alter table metrics   enable row level security;
alter table favorites enable row level security;

create or replace function public.is_trainer() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select is_trainer from profiles where id = auth.uid()), false)
  $$;

revoke execute on function public.is_trainer() from public;
grant  execute on function public.is_trainer() to authenticated;

-- Read-only view: trainer display names, visible to every authenticated user.
-- Lets a member see "Assigned by trainer Bob" on a plan without granting
-- read access to the full profiles row. Used in spec #2.
-- security_invoker=off so the view bypasses the stricter profiles RLS for this
-- narrow projection (id + display_name only). This is the one deliberate
-- relaxation; the rest of profiles stays strictly self-only-for-members.
create or replace view public.trainer_names with (security_invoker = off) as
  select id, display_name from public.profiles where is_trainer = true;

grant select on public.trainer_names to authenticated;

-- Reads: own data or trainer.
create policy "plans_read"     on plans     for select using (user_id = auth.uid() OR public.is_trainer());
create policy "sessions_read"  on sessions  for select using (user_id = auth.uid() OR public.is_trainer());
create policy "metrics_read"   on metrics   for select using (user_id = auth.uid() OR public.is_trainer());
create policy "favorites_read" on favorites for select using (user_id = auth.uid() OR public.is_trainer());
create policy "profiles_read"  on profiles  for select using (id      = auth.uid() OR public.is_trainer());

-- Writes: owner only.
create policy "plans_write"     on plans     for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "sessions_write"  on sessions  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "metrics_write"   on metrics   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "favorites_write" on favorites for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profiles_write"  on profiles  for update using (id    = auth.uid()) with check (id    = auth.uid());
```

`is_trainer()` is `security definer` to avoid recursive RLS on the `profiles` lookup. Admin flips `is_trainer` via the Supabase dashboard, which bypasses RLS.

**Forward-compatibility note**: when spec #2 introduces trainer-assigns-plan, the trainer needs to write a row where `user_id ≠ auth.uid()`. That will be added as a `security definer` RPC (`assign_plan(...)`) that checks `is_trainer` server-side. Not built in this spec.

**Trainer-name visibility for members**: handled via the `public.trainer_names` view defined above. Members can join `plans.assigned_by → trainer_names.id` to display "Assigned by trainer Bob" without reading the full trainer profile. Created now so spec #2 needs no schema migration.

### Dexie schema (v4)

```ts
this.version(4).stores({
  plans:          'id, userId, weekStart, updatedAt',
  sessions:       'id, userId, planId, date, updatedAt',
  metrics:        'id, userId, date, updatedAt',
  favorites:      '[userId+exerciseId], userId, addedAt',
  syncQueue:      '++seq, table, rowId',
  syncDeadLetter: '++seq, table, rowId',
  syncMeta:       'key',
}).upgrade(async (tx) => {
  await tx.table('plans').clear();
  await tx.table('sessions').clear();
  await tx.table('metrics').clear();
  await tx.table('favorites').clear();
});
```

TypeScript interfaces gain three fields on every owned row:

- `id: string` (UUID, was `number` auto-increment)
- `userId: string` (always the owner — Dexie still only ever holds current-user data)
- `updatedAt: number` (local `Date.now()` of last local edit; used for in-app sorting only)
- `serverVersion: string | null` (the server's `updated_at` ISO string when this row was last pulled, or `null` if never synced — used for optimistic-concurrency on push, see §5)

`putWithSync()` and `deleteWithSync()` fill `id`, `userId`, and `updatedAt` automatically so call sites don't have to.

The `syncDeadLetter` table holds queue rows that have permanently failed (see §5 "Push worker — dead letter").

## 5. Sync layer

### Sync queue

```ts
interface SyncQueueRow {
  seq?: number;
  table: 'plans' | 'sessions' | 'metrics' | 'favorites';
  rowId: string;                    // canonical encoding — see below
  op: 'insert' | 'update' | 'delete';
  expectedServerVersion: string | null;  // captured at enqueue time; drives optimistic concurrency
  attempts: number;
  lastError?: string;
  lastErrorStatus?: number;
  queuedAt: number;
}
```

**`rowId` canonical encoding**:

- `plans`, `sessions`, `metrics` → the row's UUID string.
- `favorites` → `${userId}:${exerciseId}`. Both halves are well-formed and neither contains `:` (UUIDs and exercise IDs from the bundled catalog are alphanumeric/hyphenated), so the format is unambiguous. A `parseFavoriteRowId(rowId)` helper lives next to `putWithSync`. Tests assert the encoding.

Every write goes through one of two helpers that mutate Dexie AND enqueue a sync entry in the same Dexie transaction. So a queue row can never get lost relative to its data.

```ts
async function putWithSync(table, partialRow, meta) {
  await db.transaction('rw', table, db.syncQueue, async () => {
    const existing = await table.get(partialRow.id);
    const row = { ...partialRow, userId, updatedAt: Date.now(),
                  serverVersion: existing?.serverVersion ?? null };
    await table.put(row);
    await db.syncQueue.add({
      table: meta.table, rowId: meta.rowId(row),
      op: existing ? 'update' : 'insert',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
    });
  });
}

async function deleteWithSync(table, rowId, meta) {
  await db.transaction('rw', table, db.syncQueue, async () => {
    const existing = await table.get(rowId);
    await table.delete(rowId);
    await db.syncQueue.add({
      table: meta.table, rowId: meta.rowIdOf(existing ?? { id: rowId }),
      op: 'delete',
      expectedServerVersion: existing?.serverVersion ?? null,
      attempts: 0, queuedAt: Date.now(),
    });
  });
}
```

`expectedServerVersion` is the value the **server** last reported (or `null` if the row was created locally and has never been pushed). The push worker uses it for optimistic concurrency.

### Tombstones

Deletes set `deleted_at = now()` server-side. Clients receive these via pull and remove the local row. Hard cleanup on the server is deferred (or never — these tables stay small).

### Push worker

**Triggers**: enqueue, `online` event, `visibilitychange`, 30 s heartbeat while open + online, and an explicit `flushNow()` method on the sync orchestrator (used by tests and by the "Sync is stuck" banner's manual-retry button).

**Ordering**: the invariant is **per-(table, rowId) FIFO**, not global FIFO. The worker scans the queue in `seq` order but only blocks behind earlier entries that share `(table, rowId)`. Different rows can advance independently. This matters once we have a dead letter (below) — one bad row must not freeze the whole queue.

**Per-op behavior**:

| `op` | Request |
|---|---|
| `insert` | `INSERT` (Supabase `.insert(row)`). PK uniqueness guarantees safety; no conditional needed. |
| `update` | `UPDATE ... WHERE id = $id AND updated_at = $expectedServerVersion` (Supabase `.update(row).eq('id', id).eq('updated_at', expectedServerVersion)`). Returns the updated row via `.select()` so we capture the new `updated_at`. |
| `delete` | `UPDATE ... SET deleted_at = now() WHERE id = $id AND updated_at = $expectedServerVersion`. Returns the row. |

**Success** (HTTP 2xx with rows returned):
- Read the new `updated_at` from the response and write it to the local row's `serverVersion`.
- Delete the queue row.

**Conflict** (HTTP 2xx with empty result — the WHERE didn't match): another writer (or the same user from another device) bumped `updated_at` since we last pulled. Trigger a **pull-and-replay** for this row:
1. Fetch the row from Supabase by id.
2. **If queue still has this row's local copy unmodified** since the conflict was detected, treat the server's row as the new baseline: update `serverVersion` on the local row to the freshly-pulled value, keep the local *data* (the user's local edit), and re-queue the push with the new `expectedServerVersion`.
3. If repeated 3 conflicts on the same queue row → dead-letter (the row is stuck in a write-write race or there's a bug).

This is **last-writer-wins**, but explicitly so. The push is no longer a blind "clobber whatever was there"; it's a "I expected to see version T1; if you have T2, I'll pull T2 and try again to overwrite it with my edit."

**Network failure / 5xx**: increment `attempts`, store `lastError`, exponential backoff (1 s → 2 s → 4 s … cap 5 min). Silent.

**401 / 403**: do **not** sign out on a single response. Tell Supabase JS to refresh the session (`auth.refreshSession()`), then retry once. If the refresh succeeds, we continue normally. If the refresh fails *or* if Supabase JS independently fires `onAuthStateChange('SIGNED_OUT')`, *that* is what triggers sign-out + Dexie wipe. A single transient 401 mid-set never destroys an in-progress workout.

**4xx other than 401/403/409** (constraint violation, validation error): treat as poisoned for this row — `attempts` increments, but after 3 attempts the queue row is **moved to `syncDeadLetter`** and the worker advances past it. A persistent banner appears ("N changes couldn't sync — review") that opens a small UI listing dead-lettered rows with their `lastError` and the option to retry or discard.

**HTTP 409** (uniqueness / FK violation): same as the previous bullet. Almost always a bug; dead-letter after 3 retries.

**≥ 10 attempts** on a queue row that's still in `syncQueue` (i.e., network or 5xx loop, not a poisoned 4xx): show the same persistent banner; tapping it forces a `flushNow()`.

### Pull worker

**Triggers**: login, `visibilitychange`, `online`, 60 s heartbeat, and `flushNow()`.

**Query** (per owned table):

```sql
select * from <table>
where (updated_at, id) > ($last_pulled_at, $last_pulled_id)
  and user_id = auth.uid()       -- defense-in-depth; RLS already enforces this
order by updated_at asc, id asc
limit 500;
```

The keyset `(updated_at, id) > ($last_pulled_at, $last_pulled_id)` avoids the same-millisecond-tie loss that a strict `> $last_pulled_at` would cause under load (e.g., backfill or a trainer's batch import in spec #2). The `user_id = auth.uid()` clause is *not* security-load-bearing — RLS already enforces it — but it makes intent explicit and keeps query plans tight.

If the result hits the 500-row `limit`, page until the response is shorter than `limit`. Update `(lastPulledAt, lastPulledId)` in `syncMeta` after each successful page.

**Merge** (per row):

- **If the row has a pending entry in `syncQueue`** → keep local data. Do NOT update `serverVersion` yet — the push will reconcile via the optimistic-concurrency path. (Updating `serverVersion` here would make the next push think it had the latest, and we'd silently overwrite the other device's edit.)
- **Else if `deleted_at != null`** → delete local row.
- **Else** → overwrite local with server, and set `serverVersion = server.updated_at`.

### Profile sync

Profile is in-memory only (no Dexie cache for the row; a `lastKnownProfile` is held in localStorage for the offline-bootstrap case). Refetched on every app foreground. When `is_trainer` flips, the UI re-renders.

Profile *edits* (changing `display_name` from `<Settings />`) are **online-only**: the Settings form is disabled when `navigator.onLine === false` and shows "Display name can't be edited offline." Rationale: this field is rarely touched, queuing it adds another sync path, and the trade-off cost is one disabled input in one rarely-visited screen.

### Bootstrap sequence

1. Read Supabase session from local storage.
2. No session → render `<Login />`. Stop.
3. Session present:
   1. Fetch profile (one network query).
   2. Start push + pull workers.
   3. Mount app routes.
4. If profile fetch fails because offline:
   - If `lastKnownProfile` exists in localStorage, render app marked "stale", refetch on next foreground/online.
   - Otherwise (no cache, no network) block with "Connect to finish setup" screen. Only happens on first-ever login.

### Conflict resolution — summary

The combination of (a) optimistic-concurrency push and (b) "pending-queue → keep local on pull" delivers a coherent last-writer-wins where the *last* writer is the one whose push lands at the server most recently — never the one whose local clock happens to be later. Trainers in spec #2 (who will write to other members' rows via an `assign_plan` RPC) inherit the same guarantee for free: their write will conditionally check `updated_at`, and if the member edited since the trainer pulled, the trainer's push will conflict and resync rather than silently overwrite.

## 6. Auth flow + UI

### Magic-link flow

1. `<Login />` collects email.
2. `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: <app-url> } })`.
3. Show "Check your email at …" screen. No countdown.
4. User taps link → browser opens app URL with token.
5. Supabase JS exchanges for a session and persists in localStorage. URL fragment is stripped.
6. `AuthProvider` detects new session → bootstrap (§5).

**One-time annoyance**: a magic-link tap may land in the OS's default browser rather than the installed PWA. Subsequent sessions persist in the PWA's storage so this only bites the first login on a given device.

### New files

```
src/
├── supabase.ts                # createClient(URL, ANON_KEY)
├── auth/
│   ├── AuthProvider.tsx       # context + session state
│   ├── useAuth.ts             # hook
│   └── Login.tsx              # magic-link page
├── sync/
│   ├── index.ts               # orchestrator: start/stop, flushNow()
│   ├── pushWorker.ts          # per-(table, rowId) FIFO, optimistic CC, dead-letter
│   ├── pullWorker.ts          # keyset-paginated pull
│   ├── putWithSync.ts         # write helpers + rowId encoders
│   ├── deadLetter.ts          # dead-letter list view & retry/discard
│   ├── mapping.ts             # snake_case ↔ camelCase
│   └── syncMeta.ts            # (lastPulledAt, lastPulledId) per table
└── pages/
    └── Settings.tsx           # sign-out, display name edit
```

### `useAuth` shape

```ts
type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: { id: string; email: string } | null;
  profile: { id: string; displayName: string; isTrainer: boolean } | null;
  signOut(): Promise<void>;
}
```

`isTrainer` derived as `profile?.isTrainer ?? false`. Single source of truth for role-aware UI in spec #2.

### Route guard

One guard in `App.tsx`:

```tsx
function Guarded({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Splash />;
  if (status === 'unauthenticated') return <Login />;
  return <>{children}</>;
}
```

No per-route guards. Existing pages don't change.

### Login page

Minimal, single screen. No "sign up" link — admin provisions accounts. After submission, a confirmation screen with "try a different email" escape hatch.

### Settings page

Reached via a gear icon in the header (next to language switcher). Lets the user edit `display_name` and sign out.

- **Display name edit**: writes go directly to Supabase via `update profiles set display_name = ... where id = auth.uid()`. The input is disabled when `navigator.onLine === false`, with a helper text "Connect to edit". Rationale in §5 "Profile sync".
- **Sign out**: clears Supabase session, wipes Dexie, navigates to `/`. The login screen mounts.

### Session persistence

Supabase JS uses localStorage. Refresh-token TTL bumped to ~1 year in the dashboard so members rarely log out. Offline: cached session is used as-is; refresh deferred until online.

### Environment variables

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

`.env.local` for dev (gitignored). Netlify env vars for prod. The anon key is shipped to the client; RLS protects the data.

## 7. Error handling

Principle: **never block a workout for an error that can wait**. Silent retry is default. Surface errors only when the user must act.

### Auth

| Situation | Behavior |
|---|---|
| Magic-link request fails (network) | Inline form error: "Couldn't send the link." Resubmit to retry. |
| Email not in `auth.users` | Supabase returns success either way (anti-enumeration). User sees "check your email" with no follow-up. Admin can verify provisioning. (Dashboard config that gates this — see §10.) |
| Magic-link redirect with expired token | Show login with "That link expired. Send a new one." |
| Single 401/403 on a sync call | Trigger `auth.refreshSession()` and retry once. **Do not** sign out. |
| `onAuthStateChange('SIGNED_OUT')` fires | The authoritative signal — Supabase JS gave up on the session. Wipe Dexie, show login. |
| Profile fetch fails on bootstrap | Use `lastKnownProfile` if present; else show "Connect to finish setup" (first login only). |

### Sync push

| Situation | Behavior |
|---|---|
| Network failure / 5xx | Backoff + retry on the whole queue. Silent. |
| Single 401/403 | Refresh token, retry once. Sign-out only on `SIGNED_OUT` event. |
| Conflict (empty result on conditional update) | Pull row, replay with new `expectedServerVersion`. Repeat ≤ 3 times. |
| 4xx other (400, 422, etc.) / 409 / repeated conflict | Move row to `syncDeadLetter` after 3 attempts. Queue advances. Banner: "N changes couldn't sync — review". |
| ≥ 10 attempts on a row still in `syncQueue` (network loop) | Persistent banner; tap to `flushNow()`. |

### Sync pull

Silent. Log and retry on next heartbeat. After 5 consecutive failures, a "Last synced X ago" indicator turns yellow. No modal.

### Schema / data validation

Mapping layer ignores unknown inbound fields (forward-compatible). Required outbound fields are validated; missing fields throw with a clear error log.

### Time skew

`updated_at` always comes from the server (trigger). Local `updatedAt` uses `Date.now()`. A bad client clock causes at most a one-row "wrong-side" conflict that self-heals on next edit. Not worth mitigating.

### Storage exhaustion

IndexedDB quota errors are caught in the write helper → toast: "Out of storage. Free up space and try again." The sync queue retains any pending writes that did succeed.

### UI surface

A single global toast component in `App.tsx`. One message at a time, manual dismiss. No notification centre.

## 8. Testing strategy

Existing stack (Vitest + RTL + jsdom + fake-indexeddb) covers it. No new test dependencies.

### Mocking

A hand-rolled in-memory fake of the Supabase client (`src/test/fakeSupabase.ts`) implementing only the methods we call: `auth.signInWithOtp`, `auth.getSession`, `auth.onAuthStateChange`, `auth.signOut`, and `from(table).select/insert/update/upsert/delete`. Supports `user_id` filtering equivalent to RLS, and a "network failure" toggle. Deterministic; no real-network flakiness.

### Unit tests (new)

| File | Coverage |
|---|---|
| `mapping.test.ts` | snake/camel round-trip; unknown fields ignored inbound; required fields enforced outbound |
| `syncQueue.test.ts` | enqueue/dequeue order, attempts increment, backoff math, "stuck" threshold |
| `pushWorker.test.ts` | happy push; network failure retries; 401 → signOut; 409 poisoned after 3 |
| `pullWorker.test.ts` | merges newer rows; ignores older-than-local; tombstones delete local; `lastPulledAt` persisted per table |
| `auth.test.tsx` | unauthenticated → `<Login />`; magic-link callback → authenticated; signOut → wipe + return to `<Login />` |

### Integration test (the load-bearing one)

`src/test/sync-roundtrip.test.tsx`:

1. Sign in (fake Supabase).
2. Build a plan via the existing workflow UI.
3. Assert: Dexie has the plan with `serverVersion === null`; sync queue has one entry with `op: 'insert'`.
4. Run push once (`flushNow()`).
5. Assert: fake Supabase has the plan; Dexie's `serverVersion` now equals fake Supabase's `updated_at`; sync queue empty.
6. Mutate same row directly in fake Supabase (simulate other device).
7. Run pull once.
8. Assert: Dexie reflects the remote change and `serverVersion` advanced.
9. **Conflict path**: edit the row locally (now Dexie has a new pending queue entry with `expectedServerVersion = T2`). Before pushing, directly mutate fake Supabase again to `T3`. Run push. Assert: the first attempt comes back with an empty result; the orchestrator pulls `T3`, updates `expectedServerVersion` on the queue row, re-pushes; final state is the local data on the server with `updated_at = T4`. Dexie's `serverVersion = T4`.
10. Delete via UI.
11. Push, then assert fake Supabase has `deleted_at != null` and Dexie no longer has the row.

If this stays green, the foundation works.

### Existing tests — explicit update list

The schema change is breaking. The "Dexie only holds current-user data" simplification preserves **query** structure but not **type** structure. The implementer must update:

- `src/test/db.test.ts` — bump the `verno` assertion to `4`; add the new required fields (`id`, `userId`, `updatedAt`, `serverVersion`) to the raw `db.plans.add({...})` test data; assert new indexes (`syncQueue`, `syncDeadLetter`, `syncMeta`).
- `src/test/workflow.test.tsx` — wrap test setup with `stubAuthenticatedUser` (see helper below); if it asserts on plan IDs being numeric, switch to UUID-shaped strings.
- `src/pages/PlanEditor.tsx` — `Number(id)` on line ~25 becomes `id` (string passthrough). The route param is already `string | undefined`.
- Any other call site that does `Number(plan.id)` or treats IDs as numeric.

One new helper in `src/test/setup.ts`:

```ts
beforeEach(() => stubAuthenticatedUser({ id: 'u-test', isTrainer: false }));
```

`stubAuthenticatedUser` mounts the fake Supabase session so `<Guarded>` lets the app render. It does **not** retrofit data — that's why the existing tests' `db.plans.add({...})` calls have to be updated to include the new required fields.

### Out of scope for automated tests

- Real Supabase. Manual smoke test against a dev project before merge.
- Beyond-basic network failure modes. Trust Supabase JS.
- Multi-tab same-user races. Add `BroadcastChannel` coordinator later if it bites.
- Service worker background sync.

### Manual smoke test before merge

1. Admin creates two users in dashboard (`is_trainer = true` and `false`).
2. Both sign in via magic link.
3. Member logs a plan + session + metric — appears in Supabase tables.
4. Member logs out, signs in on second device — data appears.
5. Airplane mode: log a set, fly back online → syncs.
6. From trainer's client in Supabase Studio: can `select` member rows. From member's client (browser console): direct `select` of other members' rows is blocked.

## 9. What this spec does not cover

Deferred to future specs:

- **Spec #2 — Trainer dashboard**: trainer UI to view members, assign plans (`assign_plan` RPC), edit the exercise library, equipment photos, dropdown notes.
- **Spec #3 — Selfie capture**: camera capture on metric entry, image storage in Supabase Storage, gallery view.
- **Other deferred items**: realtime subscriptions; multi-tab coordination; service-worker background sync; soft-delete cleanup; multi-gym tenancy; admin UI inside the app; password authentication; SSO.

## 10. Open items for spec author / implementer

- Confirm Supabase project URL + anon key environment variable names match Netlify configuration (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
- Decide refresh-token TTL value at provisioning time (recommended: 1 year).
- Decide email template wording for the magic link (Supabase default is fine for v1).
- **Dashboard config (Auth → Providers → Email)**: disable public signup so no one can sign up without admin creating the `auth.users` row. Verify the OTP response is uniform regardless of whether the email exists (anti-enumeration).
- **Dashboard config (Auth → URL Configuration)**: add the production app URL and the local dev URL to "Additional Redirect URLs" so `emailRedirectTo` is accepted. Without this, magic links 404.
- **Dashboard config (Database → Replication)**: realtime is *not* needed in this spec; can stay disabled.
