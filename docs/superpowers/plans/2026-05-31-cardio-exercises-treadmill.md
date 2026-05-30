# Cardio exercises + default Treadmill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default Treadmill exercise and a typed "cardio" exercise kind that tracks inclination / speed / time instead of reps / weight, working everywhere a normal exercise does (logging, plans, bundles, favorites, sharing).

**Architecture:** Treadmill is seeded as a real, globally-readable `exercises` row (so it satisfies the existing `uuid references exercises(id)` FKs on plans/bundles/favorites). Exercises gain a synced `kind` column; cardio sets/targets gain optional fields stored in the existing `sessions.exercises` / `plans.exercises` jsonb. All cardio logic lives in one pure, tested helper module (`src/cardio.ts`); the React pages just call it.

**Tech Stack:** React + TypeScript + Vite, Dexie (IndexedDB), Supabase (Postgres + RLS), Vitest, Tailwind.

**Conventions for this repo:**
- Typecheck: `npx tsc -b --noEmit` (bare `npx tsc --noEmit` is a no-op here).
- Tests: `npx vitest run <path>`.
- `kind` is **not** a Dexie index, so do **not** add a `db.version(...)` bump.
- Spec: `docs/superpowers/specs/2026-05-31-cardio-exercises-treadmill-design.md`.

---

### Task 1: Extend the data model types (`src/db.ts`)

**Files:**
- Modify: `src/db.ts:88-103` (`CustomExercise`), `src/db.ts:23-29` (`PlanExercise`), `src/db.ts:57-61` (`SetLog`)

- [ ] **Step 1: Add `kind` to `CustomExercise`**

In `src/db.ts`, inside `interface CustomExercise extends SyncedRow { ... }` (the block at `src/db.ts:88-103`), add after `muscleGroup`:

```ts
  /** Exercise modality. Absent/`'strength'` for legacy + all custom rows;
   *  only the seeded global cardio exercises set `'cardio'`. Synced. */
  kind?: 'strength' | 'cardio';
```

- [ ] **Step 2: Add cardio fields to `SetLog`**

Replace `src/db.ts:57-61` with:

```ts
export interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
  // Cardio-only (present when the exercise's kind is 'cardio'). reps/weight
  // are left at 0 and ignored for cardio sets. durationSec stores seconds.
  inclinePct?: number;
  speedKmh?: number;
  durationSec?: number;
}
```

- [ ] **Step 3: Add cardio targets to `PlanExercise`**

Replace `src/db.ts:23-29` with:

```ts
export interface PlanExercise {
  exerciseId: string;
  targetSets: number;
  targetReps: number;
  targetWeight?: number;
  notes?: string;
  // Cardio-only targets (present when the exercise's kind is 'cardio').
  targetInclinePct?: number;
  targetSpeedKmh?: number;
  targetDurationSec?: number;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: PASS (additive optional fields; no existing call site breaks). Do NOT add a Dexie version bump — `kind` is not indexed.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts
git commit -m "model: add cardio kind + inclination/speed/time fields"
```

---

### Task 2: Cardio helper module (`src/cardio.ts`) — TDD

This is the tested core. The pages in later tasks only call these functions.

**Files:**
- Create: `src/cardio.ts`
- Test: `src/cardio.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cardio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { PlanExercise, SetLog } from './db';
import {
  exerciseKind,
  minutesToSeconds,
  secondsToMinutes,
  nextSet,
  setsFromPlanExercise,
  defaultPlanExercise,
  cardioSetSummary,
} from './cardio';

describe('exerciseKind', () => {
  it('defaults undefined/absent to strength', () => {
    expect(exerciseKind(undefined)).toBe('strength');
    expect(exerciseKind({ kind: undefined })).toBe('strength');
  });
  it('honours cardio', () => {
    expect(exerciseKind({ kind: 'cardio' })).toBe('cardio');
  });
});

describe('minutes <-> seconds', () => {
  it('converts minutes to whole seconds', () => {
    expect(minutesToSeconds(30)).toBe(1800);
    expect(minutesToSeconds(12.5)).toBe(750);
  });
  it('floors invalid/negative/zero minutes to 0', () => {
    expect(minutesToSeconds(0)).toBe(0);
    expect(minutesToSeconds(-5)).toBe(0);
    expect(minutesToSeconds(NaN)).toBe(0);
  });
  it('converts seconds back to minutes (2dp), empty -> 0', () => {
    expect(secondsToMinutes(1800)).toBe(30);
    expect(secondsToMinutes(750)).toBe(12.5);
    expect(secondsToMinutes(undefined)).toBe(0);
  });
});

describe('nextSet', () => {
  it('clones reps/weight for strength', () => {
    const last: SetLog = { reps: 8, weight: 40, done: true };
    expect(nextSet(last, 'strength')).toEqual({ reps: 8, weight: 40, done: false });
  });
  it('clones incline/speed/time for cardio', () => {
    const last: SetLog = { reps: 0, weight: 0, done: true, inclinePct: 2, speedKmh: 8, durationSec: 600 };
    expect(nextSet(last, 'cardio')).toEqual({
      reps: 0, weight: 0, done: false, inclinePct: 2, speedKmh: 8, durationSec: 600,
    });
  });
  it('uses defaults when there is no previous set', () => {
    expect(nextSet(undefined, 'cardio')).toEqual({
      reps: 0, weight: 0, done: false, inclinePct: 0, speedKmh: 6, durationSec: 1800,
    });
    expect(nextSet(undefined, 'strength')).toEqual({ reps: 10, weight: 0, done: false });
  });
});

describe('setsFromPlanExercise', () => {
  it('maps strength targets into N sets', () => {
    const pe: PlanExercise = { exerciseId: 'a', targetSets: 2, targetReps: 12, targetWeight: 50 };
    expect(setsFromPlanExercise(pe, 'strength')).toEqual([
      { reps: 12, weight: 50, done: false },
      { reps: 12, weight: 50, done: false },
    ]);
  });
  it('maps cardio targets into the first set (min one set)', () => {
    const pe: PlanExercise = { exerciseId: 'a', targetSets: 1, targetReps: 0, targetInclinePct: 1, targetSpeedKmh: 7, targetDurationSec: 1200 };
    expect(setsFromPlanExercise(pe, 'cardio')).toEqual([
      { reps: 0, weight: 0, done: false, inclinePct: 1, speedKmh: 7, durationSec: 1200 },
    ]);
  });
});

describe('defaultPlanExercise', () => {
  it('strength default', () => {
    expect(defaultPlanExercise('a', 'strength')).toEqual({ exerciseId: 'a', targetSets: 3, targetReps: 10 });
  });
  it('cardio default', () => {
    expect(defaultPlanExercise('a', 'cardio')).toEqual({
      exerciseId: 'a', targetSets: 1, targetReps: 0, targetInclinePct: 0, targetSpeedKmh: 6, targetDurationSec: 1800,
    });
  });
});

describe('cardioSetSummary', () => {
  it('formats time/speed/incline', () => {
    const set: SetLog = { reps: 0, weight: 0, done: true, inclinePct: 2, speedKmh: 6, durationSec: 1800 };
    expect(cardioSetSummary(set)).toBe('30min · 6km/h · 2%');
  });
  it('tolerates missing fields', () => {
    expect(cardioSetSummary({ reps: 0, weight: 0, done: true })).toBe('0min · 0km/h · 0%');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cardio.test.ts`
Expected: FAIL — `Failed to resolve import "./cardio"`.

- [ ] **Step 3: Implement `src/cardio.ts`**

Create `src/cardio.ts`:

```ts
import type { CustomExercise, PlanExercise, SetLog } from './db';

export type ExerciseKind = 'strength' | 'cardio';

const CARDIO_DEFAULTS = { inclinePct: 0, speedKmh: 6, durationSec: 1800 } as const;

/** Single read path for an exercise's modality; absent kind => strength. */
export function exerciseKind(ex: Pick<CustomExercise, 'kind'> | undefined | null): ExerciseKind {
  return ex?.kind === 'cardio' ? 'cardio' : 'strength';
}

/** Decimal minutes -> whole seconds. Invalid/<=0 -> 0. */
export function minutesToSeconds(min: number): number {
  if (!Number.isFinite(min) || min <= 0) return 0;
  return Math.round(min * 60);
}

/** Seconds -> minutes rounded to 2dp. Missing/<=0 -> 0. */
export function secondsToMinutes(sec: number | undefined): number {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round((sec / 60) * 100) / 100;
}

/** Build the next logged set, carrying over the relevant fields by kind. */
export function nextSet(last: SetLog | undefined, kind: ExerciseKind): SetLog {
  if (kind === 'cardio') {
    return {
      reps: 0, weight: 0, done: false,
      inclinePct: last?.inclinePct ?? CARDIO_DEFAULTS.inclinePct,
      speedKmh: last?.speedKmh ?? CARDIO_DEFAULTS.speedKmh,
      durationSec: last?.durationSec ?? CARDIO_DEFAULTS.durationSec,
    };
  }
  return { reps: last?.reps ?? 10, weight: last?.weight ?? 0, done: false };
}

/** Seed a session's sets from a plan exercise's targets. */
export function setsFromPlanExercise(pe: PlanExercise, kind: ExerciseKind): SetLog[] {
  const count = Math.max(1, pe.targetSets);
  return Array.from({ length: count }, () =>
    kind === 'cardio'
      ? {
          reps: 0, weight: 0, done: false,
          inclinePct: pe.targetInclinePct ?? CARDIO_DEFAULTS.inclinePct,
          speedKmh: pe.targetSpeedKmh ?? CARDIO_DEFAULTS.speedKmh,
          durationSec: pe.targetDurationSec ?? CARDIO_DEFAULTS.durationSec,
        }
      : { reps: pe.targetReps, weight: pe.targetWeight ?? 0, done: false },
  );
}

/** Default plan-exercise row when adding to a plan. */
export function defaultPlanExercise(exId: string, kind: ExerciseKind): PlanExercise {
  return kind === 'cardio'
    ? {
        exerciseId: exId, targetSets: 1, targetReps: 0,
        targetInclinePct: CARDIO_DEFAULTS.inclinePct,
        targetSpeedKmh: CARDIO_DEFAULTS.speedKmh,
        targetDurationSec: CARDIO_DEFAULTS.durationSec,
      }
    : { exerciseId: exId, targetSets: 3, targetReps: 10 };
}

/** One-line history summary for a cardio set. Units are symbols (not i18n). */
export function cardioSetSummary(set: SetLog): string {
  return [
    `${secondsToMinutes(set.durationSec)}min`,
    `${set.speedKmh ?? 0}km/h`,
    `${set.inclinePct ?? 0}%`,
  ].join(' · ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/cardio.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/cardio.ts src/cardio.test.ts
git commit -m "cardio: pure helpers for kind, time conversion, set seeding"
```

---

### Task 3: Sync the `kind` column (`src/sync/mapping.ts`) — TDD

**Files:**
- Modify: `src/sync/mapping.ts:16-18` (exercises inbound whitelist)
- Test: `src/sync/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/sync/mapping.test.ts` (inside the existing top-level `describe`, or add a new one). It imports `fromServerRow`/`toServerRow` — reuse the file's existing imports from `'./mapping'`:

```ts
describe('exercise kind / is_global mapping', () => {
  it('keeps kind and drops server-only is_global on the way in', () => {
    const row = fromServerRow(
      { id: 'x', owner_id: 'o', name_en: 'Treadmill', muscle_group: 'cardio', kind: 'cardio', is_global: true },
      'exercises',
    );
    expect(row.kind).toBe('cardio');
    expect(row.isGlobal).toBeUndefined();
  });

  it('sends kind on the way out', () => {
    const out = toServerRow({ id: 'x', kind: 'cardio' });
    expect(out.kind).toBe('cardio');
  });
});
```

(If `fromServerRow`/`toServerRow` are not yet imported in this test file, add `import { fromServerRow, toServerRow } from './mapping';` at the top.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/sync/mapping.test.ts`
Expected: FAIL — `row.kind` is `undefined` because `kind` is not in the exercises whitelist.

- [ ] **Step 3: Add `kind` to the exercises whitelist**

In `src/sync/mapping.ts`, replace the `exercises:` set (`src/sync/mapping.ts:16-18`) with:

```ts
  exercises: new Set(['id', 'owner_id', 'name_en', 'name_zh', 'muscle_group',
                      'kind', 'equipment', 'instructions', 'image_path',
                      'created_at', 'updated_at', 'deleted_at']),
```

Note: `is_global` is intentionally omitted — it stays server-only and is dropped by the whitelist. `toServerRow` already passes `kind` through (it isn't a `CLIENT_ONLY_FIELD`), so no change is needed there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/sync/mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/mapping.ts src/sync/mapping.test.ts
git commit -m "sync: carry exercise kind inbound/outbound, drop is_global"
```

---

### Task 4: i18n cardio strings (`types.ts`, `en.ts`, `zh-Hant.ts`)

**Files:**
- Modify: `src/i18n/types.ts` (add `cardio` to the translations interface, after the `workout` block)
- Modify: `src/i18n/en.ts` (the `workout: { ... }` block opens ~`:89` and closes ~`:101`; insert after its closing `},`)
- Modify: `src/i18n/zh-Hant.ts` (matching block)

- [ ] **Step 1: Add the type**

In `src/i18n/types.ts`, immediately after the closing `}` of the `workout: { ... }` member, add:

```ts
  cardio: {
    incline: string;
    speed: string;
    time: string;
  };
```

- [ ] **Step 2: Add English strings**

In `src/i18n/en.ts`, immediately after the closing `},` of the `workout: { ... }` block, add:

```ts
  cardio: {
    incline: 'Incline (%)',
    speed: 'Speed (km/h)',
    time: 'Time (min)',
  },
```

- [ ] **Step 3: Add Traditional Chinese strings**

In `src/i18n/zh-Hant.ts`, in the matching position after its `workout` block, add:

```ts
  cardio: {
    incline: '坡度 (%)',
    speed: '速度 (km/h)',
    time: '時間 (分鐘)',
  },
```

- [ ] **Step 4: Typecheck + i18n parity test**

Run: `npx tsc -b --noEmit && npx vitest run src/test/i18n.test.tsx`
Expected: PASS. **TypeScript** is what enforces locale parity here — both `en` and `zh-Hant` are typed `: Translation`, so omitting `cardio` from either fails `tsc`. (Note: `i18n.test.tsx` only checks `appName` + `muscleGroup` labels, not full key-set equality, so don't rely on vitest alone to catch a missing key.)

- [ ] **Step 5: Commit**

```bash
git add src/i18n/types.ts src/i18n/en.ts src/i18n/zh-Hant.ts
git commit -m "i18n: cardio field labels (en + zh-Hant)"
```

---

### Task 5: Workout logger cardio rendering (`src/pages/Workout.tsx`)

Wire the helpers into the live logger: cardio-aware plan seeding, add-exercise, add-set, and the set-row grid.

**Files:**
- Modify: `src/pages/Workout.tsx` (import; lines 34-49, 72-80, 91-98; set-row block 144-216)

- [ ] **Step 1: Import the helpers**

Add to the imports near `src/pages/Workout.tsx:12`:

```ts
import { exerciseKind, nextSet, setsFromPlanExercise, secondsToMinutes, minutesToSeconds } from '../cardio';
```

- [ ] **Step 2: Cardio-aware plan→session seeding**

Replace the session-init block `src/pages/Workout.tsx:34-49` with (note the added `&& catalog` guard so the kind lookup is available):

```tsx
  if (session === null && (!planId || plan) && catalog) {
    setSession({
      planId: plan?.id,
      date,
      startedAt,
      exercises:
        plan?.exercises.map((pe) => ({
          exerciseId: pe.exerciseId,
          sets: setsFromPlanExercise(pe, exerciseKind(catalog.find((c) => c.id === pe.exerciseId))),
        })) ?? [],
    });
  }
```

The existing `if (!session || !catalog)` loading guard at `src/pages/Workout.tsx:57` already covers the case where `catalog` is still null.

- [ ] **Step 3: Cardio-aware `addSet`**

Replace `src/pages/Workout.tsx:72-80` with:

```tsx
  const addSet = (exIdx: number) => {
    setSession((s) => {
      if (!s) return s;
      const ex = s.exercises[exIdx];
      const kind = exerciseKind(findEx(ex.exerciseId));
      const last = ex.sets[ex.sets.length - 1];
      return { ...s, exercises: s.exercises.map((e, i) => (i === exIdx ? { ...e, sets: [...e.sets, nextSet(last, kind)] } : e)) };
    });
  };
```

- [ ] **Step 4: Cardio-aware `addExercise`**

Replace `src/pages/Workout.tsx:91-98` with:

```tsx
  const addExercise = (id: string) => {
    if (session.exercises.find((e) => e.exerciseId === id)) return;
    const kind = exerciseKind(findEx(id));
    setSession((s) => s && {
      ...s,
      exercises: [...s.exercises, { exerciseId: id, sets: [nextSet(undefined, kind)] }],
    });
    setPickerOpen(false);
  };
```

- [ ] **Step 5: Branch the set-row grid on kind**

In the exercise card render, find where `meta`/`name`/`img` are computed (around `src/pages/Workout.tsx:145-148`) and add a kind constant right after `const img = ...`:

```tsx
                  const kind = exerciseKind(meta);
```

Then replace the entire sets container `<div className="px-3 py-2"> ... </div>` (currently `src/pages/Workout.tsx:172-216`, the block holding the header grid, the `ex.sets.map(...)`, and the "add set" button) with this kind-branched version. The strength branch is the current markup unchanged; the cardio branch swaps weight/reps for incline/speed/time and uses a 6-column grid:

```tsx
              <div className="px-3 py-2">
                {kind === 'cardio' ? (
                  <>
                    <div className="grid grid-cols-[2rem_1fr_1fr_1fr_2.5rem_1.5rem] gap-2 items-center text-[10px] text-slate-400 uppercase tracking-wide mb-1">
                      <span>{t.workout.set}</span>
                      <span>{t.cardio.incline}</span>
                      <span>{t.cardio.speed}</span>
                      <span>{t.cardio.time}</span>
                      <span>{t.common.done}</span>
                      <span></span>
                    </div>
                    {ex.sets.map((s, setIdx) => (
                      <div key={setIdx} className="grid grid-cols-[2rem_1fr_1fr_1fr_2.5rem_1.5rem] gap-2 items-center py-1">
                        <span className="text-sm font-bold text-slate-400">{setIdx + 1}</span>
                        <input
                          type="number"
                          step={0.5}
                          value={s.inclinePct ?? 0}
                          onChange={(e) => updateSet(exIdx, setIdx, { inclinePct: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          step={0.1}
                          value={s.speedKmh ?? 0}
                          onChange={(e) => updateSet(exIdx, setIdx, { speedKmh: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          step={0.5}
                          value={secondsToMinutes(s.durationSec)}
                          onChange={(e) => updateSet(exIdx, setIdx, { durationSec: minutesToSeconds(Number(e.target.value)) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <button
                          onClick={() => updateSet(exIdx, setIdx, { done: !s.done })}
                          className={`rounded h-8 text-sm font-bold ${s.done ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                        >
                          {s.done ? '✓' : '○'}
                        </button>
                        <button
                          onClick={() => removeSet(exIdx, setIdx)}
                          className="text-slate-500 hover:text-rose-400 text-sm"
                        >
                          −
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-[2rem_1fr_1fr_2.5rem_1.5rem] gap-2 items-center text-[10px] text-slate-400 uppercase tracking-wide mb-1">
                      <span>{t.workout.set}</span>
                      <span>{t.workout.weightUnit}</span>
                      <span>{t.planEditor.reps}</span>
                      <span>{t.common.done}</span>
                      <span></span>
                    </div>
                    {ex.sets.map((s, setIdx) => (
                      <div key={setIdx} className="grid grid-cols-[2rem_1fr_1fr_2.5rem_1.5rem] gap-2 items-center py-1">
                        <span className="text-sm font-bold text-slate-400">{setIdx + 1}</span>
                        <input
                          type="number"
                          step={0.5}
                          value={s.weight}
                          onChange={(e) => updateSet(exIdx, setIdx, { weight: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <input
                          type="number"
                          value={s.reps}
                          onChange={(e) => updateSet(exIdx, setIdx, { reps: Number(e.target.value) })}
                          className={`w-full min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm ${s.done ? 'opacity-60' : ''}`}
                        />
                        <button
                          onClick={() => updateSet(exIdx, setIdx, { done: !s.done })}
                          className={`rounded h-8 text-sm font-bold ${s.done ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300'}`}
                        >
                          {s.done ? '✓' : '○'}
                        </button>
                        <button
                          onClick={() => removeSet(exIdx, setIdx)}
                          className="text-slate-500 hover:text-rose-400 text-sm"
                        >
                          −
                        </button>
                      </div>
                    ))}
                  </>
                )}
                <button
                  onClick={() => addSet(exIdx)}
                  className="w-full mt-1 py-1.5 border border-dashed border-slate-700 text-xs text-slate-400 rounded"
                >
                  {t.workout.addSet}
                </button>
              </div>
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Workout.tsx
git commit -m "workout: render incline/speed/time inputs for cardio exercises"
```

---

### Task 6: Plan editor cardio targets (`src/pages/PlanEditor.tsx`)

**Files:**
- Modify: `src/pages/PlanEditor.tsx` (import; `addExercise` 70-77; target grid 201-233)

- [ ] **Step 1: Import the helpers**

Add near the other imports (top of `src/pages/PlanEditor.tsx`):

```ts
import { exerciseKind, defaultPlanExercise, secondsToMinutes, minutesToSeconds } from '../cardio';
```

- [ ] **Step 2: Cardio-aware `addExercise`**

Replace `src/pages/PlanEditor.tsx:70-77` with:

```tsx
  const addExercise = (exId: string) => {
    if (planExercises.find((p) => p.exerciseId === exId)) return;
    const kind = exerciseKind(findEx(exId));
    setPlanExercises((arr) => [...arr, defaultPlanExercise(exId, kind)]);
    setPickerOpen(false);
  };
```

- [ ] **Step 3: Branch the target grid on kind**

Inside the `planExercises.map((pe) => { ... })` body, after `const img = ...` (around `src/pages/PlanEditor.tsx:167`), add:

```tsx
              const kind = exerciseKind(ex);
```

Then replace the target grid block `<div className="grid grid-cols-3 gap-2 text-xs"> ... </div>` (currently `src/pages/PlanEditor.tsx:201-233`) with:

```tsx
                  {kind === 'cardio' ? (
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <label className="text-slate-400 block">{t.cardio.incline}</label>
                        <input
                          type="number"
                          step={0.5}
                          value={pe.targetInclinePct ?? ''}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetInclinePct: e.target.value ? Number(e.target.value) : undefined })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-400 block">{t.cardio.speed}</label>
                        <input
                          type="number"
                          step={0.1}
                          value={pe.targetSpeedKmh ?? ''}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetSpeedKmh: e.target.value ? Number(e.target.value) : undefined })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-400 block">{t.cardio.time}</label>
                        <input
                          type="number"
                          step={0.5}
                          value={pe.targetDurationSec ? secondsToMinutes(pe.targetDurationSec) : ''}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetDurationSec: e.target.value ? minutesToSeconds(Number(e.target.value)) : undefined })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <label className="text-slate-400 block">{t.planEditor.sets}</label>
                        <input
                          type="number"
                          min={1}
                          value={pe.targetSets}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetSets: Number(e.target.value) })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-400 block">{t.planEditor.reps}</label>
                        <input
                          type="number"
                          min={1}
                          value={pe.targetReps}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetReps: Number(e.target.value) })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                      <div>
                        <label className="text-slate-400 block">{t.planEditor.weightKg}</label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={pe.targetWeight ?? ''}
                          onChange={(e) => updateExercise(pe.exerciseId, { targetWeight: e.target.value ? Number(e.target.value) : undefined })}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1"
                        />
                      </div>
                    </div>
                  )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/PlanEditor.tsx
git commit -m "plan-editor: incline/speed/time targets for cardio exercises"
```

---

### Task 7: Home history cardio summary (`src/pages/Home.tsx`)

**Files:**
- Modify: `src/pages/Home.tsx` (import; session-summary map 152-171)

- [ ] **Step 1: Import the helpers**

Add to the imports at the top of `src/pages/Home.tsx`:

```ts
import { exerciseKind, cardioSetSummary } from '../cardio';
```

- [ ] **Step 2: Make the per-set summary cardio-aware**

In the `s.exercises.map((ex, idx) => { ... })` body, after `const meta = catalog?.find((c) => c.id === ex.exerciseId);` (`src/pages/Home.tsx:153`), add:

```tsx
                          const kind = exerciseKind(meta);
```

Then replace the `doneSets.map(...)` expression (`src/pages/Home.tsx:166-170`) with:

```tsx
                                  {doneSets
                                    .map((set) => kind === 'cardio'
                                      ? cardioSetSummary(set)
                                      : set.weight > 0
                                        ? `${set.reps}×${set.weight}${t.workout.weightUnit}`
                                        : `${set.reps}`)
                                    .join(' · ')}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Home.tsx
git commit -m "home: cardio-aware set summary in workout history"
```

---

### Task 8: DB migration — kind column, global RLS, seed Treadmill (`supabase/migrations/0014_cardio_and_treadmill.sql`)

This is server SQL; there is no Vitest coverage (the fake Supabase in tests does not enforce RLS — see the note atop `src/test/roundtrip.test.ts`). Verification is by review and, if a local Supabase is available, applying it.

**Files:**
- Create: `supabase/migrations/0014_cardio_and_treadmill.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0014_cardio_and_treadmill.sql`:

```sql
-- 0014_cardio_and_treadmill.sql
--
-- Adds a cardio exercise modality and a default, globally-readable
-- Treadmill so every user can plan/log/share it. Treadmill is a real
-- exercises row (not a client constant) because plan_exercises (trigger,
-- 0002:113-115), favorites (0002:93) and exercise_bundle_items (0002:47)
-- all `references exercises(id)` with a uuid cast — a client-only id would
-- fail those FKs.
--
-- See docs/superpowers/specs/2026-05-31-cardio-exercises-treadmill-design.md

-- 1. Modality column; existing + custom rows default to strength.
alter table exercises
  add column if not exists kind text not null default 'strength'
    check (kind in ('strength', 'cardio'));

-- 2. Global-visibility flag (server-only; never synced to clients).
alter table exercises
  add column if not exists is_global boolean not null default false;

-- 3. Widen the read policy to expose global rows. Owner + share clauses
--    are copied verbatim from 0002:160-179; only the is_global line is new.
drop policy if exists exercises_read on exercises;
create policy exercises_read on exercises for select using (
  owner_id = auth.uid()
  or exercises.is_global
  or exists (
    select 1 from shares s
    where s.deleted_at is null
      and s.recipient_id = auth.uid()
      and s.resource_type = 'exercise'
      and s.resource_id = exercises.id
      and public.has_accepted_designation(s.granter_id, auth.uid())
  )
  or exists (
    select 1 from shares s
    join exercise_bundle_items i on i.bundle_id = s.resource_id
    where s.deleted_at is null
      and s.recipient_id = auth.uid()
      and s.resource_type = 'bundle'
      and i.exercise_id = exercises.id
      and public.has_accepted_designation(s.granter_id, auth.uid())
  )
);

-- 4. Seed the default Treadmill (fixed UUID so the id is stable across
--    environments), owned by the first admin per 0013. Idempotent.
insert into exercises (id, owner_id, name_en, name_zh, muscle_group, kind, is_global)
select '11111111-1111-4111-8111-111111111111',
       p.id, 'Treadmill', '跑步機', 'cardio', 'cardio', true
  from profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'leo@reslv.io'
on conflict (id) do nothing;
```

- [ ] **Step 2: Review against the original policy**

Run: `git show HEAD:supabase/migrations/0002_custom_exercises.sql | sed -n '160,181p'`
Expected: the printed `exercises_read` clauses match the owner/share clauses reproduced above (so the only behavioural change is the added `or exercises.is_global`). `exercises_write` stays owner-only — confirm it is NOT modified here.

- [ ] **Step 3 (optional, only if a local Supabase is configured): apply it**

Run: `supabase db reset` (or `supabase migration up`)
Expected: migration applies cleanly; `select kind, is_global from exercises where id = '11111111-1111-4111-8111-111111111111';` returns `cardio | t`. If no local Supabase exists, skip — the migration runs on deploy.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0014_cardio_and_treadmill.sql
git commit -m "migration 0014: cardio kind + global Treadmill seed"
```

---

### Task 9: Version bump + full verification

**Files:**
- Modify: `package.json` (`version`)

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.2.1"` to `"version": "0.2.2"`.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: PASS (new `cardio.test.ts`, updated `mapping.test.ts`, and all existing suites green).

- [ ] **Step 4: Production build (compiles Tailwind, catches arbitrary-class issues)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "release: 0.2.2 — cardio exercises + default Treadmill"
```

---

## Self-review notes (coverage check vs spec)

- **kind column + is_global + RLS + seed** → Task 8. **kind synced / is_global server-only** → Task 3.
- **SetLog / PlanExercise cardio fields (jsonb, no migration)** → Task 1.
- **`exerciseKind` single read path, no `useCatalog`/built-in constant** → Task 2 (Treadmill flows through `useExercises()` as a normal pulled row).
- **Workout: cardio inputs, `addSet` clone (review gap #4), `addExercise` defaults, plan→session seeding** → Task 5.
- **PlanEditor cardio targets** → Task 6.
- **Home cardio summary + name resolution** → Task 7 (name resolution already works since Treadmill is in `db.exercises`).
- **i18n** → Task 4. **Version bump** → Task 9.
- **Metrics.tsx** → no change needed (body metrics only; confirmed in spec).
- Units in summaries are hardcoded symbols (`min`/`km/h`/`%`), identical across locales; only the editor field *labels* are translated. Consistent across Tasks 2/4/5/6/7.
