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
| Conflict resolution | Last-write-wins by `updated_at`. Single writer per row in practice. |
| PWA | Stays a PWA. Service worker, manifest, install-to-home-screen all unchanged. |

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│  React UI  (pages/, components/)                │  unchanged
├─────────────────────────────────────────────────┤
│  Hooks  (useAuth NEW, useExercises, useFavorites)│  +1 hook
├─────────────────────────────────────────────────┤
│  Dexie  (local source of truth for reads)       │  +userId, +updatedAt
├─────────────────────────────────────────────────┤
│  Sync layer  src/sync/   ←  NEW                 │
│   • pushQueue: outbound writes                  │
│   • pull: inbound merge                         │
│   • mapping: snake_case ↔ camelCase             │
├─────────────────────────────────────────────────┤
│  Supabase JS client  (auth + Postgres + RLS)    │  NEW
└─────────────────────────────────────────────────┘
```

Reading direction: **always Dexie**. Reads never wait on the network.
Writing direction: write Dexie → enqueue sync row → background push to Supabase.
Trainer reads of *other* members' data in spec #2 will bypass Dexie and read Supabase directly. Dexie always and only contains the current user's own data.

### Key simplification

Dexie holds **only the current user's data, ever**. On login we pull the user's rows. On logout (or user switch) we wipe Dexie. This means existing pages' Dexie queries need zero modification — they remain naturally scoped to "me" because that's all Dexie contains.

## 4. Data model

### Supabase Postgres schema

```sql
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text         not null,
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
  values (NEW.id, coalesce(NEW.raw_user_meta_data->>'display_name', NEW.email), false);
  return NEW;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Admin sets `is_trainer = true` afterwards via the dashboard. `display_name` is editable by the user in `<Settings />`.

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

**Forward-compatibility note**: with strict profile reads, a member viewing "assigned by trainer Bob" cannot read Bob's profile. Spec #2 will denormalise `assigned_by_name` onto the plan row or expose a small public view of trainer names.

### Dexie schema (v4)

```ts
this.version(4).stores({
  plans:     'id, userId, weekStart, updatedAt',
  sessions:  'id, userId, planId, date, updatedAt',
  metrics:   'id, userId, date, updatedAt',
  favorites: '[userId+exerciseId], userId, addedAt',
  syncQueue: '++seq, table, rowId, op, attempts',
  syncMeta:  'key',
}).upgrade(async (tx) => {
  await tx.table('plans').clear();
  await tx.table('sessions').clear();
  await tx.table('metrics').clear();
  await tx.table('favorites').clear();
});
```

TypeScript interfaces gain `id: string`, `userId: string`, `updatedAt: number`. A `putWithSync()` helper hides the boilerplate at write sites.

## 5. Sync layer

### Sync queue

```ts
interface SyncQueueRow {
  seq?: number;
  table: 'plans' | 'sessions' | 'metrics' | 'favorites';
  rowId: string;             // UUID, or 'userId:exerciseId' for favorites
  op: 'upsert' | 'delete';
  attempts: number;
  lastError?: string;
  queuedAt: number;
}
```

Every write goes through one of two helpers that mutate Dexie AND enqueue a sync entry in the same transaction. So a queue row can never get lost relative to its data.

```ts
async function putWithSync(table, row, meta) {
  await db.transaction('rw', table, db.syncQueue, async () => {
    await table.put(row);
    await db.syncQueue.add({ table: meta.table, rowId: row.id, op: 'upsert', attempts: 0, queuedAt: Date.now() });
  });
}

async function deleteWithSync(table, rowId, meta) {
  await db.transaction('rw', table, db.syncQueue, async () => {
    await table.delete(rowId);
    await db.syncQueue.add({ table: meta.table, rowId, op: 'delete', attempts: 0, queuedAt: Date.now() });
  });
}
```

The push worker translates `op: 'delete'` into an `update` that sets `deleted_at = now()` on the server (the trigger then bumps `updated_at`).

### Tombstones

Deletes set `deleted_at = now()` server-side. Clients receive these via pull and remove the local row. Hard cleanup on the server is deferred (or never — these tables stay small).

### Push worker

- Triggers: enqueue, `online` event, `visibilitychange`, 30 s heartbeat while open + online.
- Processes queue in `seq` order, one at a time. No concurrency on same row.
- Success → delete queue row.
- Failure → increment `attempts`, store `lastError`, exponential backoff (1 s → 2 s → 4 s … cap 5 min).
- 401 / 403 → assume token is dead, sign out, wipe Dexie, show login.
- 409 / constraint violation → poisoned after 3 attempts; log and surface a toast to flag it for debug.
- ≥ 10 attempts on the same row → persistent "Sync is stuck" banner with manual flush.

### Pull worker

- Triggers: login, `visibilitychange`, `online`, 60 s heartbeat.
- For each owned table: `select * where updated_at > $last_pulled_at AND user_id = auth.uid()`.
- Merge into Dexie per row:
  - **If the row has a pending entry in `syncQueue`** → keep local. Our queued write will overwrite the server shortly; pulling the server's older state into Dexie now would cause a brief flicker. The queue is the authoritative "I have unpushed changes" signal, not the timestamp.
  - **Else if `deleted_at != null`** → delete local row.
  - **Else** → overwrite local with server.
- Save new `lastPulledAt` per table to `syncMeta`.

### Profile sync

Profile is in-memory only (no Dexie cache for the row; a `lastKnownProfile` is held in localStorage for the offline-bootstrap case). Refetched on every app foreground. When `is_trainer` flips, the UI re-renders.

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

### Conflict resolution

Single writer per row in practice. The only conflict path is **same user on two devices**. The server's `updated_at` (set by trigger at write time) is authoritative — whichever device's push lands at the server later wins. The pull rule above (queue presence → keep local; else server wins) is consistent with this: locally pending changes will overwrite the server on their next push, and any client without pending changes will always converge to the server's latest value. Acceptable for this app — sessions are mostly write-once, metrics daily, plans rare.

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
│   ├── index.ts               # orchestrator (start/stop)
│   ├── pushWorker.ts
│   ├── pullWorker.ts
│   ├── putWithSync.ts         # write helper
│   ├── mapping.ts             # snake_case ↔ camelCase
│   └── syncMeta.ts            # lastPulledAt persistence
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

Reached via a gear icon in the header (next to language switcher). Lets the user edit `display_name` and sign out. Sign-out clears Supabase session, wipes Dexie, navigates to `/`.

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
| Email not in `auth.users` | Supabase returns success either way (anti-enumeration). User sees "check your email" with no follow-up. Admin can verify provisioning. |
| Magic-link redirect with expired token | Show login with "That link expired. Send a new one." |
| Refresh token expires mid-session | `onAuthStateChange('SIGNED_OUT')` → wipe Dexie → show login. |
| Profile fetch fails on bootstrap | Use `lastKnownProfile` if present; else show "Connect to finish setup" (first login only). |

### Sync push

| Situation | Behavior |
|---|---|
| Network failure | Backoff + retry. Silent. |
| 401 / 403 | Sign out. Wipe Dexie. Show login. |
| 409 / constraint | Poisoned after 3 attempts. Toast for debug. |
| 5xx | Same as network failure. |
| ≥ 10 attempts | Persistent "Sync is stuck" banner; tap to force flush. |

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
3. Assert: Dexie has the plan; sync queue has one entry.
4. Run push once.
5. Assert: fake Supabase has the plan; sync queue empty.
6. Mutate same row directly in fake Supabase (simulate other device).
7. Run pull once.
8. Assert: Dexie reflects the remote change.
9. Delete via UI.
10. Push, then assert fake Supabase has `deleted_at != null` and Dexie no longer has the row.

If this stays green, the foundation works.

### Existing tests

All must keep passing without modification. The "Dexie only holds current-user data" simplification is verified by this constraint. One helper in `src/test/setup.ts`:

```ts
beforeEach(() => stubAuthenticatedUser({ id: 'u-test', isTrainer: false }));
```

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

- Confirm Supabase project URL + anon key environment variable names match Netlify configuration.
- Decide refresh-token TTL value at provisioning time (recommended: 1 year).
- Decide email template wording for the magic link (Supabase default is fine for v1).
