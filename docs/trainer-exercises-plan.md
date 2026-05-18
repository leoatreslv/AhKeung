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
