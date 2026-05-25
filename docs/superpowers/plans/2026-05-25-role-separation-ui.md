# Role Separation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third role (`is_admin`) that owns invite/promote/audit-read power, and introduce a header mode switcher so one login can context-switch between Trainee / Trainer / Admin views with distinct bottom navs.

**Architecture:** A single React shell with a `RoleMode` context that drives bottom-nav contents and route gating. Routes re-prefixed (`/trainer/*`, `/admin/*`). DB migration adds `profiles.is_admin`, rewrites several RLS policies, drops the now-stranded `designate_invited_user` RPC, and swaps the invite/promote RPCs and Edge Function to be admin-gated.

**Tech Stack:** React 18 + TypeScript + Vite + React Router (HashRouter) + Tailwind, Supabase (Postgres + RLS + Edge Functions + Deno), Dexie (local IndexedDB), Vitest + Testing Library, fake-indexeddb for tests.

**Spec:** `docs/superpowers/specs/2026-05-25-role-separation-ui-design.md`

**Verification commands** (use throughout):
- Type-check: `npx tsc -b --noEmit`
- Tests: `npx vitest run --reporter=verbose` (single file: `npx vitest run src/path/to/test.tsx`)
- Lint: `npx eslint src/`

---

## Task 1: Migration 0013 — schema, RLS, RPCs

**Files:**
- Create: `supabase/migrations/0013_admin_role.sql`

- [ ] **Step 1: Pre-flight sanity check via MCP**

Use the Supabase MCP `execute_sql` tool with the project's ref to confirm the seed target row exists:

```sql
select p.id, u.email
  from profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'leo@reslv.io';
```

Expected: exactly one row. If zero rows or different email, STOP and ask the user before proceeding.

- [ ] **Step 2: Write the migration SQL file**

Create `supabase/migrations/0013_admin_role.sql` with the full body from the spec's "Migration `0013_admin_role.sql`" section. Reproduce it verbatim — every `DROP POLICY` / `CREATE POLICY` / `CREATE OR REPLACE FUNCTION` block, including the seed UPDATE, the `revoke/grant` pair on `promote_to_trainer`, the `drop function if exists public.designate_invited_user(uuid)`, and the "Triggers verified unaffected" comment block as a SQL comment header.

- [ ] **Step 3: Apply the migration via MCP**

Use the Supabase MCP `apply_migration` tool with `name: "admin_role"` and the SQL body from step 2.

Expected: returns success, no errors. Migration appears in `supabase/migrations` list on the remote.

- [ ] **Step 4: Verify the migration applied correctly**

Use MCP `execute_sql` to run each of these and confirm the expected results:

```sql
-- (a) column exists and Leo seeded
select id, is_admin from profiles where is_admin = true;
-- Expected: exactly Leo's row

-- (b) functions present
select to_regprocedure('public.is_admin()')                  as is_admin_fn,
       to_regprocedure('public.promote_to_admin(uuid)')      as promote_admin_fn,
       to_regprocedure('public.designate_invited_user(uuid)') as designate_fn;
-- Expected: first two non-null, designate_fn IS NULL

-- (c) policies present with new names
select policyname from pg_policies
 where tablename in ('profiles','invitations','audit_events')
 order by tablename, policyname;
-- Expected: profiles_read, profiles_write, invitations_read,
--           invitations_cancel_admin, audit_events_read. Old
--           invitations_read_inviter / invitations_cancel_inviter absent.

-- (d) seed query returns Leo as admin
select count(*) from profiles where is_admin = true;
-- Expected: 1
```

- [ ] **Step 5: Commit the migration file**

```bash
git add supabase/migrations/0013_admin_role.sql
git commit -m "migration 0013: add is_admin role, move invite/promote to admin"
```

---

## Task 2: Edge function — swap is_trainer for is_admin

**Files:**
- Modify: `supabase/functions/invite-user/index.ts`

- [ ] **Step 1: Edit the role-check call**

Open `supabase/functions/invite-user/index.ts`. Find the block around line 91:

```ts
  const { data: isTrainerData, error: rpcErr } = await userClient.rpc('is_trainer');
  if (rpcErr) return jsonResponse({ error: `is_trainer check failed: ${rpcErr.message}` }, 500);
  if (!isTrainerData) return jsonResponse({ error: 'trainer only' }, 403);
```

Replace with:

```ts
  const { data: isAdminData, error: rpcErr } = await userClient.rpc('is_admin');
  if (rpcErr) return jsonResponse({ error: `is_admin check failed: ${rpcErr.message}` }, 500);
  if (!isAdminData) return jsonResponse({ error: 'admin only' }, 403);
```

- [ ] **Step 2: Update the doc-comment header**

Replace line 5 `// - Verifies caller is a trainer (JWT + is_trainer RPC).` with `// - Verifies caller is an admin (JWT + is_admin RPC).`

In the same comment block (lines 1–19), update any other "trainer" references to "admin" where the comment describes the calling role (do NOT change "trainer" where it refers to the recipient's future role — they still become a plain trainee, then may be designated by a trainer).

- [ ] **Step 3: Redeploy the function via MCP**

Use the Supabase MCP `deploy_edge_function` tool. Read the modified file and pass it as the `index.ts` entry. Name: `invite-user`. `verify_jwt: true`.

Expected: deploy succeeds.

- [ ] **Step 4: Smoke-test the live function**

Trigger an invite from the app yourself (you're admin). Confirm: the function returns 200 OK, an audit event `invite.sent` lands in `audit_events` (verify via MCP `execute_sql`). If the function returns 403, the migration's `is_admin` seed didn't take — go back to Task 1.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/invite-user/index.ts
git commit -m "invite-user: gate on is_admin instead of is_trainer"
```

---

## Task 3: Profile shape — TypeScript + AuthProvider + cache hydration

**Files:**
- Modify: `src/auth/useAuth.ts`
- Modify: `src/auth/AuthProvider.tsx`
- Modify: `src/sync/mapping.ts`
- Test: `src/auth/AuthProvider.cache.test.tsx` (new)

- [ ] **Step 1: Write failing test for cache hydration**

Create `src/auth/AuthProvider.cache.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from './AuthProvider';
import { useAuth, LAST_PROFILE_KEY } from './useAuth';
import { stubAuthenticatedUser, clearAuthStub } from '../test/authStub';

function Probe() {
  const { profile } = useAuth();
  return (
    <div>
      <span data-testid="trainer">{String(profile?.isTrainer)}</span>
      <span data-testid="admin">{String(profile?.isAdmin)}</span>
    </div>
  );
}

describe('AuthProvider cache hydration', () => {
  beforeEach(() => clearAuthStub());

  it('defaults isAdmin to false when reading a v1-shaped cache (no isAdmin field)', async () => {
    // Simulate a cache written before the is_admin column existed.
    const v1Cache = { id: 'u-1', displayName: 'Pat', isTrainer: true };
    localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(v1Cache));
    stubAuthenticatedUser({ id: 'u-1' });
    // Force the fetch path to fail so the cache is used.
    // (fakeSupabase's profile select will return the new shape; we rely on
    //  the rehydration path being exercised by the provider's bootstrap.)
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => {
      expect(screen.getByTestId('admin').textContent).not.toBe('undefined');
    });
    // Whether the fresh fetch or the cache wins, the shape must include isAdmin.
    expect(['true', 'false']).toContain(screen.getByTestId('admin').textContent);
  });
});
```

- [ ] **Step 2: Run the test (it should fail because `isAdmin` is not on Profile yet)**

Run: `npx vitest run src/auth/AuthProvider.cache.test.tsx`
Expected: FAIL — `Property 'isAdmin' does not exist on type 'Profile'.`

- [ ] **Step 3: Add `isAdmin` to the Profile interface**

Edit `src/auth/useAuth.ts` line 3:

```ts
export interface Profile { id: string; displayName: string | null; isTrainer: boolean; isAdmin: boolean; }
```

- [ ] **Step 4: Update AuthProvider's select + mapper + cache rehydration**

Edit `src/auth/AuthProvider.tsx`:

- Line 25: change the select string from `'id, display_name, is_trainer'` to `'id, display_name, is_trainer, is_admin'`.
- Line 27 type annotation: change the inline type to `{ id: string; display_name: string | null; is_trainer: boolean; is_admin: boolean }[]`.
- Line 34 mapper: change `return { id: row.id, displayName: row.display_name, isTrainer: row.is_trainer };` to `return { id: row.id, displayName: row.display_name, isTrainer: row.is_trainer, isAdmin: row.is_admin };`.
- In the cache-read branch around lines 164–167, change `profile = JSON.parse(cached) as Profile;` (or equivalent) to:

```ts
const parsed = JSON.parse(cached) as Partial<Profile> & { id: string };
profile = {
  id: parsed.id,
  displayName: parsed.displayName ?? null,
  isTrainer: parsed.isTrainer ?? false,
  isAdmin: parsed.isAdmin ?? false,
};
```

(Read the actual file first to match the exact surrounding code; the key invariant is `isAdmin` defaults to `false` when missing.)

- [ ] **Step 5: Add `is_admin` to the sync allowlist**

Edit `src/sync/mapping.ts`:

```ts
profiles:  new Set(['id', 'display_name', 'is_trainer', 'is_admin', 'created_at']),
```

- [ ] **Step 6: Re-run the test, then full type-check**

```
npx vitest run src/auth/AuthProvider.cache.test.tsx
npx tsc -b --noEmit
```

Expected: test passes; type-check passes (you may see new errors elsewhere where stub profiles are missing `isAdmin` — leave them for Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/auth/useAuth.ts src/auth/AuthProvider.tsx src/sync/mapping.ts src/auth/AuthProvider.cache.test.tsx
git commit -m "auth: add isAdmin to Profile, hydrate is_admin from server + cache default"
```

---

## Task 4: Test stub support for isAdmin

**Files:**
- Modify: `src/test/fakeSupabase.ts`
- Modify: `src/test/authStub.ts`

- [ ] **Step 1: Extend the default profile row**

Edit `src/test/fakeSupabase.ts` line 216:

```ts
tables.profiles.push({
  id: userId, display_name: null, is_trainer: false, is_admin: false, created_at: nowIso(),
});
```

- [ ] **Step 2: Add the `setAdmin` helper**

Edit `src/test/fakeSupabase.ts`. Right after the `setTrainer` block (lines 222–225), add:

```ts
setAdmin(userId: string, isAdmin: boolean) {
  const p = tables.profiles.find((x) => x.id === userId);
  if (p) p.is_admin = isAdmin;
},
```

- [ ] **Step 3: Extend `authStub.ts` to accept `isAdmin`**

Edit `src/test/authStub.ts` lines 7–13:

```ts
export function stubAuthenticatedUser(opts: {
  id: string; email?: string; isTrainer?: boolean; isAdmin?: boolean;
} = { id: 'u-test' }): FakeSupabase {
  const fake = createFakeSupabase();
  fake.deliverMagicLink(opts.email ?? 'test@example.com', opts.id);
  if (opts.isTrainer) fake.setTrainer(opts.id, true);
  if (opts.isAdmin)   fake.setAdmin(opts.id, true);
  activeFake = fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSupabase(fake.client as any);
  return fake;
}
```

- [ ] **Step 4: Run all tests to see what's still broken**

Run: `npx vitest run --reporter=verbose`

Expected: type errors in tests that build Profile objects without `isAdmin`. Identify each file (likely `src/test/sync-roundtrip.test.tsx`, `src/test/workflow.test.tsx`, and any inline `Profile` construction).

- [ ] **Step 5: Add `isAdmin: false` to every inline Profile stub the test suite builds**

For each test file flagged in step 4, find inline `Profile`-shaped object literals and add `isAdmin: false`. Examples to check:
- `src/test/sync-roundtrip.test.tsx`
- `src/test/workflow.test.tsx`
- `src/test/exerciseEditor.test.tsx`
- `src/test/sharing.test.tsx`
- `src/test/invitations.test.ts`

Use `grep -n "isTrainer:" src/test src/sync 2>/dev/null` to find candidate sites. Each should become `isTrainer: ..., isAdmin: false` unless the test specifically asserts admin behavior.

- [ ] **Step 6: Re-run all tests**

Run: `npx vitest run`
Expected: type errors gone; tests pass (some may still fail for unrelated reasons — leave those alone for now and note them).

- [ ] **Step 7: Commit**

```bash
git add src/test/fakeSupabase.ts src/test/authStub.ts src/test/*.test.* src/sync/*.test.*
git commit -m "test stubs: add isAdmin support to fake Supabase + authStub"
```

---

## Task 5: RoleMode context + Provider

**Files:**
- Create: `src/auth/RoleMode.tsx`
- Test: `src/auth/RoleMode.test.tsx`

- [ ] **Step 1: Write failing tests for the provider behaviors**

Create `src/auth/RoleMode.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RoleModeProvider, useRoleMode, ROLE_MODE_STORAGE_KEY } from './RoleMode';
import type { Profile } from './useAuth';

function probe() {
  const ctx = useRoleMode();
  return (
    <div>
      <span data-testid="mode">{ctx.mode}</span>
      <span data-testid="available">{ctx.availableModes.join(',')}</span>
      <button onClick={() => ctx.setMode('trainer')}>setMode trainer</button>
      <button onClick={() => ctx.setModeTransient('admin')}>transient admin</button>
    </div>
  );
}

function Probe() { return probe(); }

function withProvider(profile: Profile) {
  return render(<RoleModeProvider profile={profile}><Probe /></RoleModeProvider>);
}

const PROFILE = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

describe('RoleModeProvider', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to trainee when no localStorage entry', () => {
    withProvider(PROFILE({ isTrainer: true }));
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
  });

  it('honors a valid stored mode', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'trainer');
    withProvider(PROFILE({ isTrainer: true }));
    expect(screen.getByTestId('mode').textContent).toBe('trainer');
  });

  it('falls back to trainee when stored mode is not in availableModes', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'admin');
    withProvider(PROFILE({ isTrainer: true })); // no isAdmin
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
  });

  it('availableModes derives correctly from flags', () => {
    withProvider(PROFILE({ isTrainer: true, isAdmin: true }));
    expect(screen.getByTestId('available').textContent).toBe('trainee,trainer,admin');
  });

  it('setMode writes localStorage', () => {
    withProvider(PROFILE({ isTrainer: true }));
    act(() => { screen.getByText('setMode trainer').click(); });
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBe('trainer');
  });

  it('setModeTransient does NOT write localStorage', () => {
    withProvider(PROFILE({ isAdmin: true }));
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
    act(() => { screen.getByText('transient admin').click(); });
    expect(screen.getByTestId('mode').textContent).toBe('admin');
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });

  it('reactively resets to trainee when availableModes shrinks below the active mode', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'admin');
    const profileWithAdmin = PROFILE({ isAdmin: true });
    const { rerender } = render(<RoleModeProvider profile={profileWithAdmin}><Probe /></RoleModeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('admin');
    // Simulate demotion mid-session.
    rerender(<RoleModeProvider profile={PROFILE()}><Probe /></RoleModeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (fails, module not found)**

Run: `npx vitest run src/auth/RoleMode.test.tsx`
Expected: FAIL — `Cannot find module './RoleMode'`.

- [ ] **Step 3: Implement the provider**

Create `src/auth/RoleMode.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Profile } from './useAuth';

export type Mode = 'trainee' | 'trainer' | 'admin';

export const ROLE_MODE_STORAGE_KEY = 'ahkeung:roleMode';

interface RoleModeContextValue {
  mode: Mode;
  availableModes: Mode[];
  setMode: (m: Mode) => void;          // explicit; persists to localStorage
  setModeTransient: (m: Mode) => void; // implicit; in-memory only
}

const RoleModeContext = createContext<RoleModeContextValue | null>(null);

function deriveAvailable(profile: Profile): Mode[] {
  const out: Mode[] = ['trainee'];
  if (profile.isTrainer) out.push('trainer');
  if (profile.isAdmin)   out.push('admin');
  return out;
}

function readStoredMode(available: Mode[]): Mode {
  try {
    const raw = localStorage.getItem(ROLE_MODE_STORAGE_KEY);
    if (raw && (available as string[]).includes(raw)) return raw as Mode;
  } catch { /* localStorage unavailable */ }
  return 'trainee';
}

export function RoleModeProvider({ profile, children }: { profile: Profile; children: ReactNode }) {
  const availableModes = useMemo(() => deriveAvailable(profile), [profile.isTrainer, profile.isAdmin]);
  const [mode, setModeState] = useState<Mode>(() => readStoredMode(availableModes));

  const setMode = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setModeState(m);
    try { localStorage.setItem(ROLE_MODE_STORAGE_KEY, m); } catch { /* ignore */ }
  }, [availableModes]);

  const setModeTransient = useCallback((m: Mode) => {
    if (!availableModes.includes(m)) return;
    setModeState(m);
  }, [availableModes]);

  // Mid-session demotion: if availableModes no longer includes the current
  // mode, fall back to trainee and clear the persisted preference.
  useEffect(() => {
    if (!availableModes.includes(mode)) {
      setModeState('trainee');
      try { localStorage.removeItem(ROLE_MODE_STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [availableModes, mode]);

  const value = useMemo<RoleModeContextValue>(() => ({
    mode, availableModes, setMode, setModeTransient,
  }), [mode, availableModes, setMode, setModeTransient]);

  return <RoleModeContext.Provider value={value}>{children}</RoleModeContext.Provider>;
}

export function useRoleMode(): RoleModeContextValue {
  const v = useContext(RoleModeContext);
  if (!v) throw new Error('useRoleMode must be used inside <RoleModeProvider>');
  return v;
}
```

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run src/auth/RoleMode.test.tsx`
Expected: all 7 cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth/RoleMode.tsx src/auth/RoleMode.test.tsx
git commit -m "auth: add RoleMode context with persistent + transient setters"
```

---

## Task 6: ModeGate component

**Files:**
- Create: `src/components/ModeGate.tsx`
- Test: `src/components/ModeGate.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/components/ModeGate.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RoleModeProvider, ROLE_MODE_STORAGE_KEY } from '../auth/RoleMode';
import { ModeGate } from './ModeGate';
import type { Profile } from '../auth/useAuth';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

function setup(p: Profile, initial: string) {
  return render(
    <RoleModeProvider profile={p}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/trainer" element={
            <ModeGate allowedIn={['trainer']}><div>TRAINER PAGE</div></ModeGate>
          } />
        </Routes>
      </MemoryRouter>
    </RoleModeProvider>
  );
}

describe('ModeGate', () => {
  beforeEach(() => localStorage.clear());

  it('renders children when current mode is allowed', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'trainer');
    setup(profile({ isTrainer: true }), '/trainer');
    expect(screen.getByText('TRAINER PAGE')).toBeInTheDocument();
  });

  it('auto-switches transiently when current mode wrong but allowedIn is available', () => {
    setup(profile({ isTrainer: true }), '/trainer'); // mode defaults to trainee
    expect(screen.getByText('TRAINER PAGE')).toBeInTheDocument();
    // Critical: must NOT have persisted the new mode.
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });

  it('redirects to / when no allowedIn mode is available', () => {
    setup(profile(), '/trainer'); // trainee-only
    expect(screen.getByText('HOME')).toBeInTheDocument();
    expect(screen.queryByText('TRAINER PAGE')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test (fails, module not found)**

Run: `npx vitest run src/components/ModeGate.test.tsx`
Expected: FAIL — `Cannot find module './ModeGate'`.

- [ ] **Step 3: Implement ModeGate**

Create `src/components/ModeGate.tsx`:

```tsx
import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useRoleMode, type Mode } from '../auth/RoleMode';

export function ModeGate({ allowedIn, children }: { allowedIn: Mode[]; children: ReactNode }) {
  const { mode, availableModes, setModeTransient } = useRoleMode();

  const isAllowed = allowedIn.includes(mode);
  const switchable = !isAllowed && allowedIn.find((m) => availableModes.includes(m));

  useEffect(() => {
    if (switchable) setModeTransient(switchable);
  }, [switchable, setModeTransient]);

  if (isAllowed) return <>{children}</>;
  if (switchable) return null; // brief render before the effect flips mode
  return <Navigate to="/" replace />;
}
```

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run src/components/ModeGate.test.tsx`
Expected: all 3 cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ModeGate.tsx src/components/ModeGate.test.tsx
git commit -m "components: add ModeGate route wrapper with transient auto-switch"
```

---

## Task 7: ModeSwitcher component + i18n strings

**Files:**
- Create: `src/components/ModeSwitcher.tsx`
- Test: `src/components/ModeSwitcher.test.tsx`
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: Add the i18n strings**

In `src/i18n/types.ts`, add to the `Translation` interface (place near existing UI labels):

```ts
modeSwitcher: { trainee: string; trainer: string; admin: string };
```

In `src/i18n/en.ts`, add:

```ts
modeSwitcher: { trainee: 'Trainee', trainer: 'Trainer', admin: 'Admin' },
```

In `src/i18n/zh-Hant.ts`, add:

```ts
modeSwitcher: { trainee: '學員', trainer: '教練', admin: '管理員' },
```

- [ ] **Step 2: Write failing test for ModeSwitcher visibility + interaction**

Create `src/components/ModeSwitcher.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RoleModeProvider, ROLE_MODE_STORAGE_KEY } from '../auth/RoleMode';
import { I18nProvider } from '../i18n';
import { ModeSwitcher } from './ModeSwitcher';
import type { Profile } from '../auth/useAuth';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function setup(p: Profile) {
  return render(
    <I18nProvider>
      <RoleModeProvider profile={p}>
        <MemoryRouter initialEntries={['/']}>
          <ModeSwitcher />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </RoleModeProvider>
    </I18nProvider>
  );
}

describe('ModeSwitcher', () => {
  beforeEach(() => localStorage.clear());

  it('renders nothing when user has only one role', () => {
    const { container } = setup(profile());
    expect(container.querySelector('[data-testid="mode-switcher"]')).toBeNull();
  });

  it('renders pills for each available mode when multi-role', () => {
    setup(profile({ isTrainer: true, isAdmin: true }));
    expect(screen.getByRole('button', { name: /Trainee/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Trainer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Admin/ })).toBeInTheDocument();
  });

  it('tapping a pill calls setMode (persists) AND navigates to that mode default route', () => {
    setup(profile({ isTrainer: true }));
    act(() => { screen.getByRole('button', { name: /Trainer/ }).click(); });
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBe('trainer');
    expect(screen.getByTestId('path').textContent).toBe('/trainer');
  });
});
```

(If `I18nProvider` is exported under a different name, check `src/i18n/index.tsx`. Adjust the import.)

- [ ] **Step 3: Run the test (fails, module not found)**

Run: `npx vitest run src/components/ModeSwitcher.test.tsx`
Expected: FAIL — `Cannot find module './ModeSwitcher'`.

- [ ] **Step 4: Implement ModeSwitcher**

Create `src/components/ModeSwitcher.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { useRoleMode, type Mode } from '../auth/RoleMode';
import { useI18n } from '../i18n';

const DEFAULT_ROUTE_BY_MODE: Record<Mode, string> = {
  trainee: '/',
  trainer: '/trainer',
  admin:   '/admin/invites',
};

const ICON_BY_MODE: Record<Mode, string> = {
  trainee: '👤', trainer: '🏋️', admin: '🛡️',
};

export function ModeSwitcher() {
  const { mode, availableModes, setMode } = useRoleMode();
  const { t } = useI18n();
  const navigate = useNavigate();

  if (availableModes.length <= 1) return null;

  return (
    <div data-testid="mode-switcher" className="flex items-center bg-slate-800 rounded-full border border-slate-700 text-[11px]">
      {availableModes.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              navigate(DEFAULT_ROUTE_BY_MODE[m]);
            }}
            className={
              'px-2 py-1 rounded-full transition-colors ' +
              (active ? 'bg-keung-600 text-white' : 'text-slate-300 hover:text-white')
            }
          >
            <span className="mr-1">{ICON_BY_MODE[m]}</span>
            {t.modeSwitcher[m]}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Re-run the test**

Run: `npx vitest run src/components/ModeSwitcher.test.tsx`
Expected: all 3 cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/ModeSwitcher.tsx src/components/ModeSwitcher.test.tsx src/i18n/
git commit -m "components: add ModeSwitcher header pill + i18n strings"
```

---

## Task 8: Wire RoleModeProvider into App + per-mode bottom nav

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: Add per-mode tab labels to i18n**

In `src/i18n/types.ts`, add to the `Translation` interface:

```ts
trainerTabs: { dashboard: string; trainees: string; exercises: string; bundles: string };
adminTabs:   { invites: string;  users: string;     audit: string };
```

In `src/i18n/en.ts`:

```ts
trainerTabs: { dashboard: 'Dashboard', trainees: 'Trainees', exercises: 'Exercises', bundles: 'Bundles' },
adminTabs:   { invites: 'Invites',     users: 'Users',       audit: 'Audit' },
```

In `src/i18n/zh-Hant.ts`:

```ts
trainerTabs: { dashboard: '總覽', trainees: '學員', exercises: '動作', bundles: '組合' },
adminTabs:   { invites: '邀請',   users: '用戶',     audit: '紀錄' },
```

- [ ] **Step 2: Wrap Shell in RoleModeProvider, add NAV_BY_MODE, mount the switcher**

Edit `src/App.tsx`. In `Guarded`, after the `if (profile && !profile.displayName) return <Onboarding />;` line, change `return <>{children}</>;` to:

```ts
return <RoleModeProvider profile={profile!}>{children}</RoleModeProvider>;
```

Add the import at the top: `import { RoleModeProvider } from './auth/RoleMode';`

In the `Shell` function:

1. Add at top of function body: `const { mode } = useRoleMode();` and import `useRoleMode`.
2. Import `ModeSwitcher`: `import { ModeSwitcher } from './components/ModeSwitcher';`.
3. Add `<ModeSwitcher />` between `<LanguageSwitcher />` and the settings `<NavLink>` in the header.
4. Add a `NAV_BY_MODE` constant outside the component:

```ts
const NAV_BY_MODE: Record<Mode, { to: string; icon: string; labelKey: string; end?: boolean }[]> = {
  trainee: [
    { to: '/',        icon: '🏠', labelKey: 'tabs.home', end: true },
    { to: '/plans',   icon: '📋', labelKey: 'tabs.plans' },
    { to: '/library', icon: '📚', labelKey: 'tabs.library' },
    { to: '/metrics', icon: '📈', labelKey: 'tabs.metrics' },
  ],
  trainer: [
    { to: '/trainer/trainees',  icon: '👥', labelKey: 'trainerTabs.trainees' },
    { to: '/trainer/exercises', icon: '🏋️', labelKey: 'trainerTabs.exercises' },
    { to: '/trainer/bundles',   icon: '📦', labelKey: 'trainerTabs.bundles' },
    { to: '/trainer',           icon: '🏠', labelKey: 'trainerTabs.dashboard', end: true },
  ],
  admin: [
    { to: '/admin/invites', icon: '✉️', labelKey: 'adminTabs.invites' },
    { to: '/admin/users',   icon: '👤', labelKey: 'adminTabs.users' },
    { to: '/admin/audit',   icon: '📜', labelKey: 'adminTabs.audit' },
  ],
};
```

Import `Mode`: `import { useRoleMode, type Mode } from './auth/RoleMode';`

5. Replace the `<nav>` body's hardcoded TabLinks with a derived loop:

```tsx
<nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto border-t border-slate-800 bg-slate-900/95 backdrop-blur grid z-10"
     style={{ gridTemplateColumns: `repeat(${NAV_BY_MODE[mode].length}, minmax(0, 1fr))` }}>
  {NAV_BY_MODE[mode].map((tab) => (
    <TabLink key={tab.to} to={tab.to} icon={tab.icon} label={resolveLabel(t, tab.labelKey)} end={tab.end} />
  ))}
</nav>
```

Add a helper outside `Shell`:

```ts
function resolveLabel(t: Translation, key: string): string {
  // Two-segment dotted key like "tabs.home" or "trainerTabs.dashboard".
  const [group, leaf] = key.split('.');
  return (t as unknown as Record<string, Record<string, string>>)[group][leaf];
}
```

(Import `Translation`: `import type { Translation } from './i18n/types';`)

6. Change the header bottom-border based on mode. Replace `border-b border-slate-800` on the `<header>` with:

```tsx
className={
  'px-4 pt-6 pb-3 border-b flex items-center gap-2 sticky top-0 z-10 bg-slate-900/95 backdrop-blur ' +
  (mode === 'trainer' ? 'border-keung-600/60' : mode === 'admin' ? 'border-amber-600/60' : 'border-slate-800')
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b --noEmit`
Expected: passes. The Routes block will still 404 on `/trainer/*` etc. — that's expected; we add routes in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/i18n/
git commit -m "shell: wire RoleModeProvider, ModeSwitcher, NAV_BY_MODE bottom nav"
```

---

## Task 9: Re-prefix routes + ModeGate wrapping + legacy redirects

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Rewrite the `<Routes>` block**

In `src/App.tsx`, replace the existing `<Routes>` body with:

```tsx
<Routes>
  {/* Trainee mode */}
  <Route path="/" element={<ModeGate allowedIn={['trainee']}><Home /></ModeGate>} />
  <Route path="/plans" element={<ModeGate allowedIn={['trainee']}><Plans /></ModeGate>} />
  <Route path="/plans/new" element={<ModeGate allowedIn={['trainee']}><PlanEditor /></ModeGate>} />
  <Route path="/plans/:id" element={<ModeGate allowedIn={['trainee']}><PlanEditor /></ModeGate>} />
  <Route path="/workout" element={<ModeGate allowedIn={['trainee']}><Workout /></ModeGate>} />
  <Route path="/workout/:planId" element={<ModeGate allowedIn={['trainee']}><Workout /></ModeGate>} />
  <Route path="/library" element={<ModeGate allowedIn={['trainee']}><Library /></ModeGate>} />
  <Route path="/metrics" element={<ModeGate allowedIn={['trainee']}><Metrics /></ModeGate>} />

  {/* Trainer mode */}
  <Route path="/trainer" element={<ModeGate allowedIn={['trainer']}><TrainerDashboard /></ModeGate>} />
  <Route path="/trainer/trainees" element={<ModeGate allowedIn={['trainer']}><MyTrainees /></ModeGate>} />
  <Route path="/trainer/exercises" element={<ModeGate allowedIn={['trainer']}><MyExercises /></ModeGate>} />
  <Route path="/trainer/exercises/new" element={<ModeGate allowedIn={['trainer']}><ExerciseEditor /></ModeGate>} />
  <Route path="/trainer/exercises/:id" element={<ModeGate allowedIn={['trainer']}><ExerciseEditor /></ModeGate>} />
  <Route path="/trainer/bundles" element={<ModeGate allowedIn={['trainer']}><MyBundles /></ModeGate>} />
  <Route path="/trainer/bundles/new" element={<ModeGate allowedIn={['trainer']}><BundleEditor /></ModeGate>} />
  <Route path="/trainer/bundles/:id" element={<ModeGate allowedIn={['trainer']}><BundleEditor /></ModeGate>} />

  {/* Admin mode */}
  <Route path="/admin/invites" element={<ModeGate allowedIn={['admin']}><AdminInvites /></ModeGate>} />
  <Route path="/admin/users" element={<ModeGate allowedIn={['admin']}><AdminUsers /></ModeGate>} />
  <Route path="/admin/audit" element={<ModeGate allowedIn={['admin']}><AdminAudit /></ModeGate>} />

  {/* Cross-mode */}
  <Route path="/settings" element={<Settings />} />

  {/* Legacy URL redirects for external bookmarks */}
  <Route path="/exercises" element={<Navigate to="/trainer/exercises" replace />} />
  <Route path="/exercises/new" element={<Navigate to="/trainer/exercises/new" replace />} />
  <Route path="/exercises/:id" element={<Navigate to="/trainer/exercises/:id" replace />} />
  <Route path="/bundles" element={<Navigate to="/trainer/bundles" replace />} />
  <Route path="/bundles/new" element={<Navigate to="/trainer/bundles/new" replace />} />
  <Route path="/bundles/:id" element={<Navigate to="/trainer/bundles/:id" replace />} />
  <Route path="/trainees" element={<Navigate to="/trainer/trainees" replace />} />

  <Route path="*" element={<Navigate to="/" />} />
</Routes>
```

Add imports at the top:

```ts
import { ModeGate } from './components/ModeGate';
import { TrainerDashboard } from './pages/TrainerDashboard';
import { AdminInvites } from './pages/AdminInvites';
import { AdminUsers } from './pages/AdminUsers';
import { AdminAudit } from './pages/AdminAudit';
```

Note: the legacy redirect for `/exercises/:id` uses `:id` literally in the `to` — react-router's `<Navigate to="...">` does not template params. For the parametric ones, instead use a tiny redirect element. Add this helper near the bottom of the file:

```tsx
function ParamRedirect({ to }: { to: (p: Readonly<Record<string, string | undefined>>) => string }) {
  const params = useParams();
  return <Navigate to={to(params)} replace />;
}
```

And replace the param redirects with:

```tsx
<Route path="/exercises/:id" element={<ParamRedirect to={(p) => `/trainer/exercises/${p.id}`} />} />
<Route path="/bundles/:id" element={<ParamRedirect to={(p) => `/trainer/bundles/${p.id}`} />} />
```

Add `useParams` to the existing `react-router-dom` import.

- [ ] **Step 2: Type-check**

Run: `npx tsc -b --noEmit`
Expected: errors about the four new page modules not existing (`TrainerDashboard`, `AdminInvites`, `AdminUsers`, `AdminAudit`). That's expected — Tasks 12–15 create them. Leave the imports; create stub files so the type-check passes for now:

For each of the four new pages, create a stub at `src/pages/<Name>.tsx`:

```tsx
export function TrainerDashboard() { return <div className="p-4 text-slate-100">Trainer dashboard</div>; }
```

(Substitute name for each. These get fleshed out in subsequent tasks.)

- [ ] **Step 3: Re-run type-check**

Run: `npx tsc -b --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/pages/TrainerDashboard.tsx src/pages/AdminInvites.tsx src/pages/AdminUsers.tsx src/pages/AdminAudit.tsx
git commit -m "routes: re-prefix /trainer/* and /admin/*, wrap in ModeGate, add legacy redirects + page stubs"
```

---

## Task 10: Rewrite in-app callers using old paths

**Files:**
- Modify: `src/pages/ExerciseEditor.tsx`
- Modify: `src/pages/BundleEditor.tsx`
- Modify: `src/pages/MyExercises.tsx`
- Modify: `src/pages/MyBundles.tsx`

- [ ] **Step 1: Rewrite ExerciseEditor navigate calls**

In `src/pages/ExerciseEditor.tsx`, find each occurrence of `navigate('/exercises')` (lines 104, 121, 128 per spec) and change to `navigate('/trainer/exercises')`. Use `grep -n "navigate('/exercises" src/pages/ExerciseEditor.tsx` to confirm all sites are caught.

- [ ] **Step 2: Rewrite BundleEditor navigate calls**

In `src/pages/BundleEditor.tsx`, find each occurrence of `navigate('/bundles')` (lines 97, 111, 118) and change to `navigate('/trainer/bundles')`.

- [ ] **Step 3: Rewrite MyExercises and MyBundles "new" Links**

In `src/pages/MyExercises.tsx` line 49, change `to="/exercises/new"` → `to="/trainer/exercises/new"`.
In `src/pages/MyBundles.tsx` line 61, change `to="/bundles/new"` → `to="/trainer/bundles/new"`.

- [ ] **Step 4: Confirm no other stale paths remain**

Run: `grep -rn "to=\"/exercises\"\|to=\"/bundles\"\|to=\"/trainees\"\|navigate('/exercises'\|navigate('/bundles'\|navigate('/trainees'" src/ | grep -v ".test."`
Expected: only the Settings.tsx hits (those entries get deleted in Task 11). No other matches.

- [ ] **Step 5: Type-check + commit**

```
npx tsc -b --noEmit
git add src/pages/ExerciseEditor.tsx src/pages/BundleEditor.tsx src/pages/MyExercises.tsx src/pages/MyBundles.tsx
git commit -m "pages: rewrite in-app navigate/Link callers to /trainer/* paths"
```

---

## Task 11: Settings refactor — role badge stack, delete trainer-tools grid

**Files:**
- Modify: `src/pages/Settings.tsx`
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: Add badge i18n strings**

In `src/i18n/types.ts` add to `Translation`:

```ts
settingsBadges: { trainee: string; trainer: string; admin: string };
```

In `en.ts`:
```ts
settingsBadges: { trainee: 'Trainee', trainer: 'Trainer', admin: 'Admin' },
```

In `zh-Hant.ts`:
```ts
settingsBadges: { trainee: '學員', trainer: '教練', admin: '管理員' },
```

- [ ] **Step 2: Replace the single Trainer badge with a stack**

Edit `src/pages/Settings.tsx` lines 76–80 (the `{profile?.isTrainer && (<span ...>Trainer</span>)}` block). Replace with:

```tsx
<div className="ml-auto flex items-center gap-1">
  <RoleBadge label={t.settingsBadges.trainee} tone="slate" />
  {profile?.isTrainer && <RoleBadge label={t.settingsBadges.trainer} tone="keung" />}
  {profile?.isAdmin   && <RoleBadge label={t.settingsBadges.admin}   tone="amber" />}
</div>
```

Add the helper at the bottom of the file (before `function YourTrainersSection`):

```tsx
function RoleBadge({ label, tone }: { label: string; tone: 'slate' | 'keung' | 'amber' }) {
  const cls =
    tone === 'keung' ? 'bg-keung-600/30 border-keung-600/60 text-keung-300'
    : tone === 'amber' ? 'bg-amber-600/30 border-amber-600/60 text-amber-300'
    : 'bg-slate-700/40 border-slate-600/60 text-slate-300';
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${cls}`}>
      {label}
    </span>
  );
}
```

- [ ] **Step 3: Delete the "Trainer tools" grid block**

Delete the entire `{profile?.isTrainer && (...)}` block at lines 100–127 of `src/pages/Settings.tsx`. Verify by re-reading the file — the grid linked to `/exercises`, `/bundles`, `/trainees` and is now redundant.

- [ ] **Step 4: Type-check**

Run: `npx tsc -b --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.tsx src/i18n/
git commit -m "settings: role badge stack, drop trainer-tools grid"
```

---

## Task 12: MyTrainees refactor — strip invite + promote + designate-from-invitation

**Files:**
- Modify: `src/pages/MyTrainees.tsx`
- Modify: `src/invitations.ts` (delete `designateInvitedUser` export)
- Modify: `src/test/invitations.test.ts`
- Delete: nothing (the file shrinks but stays)

- [ ] **Step 1: Strip the invite-related imports from MyTrainees**

In `src/pages/MyTrainees.tsx`, remove these imports:
- `useInvitations`, `classifyInvitation`, `Invitation`, `InvitationStatus` from `./useInvitations`
- `inviteByEmail`, `cancelInvitation`, `designateInvitedUser` from `./invitations`
- `useIsTrainer`, `setIsTrainerCache` from `./useIsTrainer`
- `flushNow` from `./sync` (only used for invitations; verify by grep within the file)

Verify with: `grep -n "inviteByEmail\|cancelInvitation\|designateInvitedUser\|useInvitations\|classifyInvitation\|useIsTrainer\|setIsTrainerCache" src/pages/MyTrainees.tsx` — should return zero matches AFTER you finish steps 2 and 3.

- [ ] **Step 2: Delete the invitation UI sections from the JSX**

Open `src/pages/MyTrainees.tsx`. Read the full file. Find every JSX block that renders invitations (an "INVITATIONS" or "PENDING INVITES" section, plus any "+ Designate" button on an invitation row). Delete them. Keep:
- The header with back button
- The search input + `runSearch` button
- The `results` list with designate action
- The `designations` partitioned lists (pending / accepted / declined) with undesignate (✕) action

- [ ] **Step 3: Delete the `PromoteButton` component definition and any reference**

Find the `function PromoteButton({ traineeId })` definition (around line 190 per spec). Delete the entire function. Remove the `<PromoteButton traineeId={...} />` usage from the row JSX (line 177 area). The row should now only render: trainee name, status chip, ✕ remove button.

- [ ] **Step 4: Delete the `designateInvitedUser` export from `src/invitations.ts`**

In `src/invitations.ts`, delete the entire `export async function designateInvitedUser(invitationId: string): Promise<string> { ... }` block (lines 41–56 per spec). The file should now only export `inviteByEmail`, `cancelInvitation`, and the `InviteResult` interface.

- [ ] **Step 5: Remove dead tests**

In `src/test/invitations.test.ts`, remove every test that imports or calls `designateInvitedUser`. If a `describe` block exists exclusively for that helper, delete the whole block. Keep tests for `inviteByEmail` and `cancelInvitation`.

Verify with: `grep -n "designateInvitedUser" src/test/invitations.test.ts` — zero matches.

- [ ] **Step 6: Type-check + run tests**

```
npx tsc -b --noEmit
npx vitest run src/test/invitations.test.ts
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add src/pages/MyTrainees.tsx src/invitations.ts src/test/invitations.test.ts
git commit -m "MyTrainees: strip invite UI, PromoteButton, designate-from-invitation"
```

---

## Task 13: TrainerDashboard — pending designations + designate quick action

**Files:**
- Modify: `src/pages/TrainerDashboard.tsx` (replace stub)
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`
- Modify: `src/pages/MyTrainees.tsx` (read `?focus=search` query param)

- [ ] **Step 1: Add i18n strings**

In `src/i18n/types.ts`:
```ts
trainerDashboard: {
  pendingTitle: string;
  recentTitle: string;
  designateButton: string;
  empty: string;
};
```

In `en.ts`:
```ts
trainerDashboard: {
  pendingTitle: 'Pending designations',
  recentTitle:  'Recent trainee activity',
  designateButton: '+ Designate a user',
  empty: 'No pending designations.',
},
```

In `zh-Hant.ts`:
```ts
trainerDashboard: {
  pendingTitle: '待回應指派',
  recentTitle:  '學員近期活動',
  designateButton: '+ 指派用戶',
  empty: '冇待回應指派。',
},
```

- [ ] **Step 2: Implement the dashboard**

Replace the stub at `src/pages/TrainerDashboard.tsx` with:

```tsx
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useMyTrainees, partitionByStatus } from '../useDesignations';
import { useDisplayName } from '../useDisplayName';

export function TrainerDashboard() {
  const { t } = useI18n();
  const designations = useMyTrainees();
  const { pending } = partitionByStatus(designations);

  return (
    <div className="p-4 space-y-6 text-slate-100">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">
          {t.trainerDashboard.pendingTitle}
        </h2>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.trainerDashboard.empty}</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((d) => (
              <PendingRow key={d.traineeId} traineeId={d.traineeId} />
            ))}
          </ul>
        )}
      </section>

      <Link
        to="/trainer/trainees?focus=search"
        className="block text-center bg-keung-600 hover:bg-keung-700 text-white text-sm font-semibold py-2 rounded-lg"
      >
        {t.trainerDashboard.designateButton}
      </Link>
    </div>
  );
}

function PendingRow({ traineeId }: { traineeId: string }) {
  const name = useDisplayName(traineeId);
  return (
    <li className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-sm">
      {name ?? '…'}
    </li>
  );
}
```

(Recent trainee activity intentionally omitted from MVP — requires a session-activity query that isn't a one-liner. Add as a follow-up; the spec lists it but it's not load-bearing for role separation.)

- [ ] **Step 3: Wire MyTrainees to focus its search input on `?focus=search`**

In `src/pages/MyTrainees.tsx`, add at the top imports: `import { useSearchParams } from 'react-router-dom'; import { useEffect, useRef } from 'react';`. Add a ref to the search input (`const searchRef = useRef<HTMLInputElement>(null);`), attach `ref={searchRef}` to the existing `<input>` for `search`, and add:

```tsx
const [params] = useSearchParams();
useEffect(() => {
  if (params.get('focus') === 'search') searchRef.current?.focus();
}, [params]);
```

(If `useState`/`useRef`/`useEffect` aren't already imported together, merge them into the existing `from 'react'` import.)

- [ ] **Step 4: Type-check**

Run: `npx tsc -b --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/pages/TrainerDashboard.tsx src/pages/MyTrainees.tsx src/i18n/
git commit -m "TrainerDashboard: pending designations + quick designate action"
```

---

## Task 14: AdminInvites — send / pending / awaiting-designation

**Files:**
- Modify: `src/pages/AdminInvites.tsx` (replace stub)
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: i18n strings**

In `src/i18n/types.ts`:
```ts
adminInvites: {
  sendTitle: string; sendButton: string; emailPlaceholder: string;
  pendingTitle: string; pendingEmpty: string;
  awaitingTitle: string; awaitingEmpty: string;
  resend: string; cancel: string;
  sentToast: string; alreadyExistedToast: string; failedToast: string;
};
```

In `en.ts`:
```ts
adminInvites: {
  sendTitle: 'Send an invite',
  sendButton: 'Send',
  emailPlaceholder: 'email@example.com',
  pendingTitle: 'Pending — not yet accepted',
  pendingEmpty: 'No pending invitations.',
  awaitingTitle: 'Accepted — awaiting trainer designation',
  awaitingEmpty: 'No accepted invitations awaiting designation.',
  resend: 'Resend',
  cancel: 'Cancel',
  sentToast: 'Invitation sent.',
  alreadyExistedToast: 'That email already had an account.',
  failedToast: 'Send failed: ',
},
```

In `zh-Hant.ts`:
```ts
adminInvites: {
  sendTitle: '發送邀請',
  sendButton: '發送',
  emailPlaceholder: '電郵@example.com',
  pendingTitle: '待對方接受',
  pendingEmpty: '冇待接受邀請。',
  awaitingTitle: '已接受 — 等待教練指派',
  awaitingEmpty: '冇待指派邀請。',
  resend: '重發',
  cancel: '取消',
  sentToast: '邀請已發送。',
  alreadyExistedToast: '該電郵已有帳戶。',
  failedToast: '發送失敗：',
},
```

- [ ] **Step 2: Implement AdminInvites**

Replace the stub at `src/pages/AdminInvites.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { inviteByEmail, cancelInvitation } from '../invitations';

interface InvitationRow {
  id: string;
  email: string;
  inviter_id: string;
  created_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  designated_at: string | null;
}

export function AdminInvites() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getSupabase().from('invitations')
        .select('id, email, inviter_id, created_at, accepted_at, cancelled_at, designated_at')
        .order('created_at', { ascending: false })
        .limit(100) as { data: InvitationRow[] | null; error: { message: string } | null };
      if (!cancelled) setRows(res.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [reloadAt]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email || sending) return;
    setSending(true);
    setToast(null);
    const result = await inviteByEmail(email.trim());
    setSending(false);
    if (result.ok) {
      setToast(result.alreadyExisted ? t.adminInvites.alreadyExistedToast : t.adminInvites.sentToast);
      setEmail('');
      setReloadAt(Date.now());
    } else {
      setToast(t.adminInvites.failedToast + (result.error ?? 'unknown'));
    }
  }

  async function onCancel(id: string) {
    await cancelInvitation(id);
    setReloadAt(Date.now());
  }

  async function onResend(emailToResend: string) {
    setToast(null);
    const result = await inviteByEmail(emailToResend);
    if (result.ok) {
      setToast(result.alreadyExisted ? t.adminInvites.alreadyExistedToast : t.adminInvites.sentToast);
      setReloadAt(Date.now());
    } else {
      setToast(t.adminInvites.failedToast + (result.error ?? 'unknown'));
    }
  }

  const pending = (rows ?? []).filter((r) => !r.accepted_at && !r.cancelled_at);
  const awaiting = (rows ?? []).filter((r) => r.accepted_at && !r.cancelled_at && !r.designated_at);

  return (
    <div className="p-4 space-y-6 text-slate-100">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.sendTitle}</h2>
        <form onSubmit={onSend} className="flex gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder={t.adminInvites.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          />
          <button
            type="submit"
            disabled={!email || sending}
            className="px-3 py-2 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm"
          >{sending ? '…' : t.adminInvites.sendButton}</button>
        </form>
        {toast && <p className="text-xs text-slate-400 mt-2">{toast}</p>}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.pendingTitle}</h2>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.adminInvites.pendingEmpty}</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((r) => (
              <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{r.email}</span>
                <button onClick={() => void onResend(r.email)} className="text-[11px] text-slate-300 hover:text-white">
                  {t.adminInvites.resend}
                </button>
                <button onClick={() => void onCancel(r.id)} className="text-[11px] text-rose-300 hover:text-rose-200">
                  {t.adminInvites.cancel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-slate-400 mb-2">{t.adminInvites.awaitingTitle}</h2>
        {awaiting.length === 0 ? (
          <p className="text-slate-500 text-sm">{t.adminInvites.awaitingEmpty}</p>
        ) : (
          <ul className="space-y-1">
            {awaiting.map((r) => (
              <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-sm truncate">
                {r.email}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + smoke test in browser**

```
npx tsc -b --noEmit
npm run dev
```

Open `http://localhost:5173/#/admin/invites` while logged in as Leo. Confirm: the page renders, sending a test invite to a throwaway email works, the row shows up in Pending. Cancel it, confirm it disappears.

- [ ] **Step 4: Commit**

```bash
git add src/pages/AdminInvites.tsx src/i18n/
git commit -m "AdminInvites: send + pending + awaiting-designation sections"
```

---

## Task 15: AdminUsers — search + promote-to-trainer / promote-to-admin

**Files:**
- Modify: `src/pages/AdminUsers.tsx` (replace stub)
- Modify: `src/sharing.ts` (add `promoteToAdmin` helper, update `promoteToTrainer` doc comment)
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: Add `promoteToAdmin` helper + update `promoteToTrainer` doc**

In `src/sharing.ts`, update the `promoteToTrainer` doc-comment (lines 72–74) from "Callable only by trainers" to "Callable only by admins". Append after the function:

```ts
/** Promotes another user to admin. Callable only by admins; the
 *  promote_to_admin SECURITY DEFINER RPC enforces that. */
export async function promoteToAdmin(target: string): Promise<void> {
  const res = await getSupabase().rpc('promote_to_admin', { target }) as
    { error: { message: string } | null };
  if (res.error) {
    log.error(CATEGORY.auth, 'promote admin failed', { target, message: res.error.message });
    throw new Error(res.error.message);
  }
  log.info(CATEGORY.auth, 'promoted admin', { target });
}
```

- [ ] **Step 2: i18n strings**

In `src/i18n/types.ts`:
```ts
adminUsers: {
  searchPlaceholder: string;
  badgeTrainer: string;
  badgeAdmin: string;
  promoteTrainer: string;
  promoteAdmin: string;
  confirmPromoteTrainer: string;
  confirmPromoteAdmin: string;
  promoted: string;
  empty: string;
};
```

In `en.ts`:
```ts
adminUsers: {
  searchPlaceholder: 'Search by display name…',
  badgeTrainer: 'Trainer',
  badgeAdmin:   'Admin',
  promoteTrainer: 'Promote to Trainer',
  promoteAdmin:   'Promote to Admin',
  confirmPromoteTrainer: 'Promote this user to Trainer?',
  confirmPromoteAdmin:   'Promote this user to Admin?',
  promoted: 'Promoted',
  empty: 'No users found.',
},
```

In `zh-Hant.ts`:
```ts
adminUsers: {
  searchPlaceholder: '搜尋顯示名稱…',
  badgeTrainer: '教練',
  badgeAdmin:   '管理員',
  promoteTrainer: '升為教練',
  promoteAdmin:   '升為管理員',
  confirmPromoteTrainer: '確定升為教練？',
  confirmPromoteAdmin:   '確定升為管理員？',
  promoted: '已升級',
  empty: '無用戶。',
},
```

- [ ] **Step 3: Implement AdminUsers**

Replace `src/pages/AdminUsers.tsx`:

```tsx
import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';
import { promoteToTrainer, promoteToAdmin } from '../sharing';

interface UserRow { id: string; display_name: string | null; is_trainer: boolean; is_admin: boolean }

export function AdminUsers() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<UserRow[]>([]);
  const [searching, setSearching] = useState(false);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    try {
      const res = await getSupabase().from('profiles')
        .select('id, display_name, is_trainer, is_admin')
        .ilike('display_name', `%${q.trim()}%`)
        .limit(50) as { data: UserRow[] | null; error: { message: string } | null };
      setRows(res.data ?? []);
    } finally {
      setSearching(false);
    }
  }

  function applyPromotion(id: string, what: 'trainer' | 'admin') {
    setRows((prev) => prev.map((r) =>
      r.id === id ? { ...r, is_trainer: what === 'trainer' ? true : r.is_trainer, is_admin: what === 'admin' ? true : r.is_admin } : r
    ));
  }

  return (
    <div className="p-4 space-y-4 text-slate-100">
      <form onSubmit={runSearch} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.adminUsers.searchPlaceholder}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
        />
        <button
          type="submit"
          disabled={searching}
          className="px-3 py-2 bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded-lg text-sm"
        >{searching ? '…' : t.common.search.replace('…', '')}</button>
      </form>

      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm">{t.adminUsers.empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((u) => <UserRow key={u.id} u={u} onPromote={applyPromotion} />)}
        </ul>
      )}
    </div>
  );
}

function UserRow({ u, onPromote }: { u: UserRow; onPromote: (id: string, what: 'trainer'|'admin') => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<null | 'trainer' | 'admin'>(null);

  async function doPromote(what: 'trainer' | 'admin') {
    const msg = what === 'trainer' ? t.adminUsers.confirmPromoteTrainer : t.adminUsers.confirmPromoteAdmin;
    if (!confirm(msg)) return;
    setBusy(what);
    try {
      if (what === 'trainer') await promoteToTrainer(u.id);
      else                    await promoteToAdmin(u.id);
      onPromote(u.id, what);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 flex items-center gap-2 text-sm">
      <span className="flex-1 truncate">{u.display_name ?? '(no name)'}</span>
      {u.is_trainer && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-keung-600/30 border-keung-600/60 text-keung-300">{t.adminUsers.badgeTrainer}</span>}
      {u.is_admin   && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border bg-amber-600/30 border-amber-600/60 text-amber-300">{t.adminUsers.badgeAdmin}</span>}
      {!u.is_trainer && (
        <button onClick={() => void doPromote('trainer')} disabled={busy !== null}
          className="text-[11px] text-slate-300 hover:text-white disabled:opacity-50">
          {busy === 'trainer' ? '…' : t.adminUsers.promoteTrainer}
        </button>
      )}
      {!u.is_admin && (
        <button onClick={() => void doPromote('admin')} disabled={busy !== null}
          className="text-[11px] text-slate-300 hover:text-white disabled:opacity-50">
          {busy === 'admin' ? '…' : t.adminUsers.promoteAdmin}
        </button>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Smoke + commit**

```
npx tsc -b --noEmit
git add src/pages/AdminUsers.tsx src/sharing.ts src/i18n/
git commit -m "AdminUsers: search + promote-to-trainer + promote-to-admin"
```

---

## Task 16: AdminAudit — paginated read-only audit feed

**Files:**
- Modify: `src/pages/AdminAudit.tsx` (replace stub)
- Modify: `src/i18n/types.ts`, `src/i18n/en.ts`, `src/i18n/zh-Hant.ts`

- [ ] **Step 1: i18n strings**

In `src/i18n/types.ts`:
```ts
adminAudit: { title: string; older: string; newer: string; empty: string };
```

In `en.ts`:
```ts
adminAudit: { title: 'Audit log', older: 'Older →', newer: '← Newer', empty: 'No events.' },
```

In `zh-Hant.ts`:
```ts
adminAudit: { title: '紀錄', older: '較舊 →', newer: '← 較新', empty: '無記錄。' },
```

- [ ] **Step 2: Implement AdminAudit**

Replace `src/pages/AdminAudit.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';

interface AuditRow {
  id: string;
  user_id: string;
  event_type: string;
  resource: unknown;
  metadata: unknown;
  created_at: string;
}

const PAGE = 50;

export function AdminAudit() {
  const { t } = useI18n();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getSupabase().from('audit_events')
        .select('id, user_id, event_type, resource, metadata, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1) as { data: AuditRow[] | null };
      if (!cancelled) setRows(res.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [offset]);

  return (
    <div className="p-4 space-y-3 text-slate-100">
      <h2 className="text-lg font-bold">{t.adminAudit.title}</h2>
      {rows.length === 0 ? (
        <p className="text-slate-500 text-sm">{t.adminAudit.empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="bg-slate-800 rounded-lg border border-slate-700 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                className="w-full text-left flex items-center gap-2"
              >
                <span className="text-slate-500 tabular-nums">{new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)}</span>
                <span className="font-mono">{r.event_type}</span>
              </button>
              {expandedId === r.id && (
                <pre className="mt-2 text-[10px] text-slate-300 whitespace-pre-wrap break-words">
{JSON.stringify({ user_id: r.user_id, resource: r.resource, metadata: r.metadata }, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => setOffset(Math.max(0, offset - PAGE))}
          disabled={offset === 0}
          className="text-xs text-slate-400 disabled:opacity-30"
        >{t.adminAudit.newer}</button>
        <button
          type="button"
          onClick={() => setOffset(offset + PAGE)}
          disabled={rows.length < PAGE}
          className="text-xs text-slate-400 disabled:opacity-30"
        >{t.adminAudit.older}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```
npx tsc -b --noEmit
git add src/pages/AdminAudit.tsx src/i18n/
git commit -m "AdminAudit: paginated read-only audit-events feed"
```

---

## Task 17: Doc-comment cleanup — useInvitations + sharing

**Files:**
- Modify: `src/useInvitations.ts`
- Modify: `src/sharing.ts` (verify Task 15's doc-comment landed)

- [ ] **Step 1: Reword useInvitations header**

Edit `src/useInvitations.ts` lines 1–9. Replace any wording like "trainer's outbound invitations" with "admin's outbound invitations" (the inviter is now always the admin). Also update line 93's inline comment about "MyTrainees gates on isTrainer above this hook" since the gate is now mode-based.

- [ ] **Step 2: Confirm sharing.ts doc was updated in Task 15**

Run: `grep -n "Callable only by" src/sharing.ts`
Expected: at least the `promoteToTrainer` line says "Callable only by admins" — if it still says "trainers", fix it.

- [ ] **Step 3: Commit**

```bash
git add src/useInvitations.ts src/sharing.ts
git commit -m "docs: reword comments where role ownership changed"
```

---

## Task 18: RLS regression test — trainer can still read audit_events for accepted trainee

**Files:**
- Test: this is a manual MCP verification, not a unit test

- [ ] **Step 1: Verify trainer-of-accepted-designation can still read trainee's audit_events**

Use MCP `execute_sql` (which bypasses RLS as service role) to set up a probe, then test the policy. First, verify the audit_events_read policy body matches expectations:

```sql
select pg_get_expr(polqual, polrelid)
  from pg_policy
 where polname = 'audit_events_read'
   and polrelid = 'public.audit_events'::regclass;
```

Expected output contains both `is_admin()` and a `trainer_trainees` subquery with `status = 'accepted'` — confirms the trainer clause was preserved.

- [ ] **Step 2: Verify the admin can read all rows**

```sql
select count(*) from audit_events;
```

Run as service role (MCP). Note the count. Then confirm policy permits admin read by reading the policy expression includes `public.is_admin()` (already confirmed in step 1).

- [ ] **Step 3: Verify designate_invited_user is gone**

```sql
select to_regprocedure('public.designate_invited_user(uuid)') as fn;
```

Expected: NULL.

- [ ] **Step 4: No commit needed** (no file changes; verification only)

---

## Task 19: End-to-end smoke

- [ ] **Step 1: Run the dev server and walk through each role**

```bash
npm run dev
```

Open `http://localhost:5173/`. Log in as Leo (you, who is now both trainer and admin).

Walk through:
1. **Trainee mode** (default): bottom nav shows Home / Plans / Library / Metrics. Header border is slate. Mode switcher visible in header (because you have 3 roles).
2. **Switch to Trainer mode** via the switcher pill. URL becomes `/trainer`. Bottom nav switches to Trainees / Exercises / Bundles / Dashboard. Header border tints keung-green.
3. **Trainees tab**: search for a user (e.g. "Shadow"), designate them, see the row appear in Pending.
4. **Dashboard**: pending row from step 3 shows here. Quick-action "+ Designate a user" jumps back to Trainees with search focused.
5. **Switch to Admin mode**. URL becomes `/admin/invites`. Bottom nav: Invites / Users / Audit. Header tint amber.
6. **Invites**: send an invite to a throwaway email. Row appears in Pending. Cancel it.
7. **Users**: search yourself by display name. Confirm Trainer + Admin badges visible. No promote buttons (you're already both).
8. **Audit**: see recent events. Click one to expand JSON.
9. **Switch back to Trainee mode**. Returns to `/`. Bottom nav reverts.
10. **Hit `/trainer/trainees` directly while in Trainee mode** (paste URL in browser). ModeGate auto-switches you to Trainer mode in-memory; the URL renders correctly. Inspect localStorage `ahkeung:roleMode` — should still be `trainee` (transient switch did NOT persist).

- [ ] **Step 2: Run the full test suite**

```bash
npx vitest run
npx tsc -b --noEmit
npx eslint src/
```

Expected: green. Address any failures inline before committing.

- [ ] **Step 3: Final commit of any incidental cleanup**

```bash
git status
# If anything's dirty, decide whether to commit or revert.
```

---

## Task 20: Done — PR

- [ ] **Step 1: Push the branch and open a PR**

If you've been on `main` directly (per repo convention from recent commits), push:

```bash
git push -u origin main
```

If you'd like a PR instead, branch and push:

```bash
git checkout -b role-separation
git push -u origin role-separation
gh pr create --title "Role separation UI — admin role + per-mode shell" --body "$(cat <<'EOF'
## Summary
- Adds `profiles.is_admin` role flag; admin owns invite/promote/audit-read power
- Header mode switcher (Trainee / Trainer / Admin) for multi-role users
- Routes re-prefixed to `/trainer/*` and `/admin/*`; legacy URL redirects preserved
- Three new admin pages (Invites / Users / Audit) + trainer Dashboard
- See spec at docs/superpowers/specs/2026-05-25-role-separation-ui-design.md

## Test plan
- [ ] Walked through all three modes as Leo (trainer + admin)
- [ ] Confirmed pure-trainee user (no isTrainer / no isAdmin) sees zero UI change
- [ ] Confirmed mode switcher hidden for single-role users
- [ ] Confirmed transient auto-switch on direct deep-link does not persist
- [ ] Verified RLS: trainer can still read audit_events for accepted trainees

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Spec coverage check

- [x] Migration 0013 (column, RLS rewrites, RPC swaps, RPC drop, seed) — Task 1
- [x] Edge function guard — Task 2
- [x] Profile shape + cache hydration — Task 3
- [x] Test stubs — Task 4
- [x] RoleMode (with reactive demotion reset + transient setter) — Task 5
- [x] ModeGate (transient auto-switch + redirect) — Task 6
- [x] ModeSwitcher (visibility, persistent setMode + navigate) — Task 7
- [x] Shell: provider mount, NAV_BY_MODE, header tint — Task 8
- [x] Routes re-prefix + ModeGate wrap + legacy redirects — Task 9
- [x] In-app caller rewrites — Task 10
- [x] Settings refactor (badge stack, drop grid) — Task 11
- [x] MyTrainees refactor (strip invite + PromoteButton + designate-from-invitation) — Task 12
- [x] TrainerDashboard — Task 13
- [x] AdminInvites — Task 14
- [x] AdminUsers + promoteToAdmin helper — Task 15
- [x] AdminAudit — Task 16
- [x] Doc-comment cleanup (useInvitations, sharing, invite-user) — Tasks 2, 15, 17
- [x] RLS regression verification — Task 18
- [x] E2E smoke (all 3 modes + transient auto-switch) — Task 19

**Out of scope (deliberately deferred):**
- `useIsTrainer` deletion — kept as general utility per spec
- Recent-trainee-activity section in TrainerDashboard (Task 13 note)
- Multi-tab localStorage sync — accepted limitation per spec
- Mid-edit unsaved-changes guard — accepted limitation per spec
