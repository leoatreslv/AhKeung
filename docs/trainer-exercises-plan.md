# Trainer-owned custom exercises with sharing

**Status:** approved 2026-05-18, ready to implement
**Scope:** replaces the free-exercise-db catalogue with a trainer-authored
exercise library, adds explicit sharing to trainees, and introduces a
trainer↔trainee designation relationship.

## Background

The app currently ships an 873-entry catalogue sourced from
[free-exercise-db](https://github.com/yuhonas/free-exercise-db). Exercises
are identified by stable string slugs (e.g. `Barbell_Squat`) and images come
from a public CDN. A `t.exerciseName` overlay in `src/i18n/zh-Hant.ts` ships
~75 hand-curated Chinese names; the rest fall back to English.

The auth & sync foundation (Supabase + RLS + push/pull workers) is in place.
The schema already anticipates a trainer relationship: `profiles.is_trainer`,
a `trainer_names` view, and `plans.assigned_by`. Read RLS lets any trainer
see every user's owned rows.

## Goals

- Trainers author their own exercises (bilingual, optional image).
- Trainers explicitly share **exercises**, **named bundles**, or **whole
  plans** to specific trainees they've designated.
- A trainer "picks" a trainee; that act designates the trainer to the
  trainee and adds the trainee to the trainer's share-with picker.
- The free-exercise-db catalogue is removed entirely (the app is
  pre-launch; no data to migrate).
- Camera capture for exercise images on phone.
- Optional one-click Google Translate to fill the other-language name.

## Non-goals

- Email-based trainee invitations (v1 picks from `profiles`).
- Real-time propagation of trainer plan edits to trainees. Trainer
  workflow is "edit → Save as new plan → re-share"; cloned plans are
  independent rows on the trainee side.
- Per-exercise language overlay strings in i18n. Names live in the
  data, not in i18n files.
- Tightening trainer read scope on sessions/metrics/favorites. Trainers
  retain global read on those, as today.

## Data model

### New Supabase tables (migration `0002_custom_exercises.sql`)

```sql
create table exercises (
  id            uuid        primary key default gen_random_uuid(),
  owner_id      uuid        not null references profiles(id) on delete cascade,
  name_en       text        not null,
  name_zh       text        not null,
  muscle_group  text        not null,  -- one of the 9 MuscleGroup values
  equipment     text,
  instructions  text,                  -- plain text, multi-paragraph
  image_path    text,                  -- Storage key, null if no image
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index exercises_owner on exercises(owner_id);

create table exercise_bundles (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references profiles(id) on delete cascade,
  name        text        not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index exercise_bundles_owner on exercise_bundles(owner_id);

create table exercise_bundle_items (
  bundle_id   uuid not null references exercise_bundles(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  position    int  not null default 0,
  primary key (bundle_id, exercise_id)
);

create table shares (
  id            uuid        primary key default gen_random_uuid(),
  granter_id    uuid        not null references profiles(id) on delete cascade,
  recipient_id  uuid        not null references profiles(id) on delete cascade,
  resource_type text        not null check (resource_type in ('exercise','bundle','plan')),
  resource_id   uuid        not null,
  created_at    timestamptz not null default now(),
  unique (resource_type, resource_id, recipient_id)
);
create index shares_recipient on shares(recipient_id);

create table trainer_trainees (
  trainer_id    uuid        not null references profiles(id) on delete cascade,
  trainee_id    uuid        not null references profiles(id) on delete cascade,
  designated_at timestamptz not null default now(),
  primary key (trainer_id, trainee_id)
);
```

### Modified existing tables

- `plans.exercises` JSON: each `exerciseId` becomes a UUID referencing
  `exercises(id)` (was a free-exercise-db slug).
- `sessions.exercises[].exerciseId`: same.
- `favorites`: composite PK becomes `(user_id, exercise_id)` where
  `exercise_id` is a UUID referencing `exercises(id)`.

Since the app is pre-launch, no SQL data migration; the Dexie v4 → v5
upgrade simply wipes (matching the v3 → v4 comment).

### RLS

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `exercises` | owner OR direct share OR via bundle share OR via plan share | owner only |
| `exercise_bundles` | owner OR bundle share recipient | owner only |
| `exercise_bundle_items` | parent bundle SELECT | parent bundle owner |
| `shares` | granter OR recipient | granter only |
| `trainer_trainees` | trainer or trainee on the row | trainer only |
| `plans` | unchanged (owner OR `is_trainer()`) | unchanged |

The exercise SELECT policy is the only complex one — it has to look up
shares of three different shapes. Expressed as:

```sql
create policy exercises_read on exercises for select using (
  owner_id = auth.uid()
  or exists (
    select 1 from shares s
    where s.recipient_id = auth.uid()
      and s.resource_type = 'exercise'
      and s.resource_id = exercises.id
  )
  or exists (
    select 1 from shares s
    join exercise_bundle_items i on i.bundle_id = s.resource_id
    where s.recipient_id = auth.uid()
      and s.resource_type = 'bundle'
      and i.exercise_id = exercises.id
  )
  or exists (
    select 1 from shares s
    join plans p on p.id = s.resource_id
    where s.recipient_id = auth.uid()
      and s.resource_type = 'plan'
      and p.exercises::jsonb @> jsonb_build_array(jsonb_build_object('exerciseId', exercises.id::text))
  )
);
```

### Storage

Bucket `exercise-images`, public read. Write policy: authenticated
users may upload into `{auth.uid()}/...` and modify only their own
prefix. Path convention `{owner_id}/{uuid}.jpg`. Files are JPEG after
client-side resize to a 1024 px long edge.

### Dexie v5

New client-side tables (Dexie schema bump from 4 → 5):

```
exercises:           id, ownerId, muscleGroup, updatedAt
exerciseBundles:     id, ownerId, updatedAt
exerciseBundleItems: [bundleId+exerciseId], bundleId, exerciseId
shares:              id, recipientId, [resourceType+resourceId], updatedAt
trainerTrainees:     [trainerId+traineeId], trainerId, traineeId
```

v4 → v5 upgrade: wipe (pre-launch).

`putWithSync` / `deleteWithSync` registers the new tables. The compound
key on `exerciseBundleItems` follows the same pattern already used for
`favorites`.

## Sharing semantics

Three resource types, two semantic models:

- **Exercises and bundles** — share = grant read access. A row in
  `shares` is created; RLS gives the recipient SELECT on the resource.
  Deleting the share row revokes access immediately.
- **Plans** — share = clone. A new row is inserted into the trainee's
  `plans` table with `assigned_by = granter.id` and the trainer's
  exercise UUIDs copied as-is. The trainee owns the copy and can edit
  it. Trainer edits to the original do not propagate.

When a trainer wants to push an update to an already-shared plan, the
flow is:

1. Open the original plan in the trainer's library.
2. Tap "Save as new plan" — creates a fresh `id` owned by the trainer.
3. Tap "Share" on the new plan, pick the trainee.
4. The trainee gets a fresh assigned plan; the previous one stays in
   their library unless they delete it (optionally, the share dialog
   asks "replace existing assignment from you?").

## Trainer ↔ trainee designation

"My trainees" is a trainer-only screen. The trainer searches the
`profiles` list (already readable to trainers under existing RLS) and
taps a row to designate. That inserts a `trainer_trainees` row, which:

- Adds the trainee to every "Share with…" picker.
- Surfaces a "Your trainer: X" badge on the trainee's Settings (and
  Home) page via a join with `trainer_names`.
- Optionally enables a future "auto-share my exercise library" toggle
  (out of scope for v1).

There is no consent step in v1. A trainer designation is reversible
from the trainer side (delete the row). A trainee-side "decline /
remove this trainer" affordance is a v1.1 nice-to-have.

## Google Translate

The exercise editor has two name fields. Next to each, a small "🌐"
button calls the Google Cloud Translation v2 REST endpoint with the
other field's value and the appropriate target locale.

Env var: `VITE_GOOGLE_TRANSLATE_API_KEY` (added to `.env.example` and
Netlify). The button is disabled with a tooltip if absent.

Request:

```
POST https://translation.googleapis.com/language/translate/v2?key=KEY
Content-Type: application/json
{ "q": "Bench Press", "source": "en", "target": "zh-TW", "format": "text" }
```

Response: `data.translations[0].translatedText`. Failures show an inline
error; the user can still type manually.

## UI surfaces

### Trainer-facing

- **My exercises** (`/exercises`) — list with edit / delete / share
  buttons. CTA to add new.
- **Exercise editor** (`/exercises/new`, `/exercises/:id`) — bilingual
  name + 🌐 translate, muscle-group chip, equipment, instructions,
  optional image with camera capture.
- **My bundles** (`/bundles`) — list, share button.
- **Bundle editor** (`/bundles/new`, `/bundles/:id`) — name,
  description, drag-to-reorder list of exercises.
- **My trainees** — search the global `profiles` list, tap to
  designate / un-designate. Likely lives under Settings.
- **Plan editor** — picker now sources from owner's exercises;
  "Save as new plan" alongside "Save".
- **Share sheet** — opened from any of the above. Multi-select of
  trainer's designated trainees.

### Trainee-facing

- **Shared with me** library — replaces the old free-exercise-db
  Library tab. Read-only list of exercises and bundles the trainee has
  access to, grouped by sharing trainer.
- **Plan editor's picker** — sources from accessible exercises (own +
  shared via any path).
- **Workout picker** — same.
- **Home** — new "Assigned by your trainer" card listing
  `plans.assigned_by IS NOT NULL`, with trainer display name.
- **Settings** — "Your trainer(s): X, Y" derived from
  `trainer_trainees` joined with `trainer_names`.

## i18n changes

- Delete `t.exerciseName` entirely (873 strings of dead weight).
- Add strings for: exercise editor labels, share dialog, "shared with
  me" empty state, "assigned by" badge, "my trainees", translate
  button + error messages, camera prompt. Both `en` and `zh-Hant`.

## Code removal

- `public/exercises.json`
- `src/exercises.ts`
- `src/useExercises.ts`
- The jsdelivr CDN cache rule in `vite.config.ts`
- The 873-entry `exerciseName` overlay in `src/i18n/zh-Hant.ts` and the
  matching field in `src/i18n/types.ts`
- `src/test/exercises.test.ts`, the fixture-based fetch stub in
  `src/test/setup.ts`, the fixture file itself

## Execution plan (5 PRs)

1. **Schema PR** — Supabase migration `0002`, Dexie v5, sync wiring,
   tests for the new tables. The old `useExercises()` is replaced with
   a stub that returns `[]`, so the existing UI compiles and tests
   still pass.
2. **Rip-out PR** — delete free-exercise-db files, drop the i18n
   overlay, replace `imageUrl()` with a Supabase Storage URL builder.
   Pickers temporarily render an empty state — that's expected until
   PR 3.
3. **Trainer authoring PR** — exercise editor (bilingual + translate),
   bundle editor, my-exercises/my-bundles pages, image upload helper
   (`resizeImage` + Storage upload), "My trainees" picker.
4. **Sharing PR** — `shares` UX (exercise / bundle), plan-clone on
   share, "Save as new plan", "Shared with me" library tab.
5. **Trainee polish PR** — "Assigned plans" card on Home (with trainer
   display name), trainee-side "Your trainer" badge, favourites
   re-pointed at UUIDs.

## Tests

- Schema v5: table list + version (extends `src/test/db.test.ts`).
- Exercises CRUD via `putWithSync`.
- Bundles + bundle-items CRUD.
- Share roundtrip: granter writes a row → recipient pulls via
  `fakeSupabase` and sees the resource appear in their Dexie cache.
- `resizeImage` utility: input 4000×3000 → output ≤1024 px long edge,
  JPEG MIME, plausible quality.
- Translate-button: mocked fetch; loading state; error path.
- Drop tests that exercise the free-exercise-db fixture path.

## Risks / open items

1. **Trainer-trainee discovery without invites.** A trainer browses
   `profiles` — for a small user base that's fine; for a large one,
   add search by display name (already cheap with a Postgres index)
   and consider an email-invite flow in v1.1.
2. **Plan-share replace-or-add.** When a trainer shares a plan to a
   trainee who already has an `assigned_by = me` plan, do we replace
   the previous one or always add a new one? Default: prompt the
   trainer ("replace previous?"). Easy to flip later.
3. **Image storage cost.** Each image ~50–200 KB after resize.
   Negligible for a few hundred users; revisit if it grows.
4. **Trainee-side consent.** v1 has none — any trainer can designate
   any trainee. Acceptable for an invite-only beta; revisit before any
   public launch.
5. **Translate API key in a public bundle.** `VITE_*` env vars are
   baked into the client bundle, so the key is visible. Restrict it in
   the Google Cloud console to the production origin(s) and set a
   daily quota. Treat key rotation as a routine ops task.

---

## Review (independent)

An independent pass over this doc against the current code in
`supabase/migrations/0001_init.sql`, `src/db.ts`, `src/sync/*`, and the
exercise-id call sites. Findings grouped by severity; the **Blocking**
items have to be resolved before PR 1 starts or the migration will be
re-cut. **Should-fix** items are correctness or UX gaps that the
implementer should land alongside the relevant PR. **Worth considering**
and **Out of scope but flag** are notes for the record.

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

To be filled in as items are addressed in subsequent PRs. Format:
`B1 — resolved in PR N: <approach>` or `S6 — accepted, scheduled PR M`
or `O17 — deferred, tracked in issue #X`.
