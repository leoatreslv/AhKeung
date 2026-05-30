# Cardio exercises + default Treadmill

**Date:** 2026-05-31
**Status:** Approved (revised after fresh-eyes review), pending implementation plan

## Goal

Add a **Treadmill** exercise that every user has by default, and introduce a
typed **cardio** exercise kind whose sets/targets track **inclination (%)**,
**speed (km/h)**, and **time (minutes)** instead of the strength model's
reps + weight. Treadmill must work everywhere a normal exercise does —
**workout logging, plans, bundles, favorites, sharing**. Extensible to other
cardio machines later, but only Treadmill ships now (YAGNI).

## Background / constraints

- Today every exercise logs `reps` + `weight` per set (`SetLog`, `db.ts:57`).
  Cardio metrics don't fit this model.
- All exercises are `exercises` rows (`db.ts` `CustomExercise`) synced via
  Supabase; the old built-in catalogue was removed.
- **`sessions.exercises` is plain jsonb** with no mirror table / trigger / FK
  (`0001_init.sql:25-35`). New nested fields on `SetLog` ride along with no
  schema change.
- **`plans.exercises` is NOT a free jsonb passthrough**: a trigger fans it into
  a `plan_exercises` mirror table doing `(elem->>'exerciseId')::uuid` with
  `references exercises(id)` (`0002_custom_exercises.sql:103,113-115`). The
  `share_plan` RPC casts the same way (`0002:288`). `favorites.exercise_id`
  (`0002:93`) and `exercise_bundle_items.exercise_id` (`0002:47`) are
  `uuid not null references exercises(id)`.
- **Consequence:** an exercise id used in a plan/bundle/favorite MUST be a real
  UUID present in `exercises`. A hardcoded client-only built-in (`builtin:...`)
  would fail the uuid cast and the FK. Therefore Treadmill is seeded as a
  **real `exercises` row**, not a client constant. (This was the decisive
  finding from review; it also makes the client *simpler* — no catalogue merge,
  no read-only special-casing.)

## Decisions

1. **Typed cardio fields** — exercises carry a `kind`; cardio sets store
   inclination/speed/time as real fields.
2. **Seeded real row** — Treadmill is one real `exercises` row, globally
   readable via RLS, so it satisfies every FK and flows through all existing
   machinery (plans, bundles, favorites, sharing, display).
3. **Units** — inclination `%`, speed `km/h` (metric).
4. **Time entry** — a single decimal **minutes** field (e.g. `30`, `12.5`),
   stored as `durationSec` (seconds).
5. **Sets retained** — cardio keeps the multi-set array (intervals); starts
   with one row.

## DB migration (`supabase/migrations/0014_cardio_and_treadmill.sql`, new)

1. **`exercises.kind`** — `add column kind text not null default 'strength'
   check (kind in ('strength','cardio'))`. Additive; existing rows default to
   strength.
2. **`exercises.is_global`** — `add column is_global boolean not null default
   false`. Marks rows visible to everyone. Server-only (not synced to clients
   as a field; see mapping below).
3. **Widen `exercises_read`** — drop/recreate the policy (`0002:160-179`) adding
   one clause: `or exercises.is_global`. Owner/share clauses unchanged.
   `exercises_write` stays owner-only, so non-owners cannot edit/delete the
   global row.
4. **Seed Treadmill** — insert one row with a **fixed UUID**
   (`11111111-1111-4111-8111-111111111111`, a stable well-known constant so the
   id is identical across environments):
   - `owner_id` = the first admin (`select p.id from profiles p join auth.users
     u on u.id = p.id where lower(u.email) = 'leo@reslv.io'`), matching how
     `0013` seeds the admin. Guard with `on conflict (id) do nothing` for
     replay idempotency.
   - `name_en = 'Treadmill'`, `name_zh = '跑步機'`, `muscle_group = 'cardio'`,
     `kind = 'cardio'`, `is_global = true`, `equipment/instructions/image_path`
     null.

No migration is needed for the `SetLog` / `PlanExercise` field additions
(sessions/plans store them in jsonb).

## Sync mapping (`src/sync/mapping.ts`, `src/sync/descriptors.ts`)

- Add `kind` to the `exercises` column allowlist (`mapping.ts:16`) so it pulls
  and pushes. `kind` is identical in snake/camel form.
- `is_global` is **server-only** — excluded from the allowlist; clients never
  read or write it. (The global row is delivered to clients by RLS, not by a
  client-visible flag.)
- Pulled Treadmill lands in every user's local `db.exercises` like any
  shared-in exercise.

## Client data model (`src/db.ts`)

```ts
export interface CustomExercise extends SyncedRow {
  // ...existing...
  kind?: 'strength' | 'cardio';   // synced; absent/strength for legacy rows
}

export interface SetLog {
  reps: number; weight: number; done: boolean;
  inclinePct?: number; speedKmh?: number; durationSec?: number;   // cardio-only
}

export interface PlanExercise {
  exerciseId: string; targetSets: number; targetReps: number;
  targetWeight?: number; notes?: string;
  targetInclinePct?: number; targetSpeedKmh?: number; targetDurationSec?: number;
}
```

A single helper `exerciseKind(ex): 'strength' | 'cardio'` (returns
`ex?.kind ?? 'strength'`) is the only read path, so callers never branch on
`undefined`. **No `useCatalog()` merge and no built-in constant** — Treadmill is
a normal row from `useExercises()` / `db.exercises`, resolved everywhere
(Workout, PlanEditor, BundleEditor, Library, Home history, `useExercise()`,
details modal) with zero call-site changes for *lookup*.

## Workout logger (`src/pages/Workout.tsx`)

- Set-row grid branches on `exerciseKind(meta)`:
  - **strength** (unchanged): set # · weight · reps · done · delete.
  - **cardio**: set # · incline (%) · speed (km/h) · time (min) · done · delete.
- Cardio inputs are `type="number"` with `w-full min-w-0` (matching the recent
  grid-overflow fix). Time shows decimal minutes; `durationSec =
  round(min * 60)`, `min = durationSec / 60`.
- **`addSet` (`Workout.tsx:72-80`)** — must clone cardio fields for cardio
  exercises (carry over incline/speed/time from the last set), not just
  reps/weight. *(Review gap #4.)*
- **`addExercise`** — seed a cardio first set: `{ inclinePct: 0, speedKmh: 6,
  durationSec: 1800, done: false, reps: 0, weight: 0 }`.
- **Plan→session seeding (`Workout.tsx:40-44`)** — for a cardio plan exercise,
  map `targetInclinePct/targetSpeedKmh/targetDurationSec` into the first set.

## Plan editor (`src/pages/PlanEditor.tsx`)

- For cardio exercises the target block renders incline/speed/time targets
  instead of sets/reps/weight, writing the `target*` cardio fields.
- `addExercise` (`PlanEditor.tsx:74`) seeds cardio targets when the picked
  exercise is cardio.

## Display edges

- **Home set summary (`Home.tsx:166-170`)** — make cardio-aware: a cardio set
  renders e.g. `30min · 6km/h · 2%` instead of `reps×weight`. *(Only set-level
  reps/weight formatting in the app; confirmed by review.)*
- **Home name resolution** — already works: Treadmill is in `db.exercises` for
  every user via the global pull, so `catalog?.find` (`Home.tsx:153`) resolves
  the name with no change.
- **Metrics.tsx** — no session set math (body metrics only); out of scope.
- **ExerciseDetailsModal** — takes the exercise as a prop; a Treadmill with
  null instructions shows the header/image placeholder only. Acceptable.

## i18n (`src/i18n/{en,zh-Hant}.ts`, `types.ts`)

New strings: cardio field labels (`incline`, `speed`, `time`) and unit
suffixes (`%`, `km/h`, `min`). The Treadmill *name* comes from the seeded
`name_en`/`name_zh`, not i18n keys (consistent with all exercise names).

## Testing (TDD)

- `minutes ↔ seconds` conversion (round-trip, rounding, empty/0).
- `exerciseKind()` defaulting (undefined → strength; cardio honoured).
- `addSet` clones cardio fields for cardio exercises; strength unchanged.
- Plan→session seeding maps cardio targets into the first set.
- Cardio set-summary formatting helper.
- Roundtrip/mapping test that `kind` survives a pull/push cycle.

## Known minor / accepted

- The admin who owns the seeded row (Leo) will see Treadmill in **My Exercises**
  (owner-filtered list) and could edit/delete it. Acceptable for now; a
  delete-guard is possible later if it matters.
- Trainees resolve a shared plan's Treadmill correctly because the row is global
  (RLS `is_global`) and pulled into their local catalogue; the redundant
  exercise-share emitted by `share_plan` is harmless (valid FK).

## Out of scope (YAGNI)

- Other cardio machines (bike, rower) — model supports them; not shipped.
- Trainer-authored cardio custom exercises (would need editor UI to set `kind`;
  the column already exists, so this is a later UI-only addition).
- Distance / pace / calorie metrics; a treadmill glyph (no `emoji` field on
  exercises — uses the standard image placeholder).

## Version

User-facing change → bump `package.json` 0.2.1 → 0.2.2.
