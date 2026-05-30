# Cardio exercises + built-in Treadmill

**Date:** 2026-05-31
**Status:** Approved, pending implementation plan

## Goal

Add a built-in **Treadmill** exercise that every user sees by default, and
introduce a typed **cardio** exercise kind whose sets/targets track
**inclination (%)**, **speed (km/h)**, and **time (minutes)** instead of the
strength model's reps + weight. The design is extensible to other cardio
machines (bike, rower) later, but only Treadmill ships now (YAGNI).

## Background / constraints

- Today every exercise logs `reps` + `weight` per set (`SetLog`, `db.ts:57`).
  Cardio metrics don't fit this model.
- The old built-in catalogue was removed ("Rip out free-exercise-db"). All
  exercises are now trainer-authored `CustomExercise` rows synced via Supabase.
  There is no seed mechanism.
- `sessions.exercises` and `plans.exercises` are stored as single **jsonb**
  columns (`src/sync/mapping.ts:6-7`), so new fields on the embedded `SetLog` /
  `PlanExercise` shapes sync automatically — **no DB migration is required**.
- `displayName()` only needs `nameEn`/`nameZh`; `imageUrl()` returns `null`
  (→ placeholder) when an exercise has no image. So a hardcoded built-in slots
  into existing lookups with no special-casing in the display helpers.

## Decisions (from brainstorming)

1. **Typed cardio fields** — exercises carry a `kind`; cardio sets store
   inclination/speed/time as real fields.
2. **Built-in for everyone** — Treadmill is hardcoded client-side and merged
   into the catalogue; not synced, not owned, read-only (cannot be edited or
   deleted).
3. **Units** — inclination in `%`, speed in `km/h` (metric, matching the app).
4. **Time entry** — a single decimal **minutes** field (e.g. `30`, `12.5`),
   stored internally as `durationSec` (seconds).
5. **Sets retained** — cardio keeps the multi-set array so intervals are
   possible; it just starts with one row.

## Data model (`src/db.ts`, no migration)

```ts
export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
  // Cardio-only (present when the exercise kind is 'cardio'); reps/weight
  // are left at their defaults and ignored for cardio sets.
  inclinePct?: number;
  speedKmh?: number;
  durationSec?: number;
}

export interface PlanExercise {
  exerciseId: string;
  targetSets: number;
  targetReps: number;
  targetWeight?: number;
  notes?: string;
  // Cardio-only targets.
  targetInclinePct?: number;
  targetSpeedKmh?: number;
  targetDurationSec?: number;
}
```

A `kind: 'strength' | 'cardio'` field is added to the exercise shape, but
**only built-ins set it**. Custom exercises omit it and are treated as
`strength`, so the synced `exercises` table is untouched. A small helper —
`exerciseKind(ex): 'strength' | 'cardio'` (defaults to `'strength'`) — is the
single read path so callers never branch on `undefined`.

## Built-in catalogue (`src/builtinExercises.ts`, new)

- Exports `BUILTIN_EXERCISES: CustomExercise[]` with one entry:
  - `id: 'builtin:treadmill'`, `kind: 'cardio'`, `muscleGroup: 'cardio'`,
    `nameEn: 'Treadmill'`, `nameZh: '跑步機'`, `equipment: null`,
    `instructions: null`, `imagePath: null`, and sentinel sync fields
    (`updatedAt: 0`, `serverVersion: null`, `ownerId: 'builtin'`,
    `createdAt: 0`).
  - `CustomExercise` has no `emoji` field, so the built-in renders the
    standard gray image placeholder (`Workout.tsx:152-156`) like any
    imageless exercise. A treadmill glyph is a possible later polish, out
    of scope here.
- New hook `useCatalog()` returns `[...BUILTIN_EXERCISES, ...useExercises()]`.
- Lookup/picker call sites switch from `useExercises()` to `useCatalog()`:
  Workout (`findEx`), PlanEditor (`findEx` + picker), BundleEditor picker,
  and the exercise-details modal source.
- **`MyExercises` keeps `useExercises()` (custom-only)** so the built-in never
  appears in the management/edit/delete surface — it is read-only by
  construction. The exercise editor and soft-delete paths are unaffected.

The `'builtin:'` id prefix is the reserved sentinel that marks a non-synced,
read-only exercise. Plans/sessions may reference `builtin:treadmill` by id like
any other exercise; lookups resolve it through `useCatalog()`.

## Workout logger (`src/pages/Workout.tsx`)

- The set-row grid branches on `exerciseKind(meta)`:
  - **strength** (unchanged): set # · weight · reps · done · delete.
  - **cardio**: set # · incline (%) · speed (km/h) · time (min) · done · delete.
- Cardio header labels come from i18n. Inputs are `type="number"` with
  `w-full min-w-0` (consistent with the recent grid-overflow fix). The time
  input shows decimal minutes and converts via `durationSec = round(min * 60)`
  and `min = durationSec / 60`.
- `addExercise` seeds a cardio first set with `{ inclinePct: 0, speedKmh: 6,
  durationSec: 1800, done: false, reps: 0, weight: 0 }` (sensible defaults:
  6 km/h, 30 min, 0%). Strength defaults unchanged.
- Plan→session seeding (around `Workout.tsx:40-44`): when the plan exercise is
  cardio, map `targetInclinePct/targetSpeedKmh/targetDurationSec` into the
  first set instead of reps/weight.

## Plan editor (`src/pages/PlanEditor.tsx`)

- For cardio exercises the target block renders incline/speed/time targets
  instead of sets/reps/weight, writing the `target*` cardio fields.
- `addExercise` (`PlanEditor.tsx:74`) seeds cardio targets when the picked
  exercise is cardio.

## Display edges

- `Home.tsx` set summary (`Home.tsx:167-169`) becomes cardio-aware: a cardio
  set renders e.g. `30min · 6km/h · 2%` rather than `reps×weight`.
- Any weight-based volume/aggregation skips or safely handles cardio sets
  (no `NaN`, no `0×0` artefacts). Audit Home and Metrics for weight math over
  session sets during implementation.

## i18n (`src/i18n/{en,zh-Hant}.ts`, `types.ts`)

New strings: cardio field labels (`incline`, `speed`, `time`) and their unit
suffixes (`%`, `km/h`, `min`), plus the Treadmill display name is provided by
the built-in's `nameEn`/`nameZh` directly (not via i18n keys).

## Testing (TDD)

- `minutes ↔ seconds` conversion (round-trip, rounding, empty/0).
- `useCatalog()` merge: built-in present, ordering, and that `useExercises()`
  (management) still excludes built-ins.
- `exerciseKind()` defaulting (undefined → strength; cardio honoured).
- Plan→session seeding maps cardio targets into the first set.
- Cardio set summary formatting in the Home/history helper.

## Out of scope (YAGNI)

- Other cardio machines (bike, rower) — the model supports them, but only
  Treadmill ships.
- Trainer-authored cardio custom exercises (would need a `kind` column +
  editor UI on the synced `exercises` table). Deferred until requested.
- Distance/pace/calorie metrics.

## Version

User-facing change → bump `package.json` 0.2.1 → 0.2.2 (Settings footer shows
`VITE_APP_VERSION`).
