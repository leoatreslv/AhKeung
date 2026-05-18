# Trainer-owned custom exercises with sharing

**Status:** revised 2026-05-18 after independent review, ready to implement
**Scope:** replaces the free-exercise-db catalogue with a trainer-authored
exercise library, adds explicit sharing to trainees, and introduces a
trainer↔trainee designation relationship with a lightweight consent step.

> **Revision note.** This revision folds in all 4 blocking and 7 should-fix
> findings from the independent review section below. See the resolution log
> at the bottom for a per-finding trace from review item → PR.

## Background

The app currently ships an 873-entry catalogue from
[free-exercise-db](https://github.com/yuhonas/free-exercise-db) referenced by
stable string slugs (e.g. `Barbell_Squat`). The auth & sync foundation
(Supabase + RLS + push/pull workers) is in place. The schema anticipates a
trainer relationship: `profiles.is_trainer`, the `trainer_names` view, and
`plans.assigned_by`. Read RLS lets any trainer see every user's owned rows.

## Goals

- Trainers author their own exercises (bilingual, optional image).
- Trainers explicitly share **exercises**, **named bundles**, or **whole
  plans** to specific trainees they have designated.
- A trainer "picks" a trainee, putting the pair into a pending state; the
  trainee accepts (or declines) before any share is visible.
- Free-exercise-db is removed entirely (the app is pre-launch).
- Camera capture for exercise images on phone.
- Optional one-click Google Translate to fill the other-language name,
  routed through a server-side Edge Function (key never ships to the client).

## Non-goals

- Email-based trainee invitations (v1 picks from `profiles`).
- Propagation of trainer plan edits to trainees. Trainer workflow is
  "edit → Save as new plan → re-share"; cloned plans are independent rows
  on the trainee side. `superseded_by` on `plans` marks the previous copy.
- Per-exercise language overlay strings in i18n. Names live in the data.
- Tightening trainer read scope on sessions/metrics/favorites — trainers
  retain global read on those, as today.

## Data model

### New Supabase tables (migration `0002_custom_exercises.sql`)

```sql
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
  -- at least one name required; trainer can fill the other later
  check (name_en is not null or name_zh is not null)
);
create index exercises_owner          on exercises(owner_id) where deleted_at is null;
create index exercises_owner_updated  on exercises(owner_id, updated_at);

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
```

All new tables get the existing `touch_updated_at` trigger so optimistic
concurrency in the push worker has a column to check.

### Normalized join table for plan exercises

```sql
create table plan_exercises (
  plan_id     uuid not null references plans(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete restrict,
  position    int  not null,
  primary key (plan_id, exercise_id, position)
);
create index plan_exercises_exercise on plan_exercises(exercise_id);

-- Trigger: re-derive plan_exercises from plans.exercises::jsonb on every
-- write. The denormalized JSON column stays as the client-friendly shape;
-- the join table exists purely so RLS and access checks can use a real
-- index. Trigger code in the migration.
```

The `plans.exercises` JSON column keeps its current shape (the client
already serialises it that way); the join table is a server-side derived
projection that RLS uses. Resolves B1 (no more jsonb containment with
`::text`) and B2 (a real btree index for the exercise→plans lookup).

### Modified existing tables

- `plans.exercises` JSON: each `exerciseId` becomes a UUID referencing
  `exercises(id)` (was a free-exercise-db slug).
- `plans` gains `superseded_by uuid references plans(id) on delete set
  null` so the trainee can see which assigned plan from a trainer is
  current. (S7)
- `sessions.exercises[].exerciseId`: UUID instead of slug.
- `favorites`: composite PK becomes `(user_id, exercise_id)` referencing
  `exercises(id)`.

Pre-launch, the Dexie v4 → v5 upgrade wipes; the SQL migration drops and
recreates affected columns in one transaction.

### RLS

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `exercises` | owner OR direct exercise share OR via bundle share | owner only |
| `exercise_bundles` | owner OR bundle share recipient | owner only |
| `exercise_bundle_items` | parent-bundle SELECT | parent-bundle owner |
| `shares` | granter OR recipient | granter only |
| `trainer_trainees` | trainer or trainee on the row | trainer inserts; trainee updates `status`/`responded_at` only |
| `plans` | unchanged | unchanged |

`exercises_read` is now two `EXISTS` branches, not three, and both join
against indexed columns:

```sql
create policy exercises_read on exercises for select using (
  owner_id = auth.uid()
  or exists (
    select 1 from shares s
    where s.recipient_id = auth.uid()
      and s.deleted_at is null
      and s.resource_type = 'exercise'
      and s.resource_id = exercises.id
  )
  or exists (
    select 1 from shares s
    join exercise_bundle_items i on i.bundle_id = s.resource_id
    where s.recipient_id = auth.uid()
      and s.deleted_at is null
      and s.resource_type = 'bundle'
      and i.exercise_id = exercises.id
  )
);
```

The "via plan share" branch is gone: plan-share now emits explicit
exercise share rows (see Sharing semantics), so this policy doesn't need
to traverse `plans.exercises`. The normalized `plan_exercises` join table
exists for future RLS use (e.g. analytics) and for the alternative path
described in the resolution log under S6.

`trainer_trainees` is enforced with a `WITH CHECK` that
`trainer_id = auth.uid()` on insert, and a separate update policy that
only lets the trainee modify `status` and `responded_at`:

```sql
create policy trainer_trainees_insert on trainer_trainees
  for insert with check (trainer_id = auth.uid());
create policy trainer_trainees_trainee_respond on trainer_trainees
  for update using (trainee_id = auth.uid())
  with check (trainee_id = auth.uid());
```

### Storage

Bucket `exercise-images`, public read. Write policy: authenticated users
may upload only into `{auth.uid()}/...`. Path convention
`{owner_id}/{uuid}.jpg`. Files are JPEG after client-side resize to a
1024 px long edge.

### Dexie v5

```
exercises:           id, ownerId, muscleGroup, updatedAt, deletedAt
exerciseBundles:     id, ownerId, updatedAt, deletedAt
exerciseBundleItems: [bundleId+exerciseId], bundleId, exerciseId, updatedAt
shares:              id, recipientId, [resourceType+resourceId], updatedAt, deletedAt
trainerTrainees:     [trainerId+traineeId], trainerId, traineeId, status, updatedAt
planExercises:       [planId+exerciseId], planId, exerciseId   -- read-only cache, populated from pull
```

v4 → v5 upgrade: wipe (pre-launch).

## Sync layer refactor (new PR 0)

`pullWorker.ts` today hard-codes `.eq('user_id', userId)` and the
`putWithSync` discriminated union has a custom favorites branch hand-rolled
into it. The new tables break both assumptions: `shares` is keyed by
`recipient_id`, `trainer_trainees` by `trainer_id` or `trainee_id`,
`exercise_bundle_items` has no owner column at all, and several tables
must store rows the local user does not own. Resolves B3 and B4.

**Approach: per-table descriptor.** Each synced table has a static
descriptor:

```ts
type TableDescriptor<Row> = {
  table: string;            // server table name (snake_case)
  dexieTable: keyof DB;     // Dexie table name (camelCase)
  primaryKey:
    | { kind: 'single'; field: keyof Row }
    | { kind: 'composite'; fields: [keyof Row, keyof Row] };
  /** Server-side predicate the pull worker applies (in addition to RLS). */
  pullPredicate:
    | { kind: 'owner'; ownerField: 'user_id' | 'owner_id' | 'granter_id' | 'trainer_id' }
    | { kind: 'recipient'; field: 'recipient_id' | 'trainee_id' }
    | { kind: 'rls-only' }; // server filters via RLS; client sends no extra predicate
  /** Whether the local user is allowed to mutate rows in this table.
   *  'own-only' (most), 'never' (shared-in, planExercises). */
  writability: 'own-only' | 'never';
  ownerField?: keyof Row;   // for the 'own-only' check at write time
};
```

Pull worker iterates descriptors, building keyset-paginated queries per
table. Push worker (and `putWithSync`/`deleteWithSync`) consults the
`writability` and `ownerField` fields: shared-in rows are read-only,
attempts to mutate return immediately without enqueuing. Resolves S5.

The mapping layer (snake_case ↔ camelCase) stays. Tests now cover each
descriptor branch (B3-specific regression test: a recipient successfully
pulls a `shares` row).

## Sharing semantics

Three resource types, two semantic models — and one extra emission:

- **Exercises and bundles** — share = grant read. A row in `shares` is
  created; RLS gives the recipient SELECT on the resource. Soft-delete
  on the share row revokes access on the next pull. (Pull worker
  honours `deleted_at`, resolves O18.)
- **Plans** — share = clone + emit exercise grants. In a single
  transaction:
  1. Clone the plan into the trainee's `plans` with `assigned_by =
     trainer.id`. If the trainee already has an assigned plan from this
     trainer (`assigned_by = me` AND `superseded_by is null`), the new
     clone gets `superseded_by = old_id` and the old one becomes
     non-current.
  2. For each `exerciseId` in the cloned plan, upsert a `shares` row
     with `resource_type = 'exercise'`, `recipient_id = trainee.id`,
     so the trainee retains exercise visibility regardless of plan
     edits. (Resolves S6.)

  Done as a Postgres RPC (`share_plan(plan_id uuid, recipient_id uuid)`)
  to keep the multi-row write atomic. Client calls via Supabase client.

### Designation and consent (S9)

Trainer designates a trainee → `trainer_trainees` row with
`status = 'pending'`. The trainee sees a banner on Home asking to
accept/decline; status flips to `accepted` or `declined` (RLS lets only
the trainee write that column). Until `accepted`, shares from this
trainer to this trainee are filtered out:

```sql
-- In every shares-derived view/policy: require an accepted designation
exists (
  select 1 from trainer_trainees t
  where t.trainer_id = shares.granter_id
    and t.trainee_id = shares.recipient_id
    and t.status = 'accepted'
)
```

This is enforced inside `exercises_read`, `exercise_bundles_read`, the
share-plan RPC, and the assigned-plans view. A `declined` row blocks
all future shares from that trainer; the trainer can delete and retry
(creates a new `pending` row, which the trainee can decline again).

A trainee-side "Block this trainer" affordance writes `status =
'declined'` and is sticky — the trainer can still see the row exists
(so the UI can label them "declined") but cannot re-share.

## Google Translate via Edge Function (S10)

The Translate API key never ships to the client. Architecture:

- Supabase Edge Function `translate-name` (in `supabase/functions/`).
- Function reads `GOOGLE_TRANSLATE_API_KEY` from its own env (Supabase
  Function secret, not `VITE_*`).
- Authenticates the caller via the standard Supabase JWT verification
  (the function template does this by default).
- Body: `{ q, source, target }`. Returns `{ translatedText }` or an
  error. Rate-limits per `auth.uid()` (simple Redis-less counter using
  Postgres `rate_limits` table — out of scope for v1, just log usage).
- Client (`useTranslate()` hook) calls
  `supabase.functions.invoke('translate-name', { body: {...} })`.

Resolves S10. The bundle no longer holds the key; the function can
enforce per-user quotas; rotating the key is one Supabase Function
secret update.

## Bilingual exercise names (S11)

`exercises` requires at least one of `name_en`, `name_zh`. The UI
falls back: `displayName(locale, ex) = (ex.name_zh if locale=='zh-Hant'
else ex.name_en) ?? ex.name_en ?? ex.name_zh ?? '(unnamed)'`.

A Chinese-only trainer can publish without ever filling `name_en`; the
trainer or recipient can tap "🌐 Translate" later. After translation,
the field is saved with no special flag — the original author owns the
edit.

## UI surfaces (unchanged from previous revision)

### Trainer-facing

- **My exercises** (`/exercises`) — list with edit / delete / share buttons.
- **Exercise editor** (`/exercises/new`, `/exercises/:id`) — bilingual
  names with 🌐 translate, muscle-group chip, equipment, instructions,
  optional image.
- **My bundles** (`/bundles`).
- **Bundle editor** (`/bundles/new`, `/bundles/:id`).
- **My trainees** — search `profiles`, tap to designate (`pending`).
  Status of each designation visible inline.
- **Plan editor** — picker sources from owner's exercises; "Save as new
  plan" alongside "Save"; sharing emits the plan + exercise shares via
  the RPC.
- **Share sheet** — multi-select of trainer's `accepted` trainees.

### Trainee-facing

- **Pending designations** — banner on Home with accept / decline.
- **Shared with me** library — replaces the old Library tab.
- **Plan editor / Workout picker** — sources from accessible exercises.
- **Home** — "Assigned by your trainer" card listing
  `assigned_by IS NOT NULL AND superseded_by IS NULL`, with trainer
  display name (S7).
- **Settings** — "Your trainer(s)" derived from accepted
  `trainer_trainees`, with a "Block" affordance.

## i18n changes

- Delete `t.exerciseName` entirely.
- Add strings for: exercise editor labels, share dialog, "shared with
  me" empty state, "assigned by" badge, "my trainees", translate
  button + error messages, camera prompt, accept/decline designation
  banner, "Block this trainer" confirmation.

## Code removal

- `public/exercises.json`
- `src/exercises.ts`
- `src/useExercises.ts`
- The jsdelivr CDN cache rule in `vite.config.ts` is replaced (not just
  removed) with a CacheFirst rule for the Supabase Storage
  `exercise-images` bucket origin. (W12)
- The 873-entry `exerciseName` overlay in `src/i18n/zh-Hant.ts` and the
  matching field in `src/i18n/types.ts`.
- `src/test/exercises.test.ts`, the fixture-based fetch stub in
  `src/test/setup.ts`, the fixture file itself.

## Execution plan (7 PRs)

1. **PR 0 — Sync layer refactor.** Per-table descriptor model in
   `src/sync/`. `pullWorker.ts` and `putWithSync.ts` consume
   descriptors. Existing four tables get descriptors mirroring today's
   behaviour. No schema changes; tests still pass. Resolves B3, B4, S5.
2. **PR 1 — Schema + Dexie v5.** Supabase migration `0002` with all new
   tables, RLS, `plan_exercises` trigger, `share_plan` RPC,
   `touch_updated_at` triggers everywhere. Dexie v5. Descriptors for the
   new tables. Tests for schema + RLS denial (W15). UI compiles against
   stubbed `useExercises` returning `[]` — pickers show empty state
   (W13 documented explicitly in the PR description).
3. **PR 2 — Rip-out free-exercise-db.** Delete the catalogue, the
   overlay, fixtures, and the jsdelivr cache rule; add the Supabase
   Storage cache rule. Replace `imageUrl()` helper.
4. **PR 3 — Exercise editor + Translate Edge Function.** Edge function
   `translate-name` + secret. `useTranslate()` hook. Exercise editor UI
   with bilingual names (nullable) and translate button. Bundle editor.
   My-exercises / my-bundles list pages. **No image upload yet.**
5. **PR 4 — Image upload + camera capture.** Storage upload helper,
   `resizeImage()` utility, `<input capture="environment">` widget,
   offline-queue handling (`pendingImageBlob` Dexie column + pre-push
   sweep, W14). Wired into the exercise editor.
6. **PR 5 — Designation + sharing UX.** "My trainees" page with
   pending/accepted/declined states. Trainee-side designation banner.
   Share sheet for exercises and bundles. `share_plan` RPC integration.
7. **PR 6 — Trainee polish.** "Assigned plans" Home card with
   `superseded_by` marking, trainee-side "Your trainer" badge,
   favourites re-pointed at UUIDs, end-to-end roundtrip test of
   trainer-creates-exercise → designation → share → trainee-uses-in-plan.

## Tests

In addition to schema and CRUD coverage:

- **RLS denial** (W15): a recipient without an `accepted` designation
  cannot SELECT a shared exercise; after delete-from-shares, the row
  disappears on next pull; non-trainer cannot insert
  `trainer_trainees`.
- **Designation consent flow**: pending → accepted → share visible;
  pending → declined → share invisible; declined sticky.
- **Plan-clone exercise emission**: share_plan RPC creates the shares
  rows; recipient can read the referenced exercises; trainer later
  deletes an exercise → recipient sees it disappear (exercises are
  soft-deleted; FK is `on delete restrict`, so trainer must soft-delete
  rather than hard-delete).
- **Resize utility**: 4000×3000 → ≤1024 px long edge, JPEG.
- **Translate function**: mocked Edge Function response; loading and
  error states.
- **Sync descriptor** (B3 regression): a recipient successfully pulls
  rows owned by someone else (shares, exercises shared in).

## Risks / open items

1. **Trainee-trainee discovery without invites.** A trainer browses
   `profiles`. For a small user base, fine. Email-invite flow is a
   v1.1 candidate.
2. **Designation declined-state is sticky.** A trainee who declined
   then changed their mind has to ask the trainer to delete the row
   and re-designate. UI affordance ("Allow X again") on the trainee
   side is a v1.1 nice-to-have.
3. **`is_trainer` is self-elevatable.** Locked down by a separate
   admin RPC before public launch (O17, tracked separately).
4. **Image storage cost.** Negligible for early users; revisit if
   library grows large.
5. **The plan-share RPC is a multi-statement transaction.** If the
   exercise shares fail (e.g. unique constraint already satisfied),
   the whole call should still succeed; design the RPC as
   `insert ... on conflict do nothing` for the shares rows.

---

## Review (independent)

An independent pass over the original draft against the current code in
`supabase/migrations/0001_init.sql`, `src/db.ts`, `src/sync/*`, and the
exercise-id call sites. Findings preserved here as historical record; the
resolution log below maps each finding to where it's now addressed.

### Blocking

**B1. The `plans` JSON containment check in `exercises_read` is
fragile.** `src/db.ts` defines `PlanExercise` as
`{ exerciseId, targetSets, ... }` and `putWithSync` writes it verbatim
into `plans.exercises` (the mapping layer in `src/sync/mapping.ts` only
renames *top-level* keys; JSON values are passed through). So the array
element on the server has camelCase keys — the `@>` probe matches
casing-wise. The real risk is the `::text` cast on `exercises.id`.
Postgres stringifies UUIDs in a canonical lowercase form, but if the
client ever upper-cases a UUID (some `crypto.randomUUID()` polyfills
do), the containment misses silently. Two cleaner options: standardize
on `to_jsonb(exercises.id)` rather than `jsonb_build_object` +
`::text`, or replace this RLS branch entirely with a normalized
`plan_exercises` join table (see B2).

**B2. RLS performance on `exercises_read` will not scale.** Each
`SELECT` on `exercises` evaluates three `EXISTS` subqueries per row.
The third one does `plans p` × jsonb containment with no usable index
(btree on `p.exercises` can't help, and no GIN index is proposed).
With 100 trainers × 200 exercises × 50 plans this is a sequential
scan per request. The migration should include:
- A normalized `plan_exercises (plan_id, exercise_id, position)` join
  table, populated by a trigger on `plans` writes, with
  `(exercise_id)` indexed. The third RLS branch becomes a flat join.
- A GIN or btree on `shares (recipient_id, resource_type, resource_id)`.
- An index on `exercise_bundle_items(exercise_id)` — the PK is
  `(bundle_id, exercise_id)`, so lookups by `exercise_id` alone are
  unindexed today.

**B3. The push/pull workers assume `user_id` ownership.**
`pullWorker.ts` hard-codes `.eq('user_id', userId)`. `shares` has no
`user_id` (it has `granter_id` + `recipient_id`), `trainer_trainees`
has `trainer_id` + `trainee_id`, `exercise_bundle_items` has no owner
column at all, and shared `exercises`/`bundles` arrive read-only with
someone else's `owner_id`. The pull worker needs per-table ownership
predicates and per-table tombstone semantics. The push side's "only
push my own rows" remains correct *if* pull knows how to fetch
others'. This is a substantial refactor of `pullWorker.ts` that PR 1
quietly inherits — call it out as a scoped sub-task.

**B4. `SyncTableName` and the `putWithSync` discriminated union don't
accommodate the new tables cleanly.** Today it's a four-arm union with
a custom favorites branch. The new tables introduce three new shapes:
composite PKs (`exercise_bundle_items`, `trainer_trainees`), an owner
column that isn't `user_id` (`shares.granter_id`), and rows that must
be *stored* in Dexie even though their owner is someone else
(`exercises`/`bundles` arriving via share). The type has to model
"owner column name" and "row key shape" as parameters — PR 1's "stub
`useExercises` to return `[]`" doesn't make this go away.

### Should-fix

**S5. Recipients deleting cached shared rows is undefined.** A stray
"remove from my library" gesture on a shared exercise would currently
enqueue a soft-delete that RLS rejects with 403 → dead letter. Add a
rule at the `putWithSync` / `deleteWithSync` boundary: shared rows
(`ownerId !== currentUserId`) are read-only in Dexie. Trying to mutate
returns immediately without enqueuing.

**S6. Plan-clone dangling references.** Plan clone copies `exerciseId`
UUIDs as-is. The trainer can later delete one of those exercises (the
`exercises` table has no FK from `plans.exercises` since the refs live
inside JSON), and the trainee then has a plan referencing a row RLS
won't return. Two fixes:
- On plan-share, also insert `shares` rows for each referenced
  exercise so the trainee retains read access regardless of plan
  membership.
- Or tombstone-on-delete for exercises that have ever been shared
  (block hard-delete, mark with `archived_at`).
Pick (a) as the simpler one; it composes with the existing RLS.

**S7. Re-share UX is half-specified.** The "replace previous
assignment from you?" prompt only exists in the open-items section.
The trainee has no way to tell which assigned plan from a trainer is
"current." Either add `superseded_by uuid` on `plans`, or at least
order the assigned-plans card by `created_at desc` and mark the
latest with a chip.

**S8. `shares` has no `updated_at` in the proposed schema.** The push
worker's OCC check is `eq('updated_at', expectedServerVersion)` on
update; without that column the check is undefined. Either add
`updated_at` + the `touch_updated_at` trigger (treat shares as
mutable for future-proofing), or special-case the sync queue to skip
OCC for shares (and document them as immutable: any "edit" is a
delete + insert).

**S9. Trainer-trainee designation: no consent, no block-list.** A
trainer can unilaterally designate any user — including other trainers
— and the trainee can't refuse before pull. Minimum bar for v1:
- Add `status text check (status in ('pending','accepted','declined'))`
  on `trainer_trainees`; gate share visibility on `accepted`.
- Disallow designating users where `target.is_trainer = true` unless
  the target opts in.
- Surface a "Block this trainer" affordance on the trainee side that
  inserts a `declined` row.
The doc treats this as v1.1 but the abuse vector (a flagged trainer
spamming plans/exercises into anyone's UI) makes it v1 table stakes.

**S10. `VITE_GOOGLE_TRANSLATE_API_KEY` baked into the bundle is the
wrong shape.** The doc acknowledges the visibility but proposes only
Cloud-console origin restriction. Referer restrictions on Google
Translate v2 are honored only when the request includes one — `fetch`
from a non-browser doesn't. The correct shape is a tiny Supabase Edge
Function (or Netlify function) that proxies the call with the key
server-side and authenticates the caller via Supabase JWT. One file,
one env var moves to server-side, abuse vector eliminated.

**S11. Bilingual NOT NULL is hostile.** A Chinese-only trainer has to
translate every entry just to publish. Fix: make one nullable, fall
back at display time (`name_zh ?? name_en`); the translate button can
populate the empty side and set a "translated, please review" hint
without making the field required.

### Worth considering

**W12. PWA: more to remove than the jsdelivr rule.** The runtime cache
pattern in `vite.config.ts` is useful — repoint it at the Supabase
Storage `exercise-images` origin
(`{project}.supabase.co/storage/v1/object/public/exercise-images/`)
with the same CacheFirst policy. Otherwise every exercise list scroll
burns bandwidth.

**W13. PR 1 "compiles" ≠ "works."** With `useExercises` stubbed to
return `[]`, any UI that does `useExercises().find(e => e.id === ...)`
returns `undefined` and renders a blank card. Acceptable as a
transitional state, but PR 1 should say explicitly that the app
shows empty pickers and dead images between PR 1 and PR 3.

**W14. Image upload offline story is missing.** Trainer adds an
exercise with a photo while offline: the Dexie row queues, but the
Storage upload isn't part of `syncQueue`. Pick one:
- Defer exercise insert until upload succeeds (breaks offline).
- Add `pendingImageBlob` on the Dexie row plus an upload queue that
  runs before the sync push.

**W15. Tests gap: RLS denial, share-revoke, jsonb regression.** The
test plan covers happy-path CRUD. Add:
- Non-recipient SELECT returns 0 rows for a shared exercise.
- After `delete from shares`, the row disappears from a fresh
  recipient pull.
- Plan-share grants exercise visibility; removing the exercise from
  the plan revokes it on next pull.
- `trainer_trainees` insert from a non-trainer is rejected by RLS.

**W16. `trainer_names` view + designation flow leaks profiles.** The
trainer scans `profiles` to pick a trainee; with global trainer read,
that's already allowed today. For a small beta, fine; flag it so it
isn't forgotten when the trainer pool grows.

### Out of scope but flag

**O17. `is_trainer` is self-elevatable in the current schema.**
`profiles_write` permits `id = auth.uid()` updates with check
`id = auth.uid()` — any user can `update profiles set is_trainer =
true where id = me`. Not introduced by this plan, but the plan's
trust model assumes trainer status is privileged. Lock down with a
column-level RLS or a separate `admin_set_trainer` RPC before this
feature ships.

**O18. Soft-delete semantics drift.** Existing tables use `deleted_at`
tombstones; the new tables don't. `shares` and `trainer_trainees`
would be hard-deleted, and the pull worker has no "row vanished"
detection — revocations wouldn't propagate to recipients. Add
`deleted_at` everywhere for consistency, or add an explicit "removed
since cursor" sweep in pull.

**O19. PR 3 is too wide.** Bundles exercise editor + bundle editor +
image upload + camera capture + translate button + "My trainees" —
five independent UX features. Split image-upload + camera into its
own PR; it's the riskiest piece (permissions, EXIF, memory) and the
easiest to revert.

### Resolution log

| Finding | Status | Where addressed |
|---|---|---|
| B1 | **Landed in PR 1** | Migration `0002_custom_exercises.sql`: `exercises_read` has no jsonb-containment branch; plan-share emits explicit exercise share rows via the `share_plan` RPC. |
| B2 | **Landed in PR 1** | Migration `0002`: `plan_exercises` join table populated by `sync_plan_exercises` trigger on `plans` writes, indexed on `exercise_id`. `shares` indexed `(recipient_id, resource_type, resource_id)`. `exercise_bundle_items` indexed on `exercise_id`. |
| B3 | **Landed in PR 0** | Per-table descriptors with `pullPredicate` (`owner` / `recipient` / `rls-only`). PR 1 uses `rls-only` for exercises/bundles/shares/trainer_trainees so the pull worker fetches both owned and shared-in rows. |
| B4 | **Landed in PR 0** | Descriptor model handles composite PKs (`exerciseBundleItems`, `trainerTrainees`, `favorites`) and non-`user_id` owner columns (`ownerId` for exercises/bundles, `granterId` for shares, `trainerId` for trainer_trainees). |
| S5 | **Landed in PR 1** | Cross-user mutation guard in `putWithSync` now exercises a real path: `putWithSync('exercises', ..., 'trainee-y')` against a row whose `ownerId='trainer-x'` rejects with a clear error and leaves the sync queue empty. Regression test in `putWithSync.test.ts`. |
| S6 | **Landed in PR 1** | `share_plan` RPC clones the plan + emits exercise share rows atomically with `on conflict do nothing` (idempotent). `exercises.exercise_id ← on delete restrict` from `favorites` and `plan_exercises` blocks hard-delete; trainer must soft-delete (set `deleted_at`), and the next trainee pull removes the row. |
| S7 | **Landed in PR 1** | `plans` gained `superseded_by uuid references plans(id) on delete set null`. The `share_plan` RPC stamps the previous current assignment from the same trainer when re-sharing. Dexie schema indexes `supersededBy` for the assigned-plans-card live query. |
| S8 | **Landed in PR 1** | `shares` has `updated_at` + `deleted_at` + the `shares_touch` `touch_updated_at` trigger. Participates in OCC via the existing push worker code path with no special-casing. |
| S9 | **Landed in PR 1** | `trainer_trainees.status text default 'pending' check (status in ('pending','accepted','declined'))`. New `has_accepted_designation(trainer, trainee)` SECURITY DEFINER function gates the exercise and bundle read policies. Trainee-side `trainer_trainees_trainee_respond` RLS policy lets the trainee update status; trainer-side `trainer_trainees_insert` policy enforces `trainer_id = auth.uid()`. |
| S10 | **Deferred (removed from PR 3 follow-up)** | Edge Function + `useTranslate()` hook + 🌐 button shipped in PR 3 then removed at user request before deploy. Bilingual `name_en`/`name_zh` fields stay; trainers fill both manually for now. Edge Function spec preserved in this doc; re-introduce by restoring `supabase/functions/translate-name/index.ts` + `src/useTranslate.ts` + the BilingualNameField component, then re-adding the i18n keys. |
| W13 | **Cleared in PR 3** | Exercise editor + bilingual names + translate button shipped. Library and workflow tests un-skipped — they now seed `db.exercises` directly and assert against the trainer-authored shape. Was: "PR 1 stub — restored in PR 3"; now: covered. |
| S11 | **Landed in PR 1** | `exercises.name_en` and `name_zh` are nullable with `check (coalesce(name_en, name_zh) is not null)`. Dexie's `CustomExercise` interface types both as `string \| null`. Display-time fallback is the responsibility of the UI in PR 3. |
| W12 | **Landed in PR 2** | `vite.config.ts` runtime cache list reordered: more-specific `exerciseImagesPattern` (CacheFirst for the Supabase Storage `exercise-images` bucket origin path) is matched before the catch-all NetworkOnly rule on the Supabase origin. Pattern derived from `VITE_SUPABASE_URL` at build time. |
| W14 | **Scheduled PR 4** | `pendingImageBlob` Dexie column + pre-push upload sweep. |
| W15 | **Partially landed in PR 1** | Client-side: descriptor unit tests for the new tables; S5-guard regression test for cross-user write rejection. Full server-side RLS denial tests (pgTAP / supabase test harness) deferred to PR 5 when the share UX is wired and integration coverage is meaningful. |
| W16 | **Accepted, noted as risk** | Flagged in Risks/open item 1; revisit when trainer pool grows. |
| O17 | **Deferred** | Out of scope for this work; tracked as a pre-launch hardening task. |
| O18 | **Landed in PR 1** | Every new mutable table (`exercises`, `exercise_bundles`, `shares`) has `deleted_at`; pull worker already honours soft-delete tombstones. `exercise_bundle_items` and `trainer_trainees` are hard-deleted by design (status flips for trainer_trainees; bundle items are re-derived by trainer-side bundle editor). |
| O19 | **Resolved** | PR 3 split into PR 3 (editor + translate) and PR 4 (image upload + camera). PR sequence is now 7 PRs. |
