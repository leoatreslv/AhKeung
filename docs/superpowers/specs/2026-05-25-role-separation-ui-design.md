# Role separation UI — design spec

**Status:** draft, awaiting review
**Date:** 2026-05-25
**Author:** Leo (brainstormed with Claude)

## Problem

Today the app has one role flag (`profiles.is_trainer`) and a single shared shell. Trainer-only features are tucked inside Settings as a "Trainer tools" grid. A single user routinely holds multiple roles (Leo is simultaneously a trainer to Shadow and a trainee to others), and there is no way to context-switch — the same shell tries to serve every role at once. This is muddy for users and will get muddier when we introduce a third role.

We want:

1. A new **Admin** role that owns invitation power (today held by any trainer).
2. A UI that **clearly separates** the three roles (Trainee, Trainer, Admin) while still allowing one login to carry all three.

## Goals

- A user with one role sees a focused, single-mode UI (no clutter).
- A user with multiple roles can switch between modes cheaply and remember their preference.
- Admin owns invites, trainer-promotion, and audit visibility. Trainers can no longer invite or promote.
- Schema migration is forward-only and additive at the column level. Several RLS policies are rewritten (not just added) — see the migration body for the exact list. A rollback would require replaying the prior policy definitions from 0001/0004/0006/0008, not just dropping the new column.

## Non-goals

- Per-role email-template customization.
- Admin dashboard with counts/charts (admins get 3 functional tabs, not a stats overview).
- Soft-deleting admins or transfer-of-ownership flows.
- Hard URL-prefix split (`/trainee/*` etc.) — routes stay flat; gating happens via a `ModeGate` wrapper.
- Pure trainees are unaffected — no UX changes for the common case.

## Design overview

```
┌─────────────────────────────────────────────────┐
│ Header: logo · greeting · [ModeSwitcher] · ⚙   │  ← border tinted by active mode
├─────────────────────────────────────────────────┤
│                                                 │
│   Active mode's pages (routes wrapped in        │
│   ModeGate so direct URLs respect the mode)     │
│                                                 │
├─────────────────────────────────────────────────┤
│  Bottom nav: tabs from NAV_BY_MODE[mode]       │
└─────────────────────────────────────────────────┘
```

Three modes, each with its own bottom nav. A single header + cog (Settings) sits above. A `RoleMode` context tracks the active mode; the Shell reads it to pick nav tabs; routes are gated.

## Data model & permissions (migration 0013)

### Migration `0013_admin_role.sql`

All policy and function names below are verified against the current migrations 0001–0012.

```sql
-- 1. Column
alter table profiles
  add column is_admin boolean not null default false;

-- 2. Seed Leo as the first admin.
--    Lookup by email is safer than a hardcoded uuid in source: it survives
--    auth.users.id regeneration across environments, and is verifiable by
--    eye. The `lower()` match is paranoid; current email is leo@reslv.io.
--    BEFORE APPLYING: confirm the row exists and is yours:
--      select p.id, u.email from profiles p
--        join auth.users u on u.id = p.id
--       where lower(u.email) = 'leo@reslv.io';
update profiles p
   set is_admin = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'leo@reslv.io';

-- 3. Helper, mirrors is_trainer() defined in 0001.
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select is_admin from profiles where id = auth.uid()), false)
  $$;
revoke execute on function public.is_admin() from public;
grant  execute on function public.is_admin() to authenticated;

-- 4. Tighten profiles_write so is_admin cannot be self-flipped.
--    Replaces the policy 0004 created (which already forbade self-flipping
--    is_trainer); we just add the is_admin column to the same guard.
drop policy if exists "profiles_write" on profiles;
create policy "profiles_write" on profiles for update
  using  (id = auth.uid())
  with check (
    id = auth.uid()
    and is_trainer = (select is_trainer from profiles where id = auth.uid())
    and is_admin   = (select is_admin   from profiles where id = auth.uid())
  );

-- 5. profiles_read gains admin visibility (needed for AdminUsers search).
--    Replaces 0001's policy. Trainer read is preserved (used by
--    MyTrainees' search and by the trainer-RLS reads of trainee data).
drop policy if exists "profiles_read" on profiles;
create policy "profiles_read" on profiles for select
  using (id = auth.uid() OR public.is_trainer() OR public.is_admin());

-- 6. promote_to_trainer RPC: guard swap is_trainer -> is_admin.
--    CRITICAL: preserves the trainer.promoted audit emit from 0008. The
--    previous reviewer flagged that an earlier draft of this spec lost
--    the audit call by rewriting only the guard.
create or replace function public.promote_to_trainer(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins may promote users to trainer';
  end if;
  update profiles set is_trainer = true where id = target;
  perform public.emit_audit_event(
    auth.uid(),
    'trainer.promoted',
    jsonb_build_object('type', 'profile', 'id', target),
    jsonb_build_object('promoter', auth.uid(), 'promoted', target)
  );
end $$;

-- CREATE OR REPLACE FUNCTION does not reset grants, so the existing
-- grant from 0004:30-31 (`grant execute on ... to authenticated`) is
-- preserved. Re-declaring it here is a no-op but makes the spec
-- explicit and protects against future migrations that recreate the
-- function in a way that does reset grants.
revoke execute on function public.promote_to_trainer(uuid) from public;
grant  execute on function public.promote_to_trainer(uuid) to authenticated;

-- 7. New: promote_to_admin RPC (admin-only), with matching audit emit.
create or replace function public.promote_to_admin(target uuid)
  returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'only admins may promote users to admin';
  end if;
  update profiles set is_admin = true where id = target;
  perform public.emit_audit_event(
    auth.uid(),
    'admin.promoted',
    jsonb_build_object('type', 'profile', 'id', target),
    jsonb_build_object('promoter', auth.uid(), 'promoted', target)
  );
end $$;
revoke execute on function public.promote_to_admin(uuid) from public;
grant  execute on function public.promote_to_admin(uuid) to authenticated;

-- 8. Invitations policies. Both must be rewritten:
--    - 0006 defined invitations_read_inviter (inviter sees own rows) and
--      invitations_cancel_inviter (inviter can UPDATE own rows). The
--      cancel policy is paired with a column-level grant on cancelled_at.
--    - We widen READ to admin so AdminInvites lists all invitations.
--    - We replace cancel with an admin-only UPDATE policy. The existing
--      column-level grant on cancelled_at remains — cancel is still the
--      only column an authenticated caller may update (admins included).
--      Resend is a re-invocation of invite-user (Edge Function), not an
--      UPDATE, so column-level scope stays correct.
drop policy if exists "invitations_read_inviter" on invitations;
create policy "invitations_read" on invitations for select
  using (inviter_id = auth.uid() OR public.is_admin());

drop policy if exists "invitations_cancel_inviter" on invitations;
create policy "invitations_cancel_admin" on invitations for update
  using (public.is_admin()) with check (public.is_admin());

-- (The 0006 column grants stay as-is: cancelled_at is the only writable
--  column for `authenticated`; service_role bypasses both.)

-- 9. audit_events read: keep the existing trainer-of-accepted-designation
--    clause AND add admin. Earlier draft of this spec stripped the
--    trainer clause by accident — call out: trainers retain read access
--    to audit_events for their accepted trainees.
drop policy if exists audit_events_read on audit_events;
create policy audit_events_read on audit_events for select using (
  user_id = auth.uid()
  or public.is_admin()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = audit_events.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);

-- 10. designate_invited_user RPC dropped. Lineage: introduced in
--     0011, redefined in 0012 to also stamp invitations.designated_at
--     on the ON CONFLICT path. Inserts trainer_trainees with
--     caller=trainer_id, which would be wrong if an admin called it
--     (they'd become the trainee's trainer). Two options considered:
--       (a) drop the RPC entirely and remove the "Designate from
--           invitation" path; admin sees an informational "awaiting
--           designation" list, trainer designates via search only.
--       (b) keep but rework the signature to accept a target trainer_id.
--     The spec picks (a) — simpler, removes a dead path, and surfaces
--     orphaned invitees as an actionable signal for admin to ping a
--     trainer. The trainer's existing search-based designation flow in
--     MyTrainees (preserved) still triggers the 0012 AFTER INSERT
--     trigger to stamp invitations.designated_at, so that bookkeeping
--     is not lost.
drop function if exists public.designate_invited_user(uuid);
```

**Triggers verified unaffected:** `0010` (`mark_invitation_accepted` on `auth.users INSERT`), `0012` (`trainer_trainees_mark_invitation_designated` AFTER INSERT), `0008` audit triggers, and the `cascade_exercise_soft_delete` trigger from 0004 all key off columns the spec does not touch.

**`handle_new_user()` (0001:69-79):** still inserts `(id, display_name, is_trainer)` only — new `is_admin` column picks up its `default false`. The trigger is not rewritten in this migration; new signups land with `is_admin = false`, which is correct. If we ever want admins seeded programmatically (e.g. via `raw_user_meta_data.bootstrap_admin`), update the trigger in a follow-up migration.

**Audit attribution after admin-only invites:** `audit_invitations_insert` (0008:95-108) and `audit_invitations_update` (0008:115-140) both stamp `inviter_id` as the audit actor. Post-migration, every `inviter_id` is the admin's id (since only admins can INSERT into `invitations` via the Edge Function). This is intentional and correct — the admin *is* the inviter — but it does mean historical "which trainer originally surfaced this user" cannot be reconstructed from `audit_events` alone. If we want that link, store it in `invitations.metadata` at invite time. Out of scope for this spec; documented here so it's a conscious choice.

### Edge function `invite-user`

The role check inside `supabase/functions/invite-user/index.ts` (the `userClient.rpc('is_trainer')` call at lines 91–92) changes from `'is_trainer'` to `'is_admin'`. Behavior unchanged for the recipient — they still land as a plain trainee (`is_trainer=false`, `is_admin=false`). The doc-comment at line 5 — `// - Verifies caller is a trainer (JWT + is_trainer RPC).` — gets reworded to admin alongside.

### Client sync + Profile shape

- `src/sync/mapping.ts` — add `is_admin` to the `profiles` allowlist so the pull worker hydrates it.
- `src/auth/useAuth.ts` — `interface Profile { isAdmin: boolean }` added.
- `src/auth/AuthProvider.tsx`:
  - Line 25 `select('id, display_name, is_trainer')` → `select('id, display_name, is_trainer, is_admin')`.
  - Line 34 mapper picks up `isAdmin: row.is_admin`.
  - **Cache hydration (line 164–167):** the cached profile in `localStorage['ahKeung.lastKnownProfile']` was written under the old shape and will be missing `isAdmin` when an existing user boots offline after this deploy. Read path must default the missing field: `profile = { ...parsed, isAdmin: parsed.isAdmin ?? false }`. Equivalent: bump the cache key to `'ahKeung.lastKnownProfile.v2'` so stale caches are ignored. Either approach is fine; prefer the defaulting one (no UX hit for the brief window between deploy and next online fetch).

### Other client call sites touched by the migration

These were missed in the first draft of this spec; the second review flagged them. None changes its own logic, but each needs a small update so it stays consistent with the new role split.

- **`src/sharing.ts`** — `promoteToTrainer` helper (lines 75–83) stays; the only caller in the new world is `AdminUsers`. Update its doc-comment ("Callable only by trainers" → "Callable only by admins"). No code change in the function body — the new RPC guard does the enforcement.
- **`src/useIsTrainer.ts`** — module-level hook stays (still a general utility). Its consumer migrates from `MyTrainees`' `PromoteButton` to `AdminUsers`' row promote action.
- **`src/pages/MyTrainees.tsx`** — strip:
  - The invite UI block + `inviteByEmail` / `cancelInvitation` imports (moves to `AdminInvites`).
  - The `PromoteButton` component + its `useIsTrainer` / `setIsTrainerCache` imports (moves to `AdminUsers`).
  - The invitation-list section that called `designateInvitedUser` (RPC dropped; trainer designates only via search).
- **`src/invitations.ts`** — delete the `designateInvitedUser` export at lines 41–56. The server-side RPC is dropped (see migration 0013); leaving the client export creates dead code that would hit "function does not exist" if invoked. Re-export of `inviteByEmail` and `cancelInvitation` stays.
- **`src/test/invitations.test.ts`** — remove the tests that exercise `designateInvitedUser` (they import from `src/invitations.ts` directly and call the now-deleted helper / dropped RPC). Keep the tests for `inviteByEmail` and `cancelInvitation`.
- **`src/pages/MyExercises.tsx` (line 31)**, **`src/pages/MyBundles.tsx` (line 43)**, **`src/pages/PlanEditor.tsx` (line 253)** — each currently gates on `profile.isTrainer`. With `ModeGate` wrapping these routes in trainer mode, the inner gate becomes belt-and-suspenders. Keep them — defense in depth — and verify each renders the same "not a trainer yet" fallback as today when accessed off-mode (e.g. by a future deep-link).
- **`src/useInvitations.ts`** — header doc-comment (lines 1–9) currently says "trainer's outbound invitations". Reword to "admin's outbound invitations". The query filter `inviter_id = userId` is correct as-is because the inviter is now the admin user.
- **`src/i18n/` (both `en` and `zh-Hant`)** — new strings (see Localization). Also: any string keyed under "trainer" that's actually about an admin action gets relabeled.

### Test stubs

The reviewer flagged that several test files build stub profiles without `isAdmin`. After the `Profile` shape changes, TypeScript will catch most of these, but the stub helpers still need explicit support:

- `src/test/fakeSupabase.ts:216` — default profile insert: add `is_admin: false` to the row literal.
- `src/test/fakeSupabase.ts:222–224` — `setTrainer(userId, isTrainer)` helper: add a mirror `setAdmin(userId, isAdmin)` immediately after, writing `p.is_admin = isAdmin`.
- `src/test/authStub.ts:8` — `Opts` interface gains `isAdmin?: boolean`.
- `src/test/authStub.ts:12` — add `if (opts.isAdmin) fake.setAdmin(opts.id, true);` right after the existing `if (opts.isTrainer)` line.
- `src/test/invitations.test.ts`, `src/test/sharing.test.tsx`, `src/test/exerciseEditor.test.tsx`, `src/test/roundtrip.test.ts`, `src/sync/imageUploadSweep.test.ts` — wherever a stub profile is built, decide whether the test asserts admin behavior. Default to `isAdmin: false` unless it does.

### RLS / migration tests

- A non-admin caller hitting `invite-user` Edge Function gets 403.
- A trainer caller hitting `promote_to_trainer` RPC raises "only admins may promote".
- A trainee caller hitting `promote_to_admin` raises "only admins".
- A trainer can still `select` from `profiles` (existing trainer behavior) but cannot `update invitations`.
- **Regression test (new):** a trainer with an `accepted` `trainer_trainees` row for a trainee can still `select` from `audit_events` where `user_id` is that trainee. (Guards against accidentally dropping the trainer-clause in the `audit_events_read` policy rewrite.)
- An admin can `select` every row in `profiles`, `invitations`, and `audit_events`.
- The `designate_invited_user` RPC no longer exists (`select to_regprocedure('public.designate_invited_user(uuid)')` returns NULL).

## Shell architecture

### `src/auth/RoleMode.tsx` (new)

```ts
type Mode = 'trainee' | 'trainer' | 'admin';

interface RoleModeContext {
  mode: Mode;
  availableModes: Mode[];   // ['trainee'] | ['trainee','trainer'] | ['trainee','trainer','admin'] | ['trainee','admin']
  setMode: (m: Mode) => void;          // explicit user action (ModeSwitcher) — persists to localStorage
  setModeTransient: (m: Mode) => void; // implicit re-routing (ModeGate) — in-memory only, no persistence
}

const STORAGE_KEY = 'ahkeung:roleMode';
```

**Provider behavior:**

- `availableModes` derived from `profile.isTrainer` and `profile.isAdmin`. `'trainee'` is always present. Recomputed on every render (cheap — two booleans).
- Initial mode: read `localStorage[STORAGE_KEY]`; if missing or not in `availableModes`, fall back to `'trainee'`.
- `setMode(m)` updates state and writes to localStorage. If `m ∉ availableModes`, no-op.
- `setModeTransient(m)` updates state only (no localStorage write). If `m ∉ availableModes`, no-op. Used by `ModeGate` so deep-linking into another mode doesn't quietly change the user's saved preference.
- **Mid-session role change:** an `useEffect` watches `availableModes`. If the active `mode` is no longer in `availableModes` (e.g. an admin demoted you while you were in admin mode and a pull-sync brought the new profile down), reset `mode` to `'trainee'` and clear the localStorage key. Avoids a stuck state where the user is "in" a mode they no longer have permission for and `ModeGate` redirects every page.
- Mounted inside `<Guarded>` above `<Shell>` — only available when `fullyReady`.

### `src/components/ModeSwitcher.tsx` (new)

Three-pill segment control in the header, between greeting and cog. Hidden if `availableModes.length === 1`.

```
[ 👤 Trainee | 🏋️ Trainer | 🛡️ Admin ]
```

Active pill filled keung-green; inactive pills slate-700. Tapping a pill calls `setMode` **and then `navigate(DEFAULT_ROUTE_BY_MODE[m])`** — so the user lands on a sensible page for that mode rather than getting an immediate `ModeGate` redirect. `DEFAULT_ROUTE_BY_MODE = { trainee: '/', trainer: '/trainer', admin: '/admin/invites' }`. No dropdown. Each pill rendered only if that mode is in `availableModes`.

**Known limitation:** switching modes while inside an editor (`PlanEditor`, `ExerciseEditor`, `BundleEditor`) discards unsaved changes silently — same as today's behavior when tapping a bottom-nav tab mid-edit. No unsaved-changes guard exists in the codebase yet; adding one is out of scope for this spec. Listed under Risks.

### `src/components/ModeGate.tsx` (new)

Wraps a route element:

```tsx
<ModeGate allowedIn={['trainer']}>
  <MyTrainees />
</ModeGate>
```

Behavior:
- If `mode ∈ allowedIn` → render children.
- Else if any mode in `allowedIn` is in `availableModes` → call `setModeTransient` (NOT `setMode`) with the first matching mode and re-render. The new `setModeTransient` is a sibling on the context that updates state **without writing to localStorage** — so a deep link (tutorial / screenshot / saved bookmark in a different mode) does not silently mutate the user's saved mode preference. Persistence is reserved for explicit `ModeSwitcher` taps.
- Else → `<Navigate to="/" replace />`.

The `RoleModeContext` therefore exposes both `setMode` (persistent, called by the switcher) and `setModeTransient` (in-memory only, called by `ModeGate`):

```ts
interface RoleModeContext {
  mode: Mode;
  availableModes: Mode[];
  setMode: (m: Mode) => void;          // writes localStorage
  setModeTransient: (m: Mode) => void; // does not write localStorage
}
```

### `src/App.tsx` modifications

- `Guarded` now wraps `<RoleModeProvider><Shell /></RoleModeProvider>`.
- Shell pulls `mode` from `useRoleMode()`.
- Bottom nav reads `NAV_BY_MODE[mode]` — an array of `{ to, icon, label, end? }` per mode. Each `TabLink` is unchanged.
- Header bottom-border CSS: `border-slate-800` (trainee, current) | `border-keung-600/60` (trainer) | `border-amber-600/60` (admin). Tiny visual cue, no extra chrome.
- `<Routes>` body: each route element wrapped in `<ModeGate allowedIn={...}>` according to the table below.

### Routes & gating

| Route | Element | `allowedIn` |
|---|---|---|
| `/` | `Home` | `['trainee']` |
| `/plans`, `/plans/new`, `/plans/:id` | `Plans`, `PlanEditor` | `['trainee']` |
| `/workout`, `/workout/:planId` | `Workout` | `['trainee']` |
| `/library` | `Library` | `['trainee']` |
| `/metrics` | `Metrics` | `['trainee']` |
| `/trainer` | `TrainerDashboard` | `['trainer']` |
| `/trainer/trainees` | `MyTrainees` | `['trainer']` |
| `/trainer/exercises`, `/trainer/exercises/new`, `/trainer/exercises/:id` | `MyExercises`, `ExerciseEditor` | `['trainer']` |
| `/trainer/bundles`, `/trainer/bundles/new`, `/trainer/bundles/:id` | `MyBundles`, `BundleEditor` | `['trainer']` |
| `/admin/invites` | `AdminInvites` | `['admin']` |
| `/admin/users` | `AdminUsers` | `['admin']` |
| `/admin/audit` | `AdminAudit` | `['admin']` |
| `/settings` | `Settings` | `['trainee','trainer','admin']` (always reachable) |

Legacy URL redirects (so saved bookmarks don't 404):
- `/exercises` → `/trainer/exercises`
- `/exercises/new` → `/trainer/exercises/new`
- `/exercises/:id` → `/trainer/exercises/:id`
- `/bundles` → `/trainer/bundles`
- `/bundles/new` → `/trainer/bundles/new`
- `/bundles/:id` → `/trainer/bundles/:id`
- `/trainees` → `/trainer/trainees`

**In-app callers using old paths must be rewritten in the same PR** (otherwise every click would silently bounce through a legacy redirect AND through ModeGate auto-switch). These were missed in the first draft:

| File | Line | Old | New |
|---|---|---|---|
| `src/pages/Settings.tsx` | 105 | `to="/exercises"` | (grid is removed — see Settings section) |
| `src/pages/Settings.tsx` | 112 | `to="/bundles"` | (grid is removed) |
| `src/pages/Settings.tsx` | 119 | `to="/trainees"` | (grid is removed) |
| `src/pages/MyExercises.tsx` | 49 | `to="/exercises/new"` | `to="/trainer/exercises/new"` |
| `src/pages/MyBundles.tsx` | 61 | `to="/bundles/new"` | `to="/trainer/bundles/new"` |
| `src/pages/ExerciseEditor.tsx` | 104, 121, 128 | `navigate('/exercises')` | `navigate('/trainer/exercises')` |
| `src/pages/BundleEditor.tsx` | 97, 111, 118 | `navigate('/bundles')` | `navigate('/trainer/bundles')` |

(Verified with `grep "to=\"/exercises\"\|to=\"/bundles\"\|to=\"/trainees\"\|navigate('/exercises\|navigate('/bundles\|navigate('/trainees"` over `src/`.) Legacy URL redirects remain as a safety net for external bookmarks, but in-app navigation goes direct to the new paths.

## Per-mode page inventory

### Trainee mode (default)

| Tab | Route | Page |
|---|---|---|
| 🏠 Home | `/` | `Home` (with `DesignationBanner` at top — unchanged) |
| 📋 Plans | `/plans` | `Plans` |
| 📚 Library | `/library` | `Library` |
| 📈 Metrics | `/metrics` | `Metrics` |

Identical to today. Pure trainees see zero change.

### Trainer mode

Tab order (left → right) matches the option you approved in brainstorming. **Default landing** when switching into trainer mode: `/trainer` (Dashboard), regardless of tab position.

| Tab | Route | Page |
|---|---|---|
| 👥 Trainees | `/trainer/trainees` | `MyTrainees` (invite UI removed) |
| 🏋️ Exercises | `/trainer/exercises` | `MyExercises` |
| 📦 Bundles | `/trainer/bundles` | `MyBundles` |
| 🏠 Dashboard | `/trainer` | `TrainerDashboard` (new) |

**`TrainerDashboard` (new):**

- "Pending designations" section: list of `trainer_trainees` rows where `trainer_id = me AND status = 'pending'`, with trainee name + `designatedAt`. Tap → links to `/trainer/trainees`.
- "Recent trainee activity": trainees with `sessions` updated in the last 7 days. Tap → opens that trainee's profile (reuses existing trainee-detail surface, if any; otherwise links to their plans list).
- Quick action: "+ Designate a user" button → `/trainer/trainees?focus=search` (Trainees page reads the query param and auto-focuses the search input).

**`MyTrainees` refactor:**

- Strip the invitation section entirely (pending invitations, accepted-needing-designation, "+ Designate from invitation" button). Drop the `inviteByEmail` / `cancelInvitation` / `designateInvitedUser` imports.
- Strip the inline `PromoteButton` component + its `useIsTrainer` / `setIsTrainerCache` imports. Promotion moves to `AdminUsers`.
- Keep: search-by-display-name (`getSupabase().from('profiles').ilike(...)`), designate, undesignate, partition by status (pending/accepted/declined).
- Add the `?focus=search` query-param hook for the dashboard's quick-action.

### Admin mode

**Default landing** when switching into admin mode: `/admin/invites`.

| Tab | Route | Page |
|---|---|---|
| ✉️ Invites | `/admin/invites` | `AdminInvites` (new) |
| 👤 Users | `/admin/users` | `AdminUsers` (new) |
| 📜 Audit | `/admin/audit` | `AdminAudit` (new) |

**`AdminInvites` (new):**

- **Send**: email input + `inviteByEmail` call (helper unchanged, just relocated from `MyTrainees`).
- **Pending**: `invitations` rows with `accepted_at IS NULL AND cancelled_at IS NULL`, sorted newest first. Per row: email, `created_at`, inviter name, [Resend] [Cancel]. Resend re-invokes `invite-user` with the same email; cancel calls `cancelInvitation` (which UPDATEs `cancelled_at` — within the column-level grant from 0006).
- **Accepted, awaiting designation**: `accepted_at IS NOT NULL AND designated_at IS NULL AND cancelled_at IS NULL`. Per row: email, accepted timestamp, inviter name. **Read-only** — no action button. The matching trainer goes to their `MyTrainees` search and designates the user manually. (The old `designate_invited_user` RPC is dropped, because an admin-as-caller would have ended up as the trainee's trainer, which is wrong. Surfacing the orphan here is the actionable signal.)

**`AdminUsers` (new):**

- Search box (display name ILIKE, like the trainer's search).
- Result rows: avatar/initial, display name, email, badges (`Trainer`, `Admin`), action buttons:
  - "Promote to Trainer" (if `!isTrainer`) → `promote_to_trainer(id)` RPC via the existing `sharing.ts` helper (caller moves here from `MyTrainees`' `PromoteButton`).
  - "Promote to Admin" (if `!isAdmin`) → `promote_to_admin(id)` RPC.
- Both actions confirm via `window.confirm` before firing.
- After success, reuse the existing `useIsTrainer` cache write-through (`setIsTrainerCache(id, true)`) for trainer promotion. For admin promotion, refetch the local `profiles` Dexie row and update the badge — no dedicated `useIsAdmin` hook is needed (the AdminUsers row is the only consumer; the existing trainer hook only exists because PromoteButton was used in many places, which is no longer true). If we ever add multiple consumers, mirror the pattern: `useIsAdmin` reads `profiles.is_admin` directly via the now-widened `profiles_read` RLS (admins can read all profiles), not via a separate view like `trainer_names`.

**`AdminAudit` (new):**

- Paginated feed (50 per page) of `audit_events`, newest first.
- Filter chip row: `invite.*`, `designation.*`, `trainer.promoted`, `share.*`, `sync.dead_letter`. Multi-select.
- Each row: timestamp, actor (resolved to display name via `useDisplayName`), event_type, one-line resource summary. Tap to expand the full `resource` + `metadata` JSON.

### Settings (cross-mode)

Two precise rewrites in `src/pages/Settings.tsx`:

- **Lines 76–80** (single `Trainer` badge pill in the header row) → replace with the new role badge stack: `Trainee` (always shown, slate) + `Trainer` (if `isTrainer`, keung-green) + `Admin` (if `isAdmin`, amber). Same chip style as today, just multiple chips.
- **Lines 100–127** (the `profile?.isTrainer && (...)` block containing the "Trainer tools" grid linking to `/exercises`, `/bundles`, `/trainees`) → delete entirely. Those pages now live in the trainer-mode bottom nav; reaching them via Settings is redundant.

Everything else in Settings is unchanged: display name editor, Your Trainers list, Change Password, Diagnostics, Sign Out. Page stays accessible from any mode via the cog in the header.

## Localization

New i18n strings (both `en` and `zh-Hant`):

- `modeSwitcher.trainee`, `modeSwitcher.trainer`, `modeSwitcher.admin`
- `tabs.trainerDashboard`, `tabs.trainerTrainees`, `tabs.trainerExercises`, `tabs.trainerBundles`
- `tabs.adminInvites`, `tabs.adminUsers`, `tabs.adminAudit`
- `trainerDashboard.pendingDesignations`, `trainerDashboard.recentActivity`, `trainerDashboard.designateButton`
- `adminInvites.sendSection`, `adminInvites.pendingSection`, `adminInvites.awaitingDesignationSection`, `adminInvites.resend`, `adminInvites.cancel`
- `adminUsers.promoteToTrainer`, `adminUsers.promoteToAdmin`, `adminUsers.confirmPromoteTrainer`, `adminUsers.confirmPromoteAdmin`, `adminUsers.promoted`
- `adminAudit.filters.*`, `adminAudit.empty`
- `settings.roleBadges.trainee`, `settings.roleBadges.trainer`, `settings.roleBadges.admin`

## Tests

### Unit
- `RoleMode` provider: stored mode honored; invalid stored mode falls back to `'trainee'`; `setMode` with mode not in `availableModes` is a no-op; **reactive reset when `availableModes` shrinks mid-session**.
- `ModeSwitcher` renders only when `availableModes.length > 1`; renders only the available pills; tapping a pill navigates to `DEFAULT_ROUTE_BY_MODE[m]`.
- `ModeGate` renders children when in-mode; auto-switches via `setModeTransient` (**asserts localStorage is NOT written** — guards against accidentally calling `setMode`) if any `allowedIn` is in `availableModes`; redirects `<Navigate to="/" replace />` when no `allowedIn` mode is available.
- `lastKnownProfile` cache rehydration: a v1-shaped cache (no `isAdmin` field) is read as `isAdmin: false` rather than crashing or returning `undefined`.
- `AdminUsers` promote buttons hit the right RPC and update local cache on success.
- `TrainerDashboard` lists the same pending designations that the old `MyTrainees` showed.

### Integration / RLS
- Trainer-only caller cannot invoke `invite-user` (403).
- Trainer-only caller cannot call `promote_to_trainer` (raises).
- Trainee-only caller cannot call `promote_to_admin` (raises).
- Admin caller can read every `profiles` row.
- Admin caller can read all `audit_events`.
- **Trainer with an `accepted` designation can still read that trainee's `audit_events`** (regression guard for the policy rewrite).
- Admin can UPDATE `invitations.cancelled_at` but cannot UPDATE other columns (column-level grant still enforces).
- `designate_invited_user(uuid)` is gone (verified via `to_regprocedure`).

### Migration test
- Apply 0013 to a fresh DB clone. Verify: `profiles.is_admin` column exists, defaults to `false`. After the seed UPDATE, exactly one row (matching `lower(email)='leo@reslv.io'`) has `is_admin = true`. The 5 policies that were rewritten (`profiles_write`, `profiles_read`, `audit_events_read`, plus `invitations_read_inviter` → `invitations_read` and `invitations_cancel_inviter` → `invitations_cancel_admin`) all exist with their new definitions; the two old `invitations_*` policy names are gone.

## Rollout

Single PR is fine — the change is large but tightly coupled.

1. **Pre-flight sanity check:** run the verification query in the migration body's comment to confirm `leo@reslv.io` maps to the expected `profiles.id`. Abort if the row is missing or the email differs.
2. **Apply migration 0013** to the remote DB (via Supabase MCP `apply_migration`). At this point client still works because no client code reads `is_admin`.
3. **Redeploy `invite-user` Edge Function** with the `is_admin()` guard. (Leo is admin, so his existing invite flow keeps working.)
4. **Ship the client PR** (all UI changes). Single Netlify deploy.

## Risks & mitigations

- **Window between steps 3 and 4:** A non-Leo trainer who tries to invite during this gap gets 403. *Mitigation:* audit log shows only Leo has sent invites historically; the window is effectively risk-free.
- **Surprise switcher for promoted users:** A user marked both trainer and trainee suddenly sees a mode switcher in the header. *Mitigation:* localStorage starts blank → defaults to `'trainee'` → same UI as before unless they tap. Discoverable, not disruptive.
- **Direct URL into wrong mode:** Caught by `ModeGate` — auto-switches **transiently** (in-memory only; the user's persisted mode preference is untouched) or redirects to `/`. No 404, no error scream.
- **Mode/URL drift:** User in trainer mode flips to trainee mode while on `/trainer/trainees`. `ModeGate` redirects to `/`. Acceptable: mode switching is an explicit user action.
- **Mid-edit mode switch destroys unsaved state:** Tapping the mode switcher while inside `PlanEditor` / `ExerciseEditor` / `BundleEditor` discards in-progress edits silently. Same behavior as tapping a bottom-nav tab mid-edit today. *Mitigation:* none in this spec — adding an unsaved-changes guard is out of scope. Flagged here so it's an acknowledged limitation, not a surprise.
- **Mid-session role demotion:** If an admin demotes a user while that user is logged in in admin/trainer mode, the next pull-sync brings down `isAdmin=false`/`isTrainer=false`. *Mitigation:* `RoleModeProvider`'s effect (see Shell architecture) detects the change and falls back to `'trainee'` mode, clearing localStorage. No stuck-on-redirect loop.
- **Two tabs in different modes:** localStorage writes from one tab do not auto-propagate to React state in the other tab. A user with the app open in two tabs (Tab A in Trainer mode, Tab B in Admin mode) keeps each tab in its in-memory mode until that tab reloads or the user clicks the switcher there. Acceptable for this PWA — the modes are workspaces, not session state — but documented so it doesn't get reported as a bug. If we ever want cross-tab sync, add a `storage` event listener in `RoleModeProvider`.
- **Non-risk — sync:** `is_admin` is a column on `profiles`, already synced by the existing pull worker (after the mapping allowlist update). Nothing else changes in sync.

## Out of scope

- Admin dashboard with stats/charts (chose 3 functional tabs over a 4th dashboard tab).
- Per-role email-template customization.
- Soft-deleting admins or transfer-of-ownership.
- Hard URL split (`/trainee/*` etc.) — routes stay flat, `ModeGate` handles gating.
- A "switch to user" impersonation tool.

## Open questions

None remaining as of this draft. The clarifying-question pass (Q1–Q6 in the brainstorm session) resolved the role model, default mode, switcher visibility, admin capabilities, per-mode nav contents, and bootstrap.
