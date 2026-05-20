# Operational logging + diagnostics

**Status:** revised after independent review, ready to implement
**Scope:** observable client + server activity so the next time something
breaks ("trainee can't see invitations", "image upload stuck"), the path
from "user reports it" to "I know exactly what happened" is minutes,
not the multi-step debug-by-screenshot we've been doing.

> **Revision note.** This revision folds in all 3 blocking + 7
> should-fix findings from the independent review at the foot of
> this doc. The biggest shape changes:
> - Logger now lives in **its own Dexie database**
>   (`ah-keung-diagnostics`) so sign-out doesn't wipe it (S4).
> - Audit-event triggers explicitly read the actor from `NEW.*`
>   columns and gate on `NEW.already_existed` to avoid double-emit
>   (B1, B2).
> - Ring-buffer trim has a concrete algorithm: in-memory queue +
>   debounced bulkAdd + prune-by-count (B3).
> - `diagnostics_reports` and `audit_events` RLS tightened to
>   "owner OR designated-trainer," not the broader `is_trainer()`
>   (S5).
> - Storage/volume figures recomputed (S8); `pg_cron` TTL job
>   written out.
> - Remote alerting promoted from "v1.1 risk" to **PR F** (S9).
>
> Operator decisions still locked: log levels = `info + warn +
> error`; display names never masked; audit events from both
> triggers + Edge Functions; buffer size 500.

## Why now

Pattern of issues we've debugged in the last few iterations:

- Sync queue stuck because of a missing `deleted_at` column.
- Timestamp serialization mismatch on `designated_at` / `responded_at`.
- Pull worker silently skipping 5 of 9 tables.
- Storage RLS rejecting uploads with a generic `400` until we sniffed
  the response body.
- PKCE silently swallowing invite links until we read the client
  config.

Every one of those would have been pinpointed in seconds with a real
log trail. The current pattern — "paste the console error you happen
to see" — works for power users with desktop browsers but not for
mobile-only users (no console) or for issues that have already
scrolled off-screen by the time they think to look.

## Goals

- **Client log surface.** A tiny structured logger that wraps
  `console.{log,warn,error}` and also writes to an IndexedDB ring
  buffer. Survives reloads; doesn't survive sign-out (the existing
  sign-out wipe takes care of that).
- **Self-service diagnostics.** Settings → **Diagnostics** panel that
  shows the last N entries and offers a one-tap "Send to support"
  button that uploads the buffer + a small environment snapshot to a
  Supabase-side store.
- **Server-side audit trail.** An `audit_events` table for the
  business-critical state transitions (invite issued, designation
  accepted, share created, plan assigned, exercise deleted) so we can
  reconstruct "what happened just before X went wrong" without
  reading raw row history.
- **Supabase log access pointers.** A README section pointing at
  where Edge Function logs, Auth logs, PostgREST logs, and slow query
  logs live in the dashboard, so we stop rediscovering them every
  time.

## Non-goals

- **Real-time observability platform** (Sentry / Datadog / Honeycomb).
  Worth doing eventually, but the marginal value over a structured
  in-app diagnostics dump at this scale (~tens of users) is small.
  Plan leaves a hook for it (see PR E in the execution plan).
- **Performance metrics / RUM**. Not the pain point right now; the
  pain is correctness/state debugging, not p99 latency.
- **PII handling beyond masking obvious fields.** This is a beta with
  trust between operators and users; we'll mask emails and never log
  passwords/JWTs, but we're not going to ship a GDPR-grade redactor.

## Layered design

Four layers, each independently shippable.

### Layer 1 — Client structured logger + ring buffer

Two modules: a typed Category const and the logger itself.

```ts
// src/diagnostics/categories.ts
export const CATEGORY = {
  sync: 'sync', auth: 'auth', invite: 'invite',
  share: 'share', exercise: 'exercise', bundle: 'bundle',
  onboarding: 'onboarding', settings: 'settings',
  uncaught: 'uncaught', 'unhandled-rejection': 'unhandled-rejection',
  'image-upload': 'image-upload',
} as const;
export type Category = typeof CATEGORY[keyof typeof CATEGORY];
```

`log.warn(c: Category, …)` — a typo in the category becomes a
compile error rather than fragmenting the buffer's vocabulary (W11).

```ts
// src/diagnostics/logger.ts
type Level = 'info' | 'warn' | 'error';

interface LogEntry {
  ts: number;          // epoch ms
  level: Level;
  category: Category;
  message: string;
  context?: Record<string, unknown>;  // structured fields
  errorStack?: string; // captured when an Error is supplied to log.error
}

export const log = {
  info(category: Category,  message: string, context?: Record<string, unknown>): void,
  warn(category: Category,  message: string, context?: Record<string, unknown>): void,
  error(category: Category, message: string, contextOrError?: unknown): void,
};

export function recentLog(limit = 500): Promise<LogEntry[]>;
export function clearLog(): Promise<void>;
```

**Storage location (S4):** the buffer lives in its **own** Dexie
database (`ah-keung-diagnostics`), NOT in the existing `ah-keung`
DB. That isolation is the entire point — the existing sign-out
handler does `db.delete()` on `ah-keung` to wipe user data, but the
diagnostics DB is untouched, so the buffer survives sign-out (the
common act-of-frustration that immediately precedes "let me file a
support report"). Settings → Diagnostics gets an explicit
**Clear all diagnostics** action so the user retains control.
Schema:

```
ah-keung-diagnostics:
  diagnostics_log: ++seq, ts
```

Auto-increment seq for stable ordering even on equal `ts`; `ts`
indexed so the prune query (`where ts < cutoff`) is cheap.

**Ring-buffer trim (B3).** No race-prone "count + delete oldest on
every insert" pattern. Instead:

1. **In-memory queue.** Every `log.*` call appends to a module-level
   `pending: LogEntry[]` array — pure JS, single-threaded, no race.
2. **Debounced flush** every 250 ms (or immediately on `pending.length
   >= 50` so a sudden error storm doesn't sit in memory). Flush =
   one `db.diagnostics_log.bulkAdd(pending.splice(0))` transaction.
3. **Post-flush prune.** After bulkAdd, if the table count exceeds
   500, delete the oldest rows by `seq` until count = 500. Done in
   the same transaction. One concurrent flusher only — a `flushing`
   guard skips re-entry; the next interval picks up anything that
   queued during the flush.

The 250 ms debounce also addresses iOS Safari's slow IndexedDB
writes under memory pressure (risk #2 in the original) — never
more than 4 transactions/sec regardless of emit rate.

**Levels & dev-mode mirror (S7).**
- `info` — user actions, successful state transitions, sync ticks.
  Buffered. In dev (`import.meta.env.DEV`), also mirrored to
  `console.log` so contributors see the live trace.
- `warn` — recoverable problems (OCC conflict + retry, network
  hiccup). Buffered AND mirrored to `console.warn` always.
- `error` — unrecoverable for this attempt (dead-letter, uncaught
  exception). Buffered AND mirrored to `console.error` always.

**Stack truncation (S10).** When an `Error` is passed to
`log.error`, capture `.stack` but truncate to the first 2 KB (or
top 10 frames, whichever is shorter). A noisy error storm during a
network blip can't burn the buffer on multi-KB stack traces.

A separate module `src/diagnostics/install.ts` registers global
handlers once at app boot:

```ts
window.addEventListener('error', (e) => log.error('uncaught', e.message, { stack: e.error?.stack }));
window.addEventListener('unhandledrejection', (e) => log.error('unhandled-rejection', String(e.reason)));
```

### Layer 2 — Strategic logger call sites

Replace `console.warn('[sync]', e)` and similar with structured
`log.warn`/`log.error` at the existing observation points:

| Site | Today | After |
|---|---|---|
| `src/sync/index.ts` `safeRun` | `console.warn('[sync]', e)` | `log.error('sync', 'tick failed', e)` |
| `src/sync/pushWorker.ts` conflict retry | (silent) | `log.warn('sync', 'OCC conflict, retrying', { table, rowId, attempts })` |
| `src/sync/pushWorker.ts` dead-letter | (silent) | `log.error('sync', 'moved to dead letter', { table, rowId, lastError })` |
| `src/sync/imageUploadSweep.ts` failure | `console.warn('[image upload]', …)` | `log.error('image-upload', 'storage upload failed', { id, message })` |
| `src/sync/pullWorker.ts` page fetched | (silent) | `log.debug('sync', 'pulled page', { table, rows, cursor })` |
| `src/auth/AuthProvider.tsx` URL token consumed | (silent) | `log.info('auth', 'verifyOtp', { type, success })` |
| `src/auth/AuthProvider.tsx` profile fetch failure | falls back to cache | `log.warn('auth', 'profile fetch failed', { error })` |
| `src/invitations.ts` | (silent) | `log.info('invite', 'sent', { alreadyExisted })` / `log.error('invite', 'failed', { error })` |
| `src/sharing.ts` | (silent) | `log.info('share', 'created', { type, resourceId })` |
| `src/pages/ExerciseEditor.tsx` save | (silent) | `log.info('exercise', 'saved', { id, hadImage })` |
| `src/pages/Onboarding.tsx` submit | (silent) | `log.info('onboarding', 'complete')` |

The categories above are the rough vocabulary; codify them as a const
so typos don't fragment the log.

### Layer 3 — Diagnostics panel in Settings

New section visible to every signed-in user:

```
┌─────────────────────────────────────────────────┐
│ Diagnostics                                     │
│ Last 100 entries (showing 100 of 500 buffered) │
│ ┌─────────────────────────────────────────────┐ │
│ │ 14:21:08 ERROR sync push tick failed         │ │
│ │            { table: 'plans', code: '23505'} │ │
│ │ 14:21:08 WARN  sync OCC conflict retry      │ │
│ │ 14:20:55 INFO  share created                 │ │
│ │ …                                            │ │
│ └─────────────────────────────────────────────┘ │
│  [Copy to clipboard]  [Send to support]  [Clear]│
└─────────────────────────────────────────────────┘
```

- **Copy to clipboard** — JSON.stringify(entries) so the user can
  paste into Slack / email manually if they're offline.
- **Send to support** — calls Edge Function `submit-diagnostics`
  (layer 4 below) with the buffer + a small environment snapshot
  (user-agent, locale, screen size, app build hash, last-known
  sync timestamps). Returns a short reference ID the user reads back
  to support.
- **Clear** — confirms, then wipes the buffer. Doesn't sign the user
  out or touch anything else.

The panel is collapsed by default with just a "View diagnostics" link;
expanding fetches the buffer.

### Layer 4 — `submit-diagnostics` Edge Function + storage

New table `diagnostics_reports`:

```sql
create table diagnostics_reports (
  id           uuid        primary key default gen_random_uuid(),
  short_code   text        not null unique,  -- 6-char base32, user-readable
  user_id      uuid        not null references profiles(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  app_version  text,             -- git sha, set by vite-define at build time
  user_agent   text,
  locale       text,
  payload      jsonb       not null,  -- the actual log entries + env snapshot
  notes        text                    -- optional free-text from the user
);

create index diagnostics_user on diagnostics_reports(user_id, submitted_at desc);
```

**Short code (W12).** Generated server-side in the Edge Function:
6 random characters from the Crockford base32 alphabet (no
ambiguous 0/O/1/I/L). Collision space ≈ 1 billion — at hundreds of
reports/year, collisions are astronomically unlikely; the function
retries on the `unique` constraint anyway.

**RLS (S5).** Tighter than the original draft — diagnostics
reports include the full client log and are materially more
sensitive than display names. SELECT scope:

```sql
create policy diagnostics_reports_read on diagnostics_reports for select using (
  user_id = auth.uid()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = diagnostics_reports.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);
```

- INSERT only via the Edge Function (service role bypasses RLS).
- SELECT for the report owner, AND for a trainer who has an
  `accepted` designation with that trainee. Replaces the broader
  `is_trainer()` predicate from the original draft.
- No UPDATE / DELETE policies — reports are immutable.

Edge Function `submit-diagnostics`:
- Two-client pattern (same as `invite-user`): user client for
  `getUser()` to authenticate, admin client for the insert.
- Validates payload size (cap at ~512 KB JSON to avoid spam).
- Generates `short_code` via base32; retries on unique conflict.
- Inserts the row, returns `{ ok: true, id, shortCode }`. The UI
  shows the short code prominently so the user can read it back
  to support.

**Operator lookup (W13).** A one-line SQL recipe lives in
`docs/operational-runbook.md`:

```sql
select payload, notes, submitted_at, user_id
  from diagnostics_reports
 where short_code = $1;
```

Plus a paired query for `audit_events` filtered to the same user
between `now() - interval '1 day'` and `submitted_at`.

### (Optional, future) Layer 5 — Sentry / Axiom integration

A 1-file wrapper that piggybacks on the logger:

```ts
// src/diagnostics/sentry.ts (illustrative — not in v1)
import * as Sentry from '@sentry/browser';
import { onLog } from './logger';
onLog((entry) => {
  if (entry.level === 'error') Sentry.captureMessage(entry.message, {
    extra: entry.context,
    level: 'error',
  });
});
```

`onLog` is a tap added to the logger module specifically so this
integration is a one-import affair when/if we want it. v1 doesn't
include the actual integration — just the tap interface.

### Server-side audit trail

Separate from the client log: a database table that records
business-meaningful events server-side, immune to client tampering.

```sql
create table audit_events (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references profiles(id) on delete set null,
  event_type text        not null,  -- e.g. 'invite.sent', 'share.created'
  resource   jsonb,                 -- { type, id, …}
  metadata   jsonb,                 -- event-specific context
  created_at timestamptz not null default now()
);

create index audit_events_user on audit_events(user_id, created_at desc);
create index audit_events_type on audit_events(event_type, created_at desc);
```

`user_id` semantics (W14): nullable on purpose. `null` means
"system event" (cron prune, scheduled task). All human-attributable
events MUST populate `user_id` from `NEW.*` columns, since trigger
context running under `service_role` (which is how the Edge
Functions write) has a null `auth.uid()`.

Sources of events — **triggers + Edge Functions, both**.

#### Triggers

| Source table | Fires on | Actor (→ `user_id`) | event_type | Gate |
|---|---|---|---|---|
| `invitations` | INSERT, `NEW.already_existed = false` | `NEW.inviter_id` | `invite.sent` | **B1**: skip when `already_existed = true` — the function emits its own event |
| `invitations` | INSERT, `NEW.already_existed = true` | `NEW.inviter_id` | `invite.already_existed` | (function path; see below) |
| `invitations` | UPDATE, `cancelled_at` flipped | `NEW.inviter_id` | `invite.cancelled` | NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL |
| `invitations` | UPDATE, `accepted_at` flipped | `NEW.inviter_id` | `invite.accepted` | NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL |
| `trainer_trainees` | INSERT | `NEW.trainer_id` | `designation.created` | — |
| `trainer_trainees` | UPDATE, status → 'accepted' | `NEW.trainee_id` | `designation.accepted` | NEW.status='accepted' AND OLD.status<>'accepted' |
| `trainer_trainees` | UPDATE, status → 'declined' | `NEW.trainee_id` | `designation.declined` | NEW.status='declined' AND OLD.status<>'declined' |
| `trainer_trainees` | DELETE | `OLD.trainer_id` | `designation.removed` | — |
| `shares` | INSERT, `deleted_at IS NULL` | `NEW.granter_id` | `share.created` | — |
| `shares` | UPDATE, `deleted_at` flipped | `NEW.granter_id` | `share.revoked` | NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL |
| `exercises` | UPDATE, `deleted_at` flipped | `NEW.owner_id` | `exercise.deleted` | same gate |
| `exercise_bundles` | UPDATE, `deleted_at` flipped | `NEW.owner_id` | `bundle.deleted` | same gate |

Every trigger function is `SECURITY DEFINER set search_path =
public` so it can write into `audit_events` regardless of the
caller's role. Each function reads the actor explicitly from
`NEW.*` (or `OLD.*` for DELETE) — never from `auth.uid()`, which
is null when the writer is `service_role` (B2).

#### Edge Functions / RPCs

- **`invite-user`** (`invite.already_existed` branch only) —
  writes the audit row directly when Supabase rejects the invite
  because the user is already registered. Metadata:
  `{ inviter, email_masked, ua }`. The `invite.sent` event is
  emitted by the trigger above for the fresh-invite branch only,
  per the `NEW.already_existed = false` gate — no double-emit.
- **`share_plan`** — emits `plan.shared` with
  `{ original_plan_id, cloned_plan_id, recipient, exercise_count }`.
  The trigger on `plans` INSERT can't see `original_plan_id`
  because it's not on the row.
- **`promote_to_trainer`** — emits `trainer.promoted` with
  `{ promoter, promoted }`. A trigger on `profiles` UPDATE could
  detect that `is_trainer` flipped but can't see who flipped it.

**RLS (S5)** — same tightening as `diagnostics_reports`. Owner OR
trainer with an `accepted` designation to that user:

```sql
create policy audit_events_read on audit_events for select using (
  user_id = auth.uid()
  or exists (
    select 1 from trainer_trainees t
    where t.trainee_id = audit_events.user_id
      and t.trainer_id = auth.uid()
      and t.status = 'accepted'
  )
);
```

No INSERT/UPDATE/DELETE policies — only `service_role` writes (the
triggers and Edge Functions are SECURITY DEFINER, which bypasses
RLS by definition).

## Pointers to existing Supabase logs (the cheap layer)

Most operational issues we've hit ARE visible in the Supabase
dashboard already; we just don't reach for it first. Document in
`README.md` and pin the link:

- **Edge Function logs** → Dashboard → Edge Functions → `<function>` →
  Logs tab. Records every invocation with stdout/stderr.
- **Auth logs** → Dashboard → Authentication → Logs. Records sign-in
  attempts, magic-link issuance, password resets, with the user's IP
  and timestamp.
- **PostgREST logs** → Dashboard → Logs → Postgres Logs. Records
  every query (sample-rate based on plan). Filter by `role =
  'authenticated'` for user-driven queries.
- **Realtime logs** → Dashboard → Logs → Realtime. Not currently
  used but listed for completeness.
- **Storage logs** → Dashboard → Logs → Storage. The path/policy
  failures we hit on the photo-upload bucket would have surfaced
  here had we looked.

A small `docs/operational-runbook.md` cross-references these with
specific symptom → "look here" mappings.

## Privacy + safety

What we log (in either diagnostics or audit_events):

- User IDs (UUIDs) — freely.
- Timestamps, table names, error messages, error stacks.
- Exercise IDs, plan IDs, share IDs.
- **Display names — freely.** Operator-friendliness wins; "Leo
  couldn't accept" is meaningfully different from
  "7d46… couldn't accept" when reading a 100-line log.

What we never log (anywhere):

- Passwords, JWTs, refresh tokens, or any auth/session credentials.
- Full email addresses — masked to `a***@example.com`. Emails are
  the recoverable PII most likely to leak via a misplaced screenshot
  of a diagnostics dump; user IDs are opaque, display names are
  what people already share inside the app anyway.

Logger exports a `maskEmail(s)` helper. The logger itself does NOT
auto-redact arbitrary fields — call sites pass `maskEmail(user.email)`
explicitly when an email needs to land in the context. Keeping
masking explicit avoids the "automatic redactor stripped something
useful" failure mode.

**Enforcement (S6).** "Explicit at every call site" is correct in
principle but loses the next time a contributor writes
`log.warn('invite', 'failed', { email: user.email })` without
remembering the helper. PR A ships a small ESLint rule
(`local/no-unmasked-email` in `eslint.config.js`) that flags any
LogContext literal containing an `email:` key whose value isn't
either a `maskEmail(...)` call or a literal string already in
masked form (`/^[^@]\*+@/`). Violations are lint errors, not
warnings, so CI catches them before merge.

## Storage / volume

Per-user ring buffer (500 entries × ~600 bytes avg) ≈ **300 KB**
worst-case in IndexedDB. Trivial.

`diagnostics_reports` table — assume <5 reports per user per month at
peak, ~200 KB each → ~10 MB per 10 users per month. Trivial.

`audit_events` table (revised per S8; original estimate was off
~5×). The volume is dominated by sync ticks and user actions:

- **Sync events** at active use: push every 30s + pull every 60s
  → ~3 events/min when the app is open. Assume 2h active/day per
  user → **360 sync events/user/day**.
- **User actions** (share, designate, invite, plan edit, exercise
  save, etc.): variable but call it **50/user/day** at peak.
- **Triggered events** (designation accepts, shares created, etc.)
  ride on top of the user-action count, but the trigger gates
  collapse them to one row per state transition.

Realistic peak: **~500/user/day**. At 100 users → 50k rows/day →
~15 MB/day → **~1.5 GB at 90-day TTL**.

That's still cheap relative to Supabase's Free 500 MB DB or any
paid tier, but the cutoff has to actually be enforced. The TTL is
a real `pg_cron` job that ships with the migration:

```sql
-- Requires pg_cron extension (enable in Dashboard → Database →
-- Extensions). The job runs daily at 03:00 UTC.
select cron.schedule(
  'prune-audit-events',
  '0 3 * * *',
  $$
    delete from audit_events
     where created_at < now() - interval '90 days';
  $$
);
```

If `pg_cron` isn't available on your tier, the fallback is a
Supabase Edge Function on a GitHub-Actions cron that hits an RPC.
Spec'd in the migration as a comment; not blocking PR-E since
180-day or 365-day retention is fine while we're under 1 GB.

## Execution plan (6 PRs)

PR A and PR B build the client side. PR C combines the
Edge Function + table + Settings panel into one ship — sending
them separately means users see a "Send" button that doesn't work
yet (the original draft's PR-C-before-PR-D inversion; O15). PR D
ships the server-side audit trail. PR E ships the remote-alerting
cron (promoted from "v1.1 risk"; S9) so dead-letter growth doesn't
sit silent.

1. **PR A — Logger module + own Dexie database + console-mirror.**
   `src/diagnostics/{categories,logger,install}.ts`. Buffer lives
   in a separate `ah-keung-diagnostics` Dexie DB so sign-out
   doesn't wipe it (S4). Window handlers for `error` and
   `unhandledrejection`. ESLint rule for `no-unmasked-email`
   (S6). Stack-truncation utility (S10). Tests: insert / read /
   trim by count / mask helper / category typing / DEV-mode
   console mirror / buffer survives `ah-keung` deletion.
2. **PR B — Strategic call sites.** Replaces the ~10
   `console.warn`s in `src/sync/index.ts`,
   `src/sync/imageUploadSweep.ts`, etc. with `log.warn` /
   `log.error`. Adds new info-level emits at sync-success and
   user-action points listed above. Smoke-test by reading the
   buffer after a sync round-trip.
3. **PR C — Edge Function + `diagnostics_reports` + Settings
   panel** (combined — see O15). Migration with the table + RLS
   from this doc. `supabase/functions/submit-diagnostics/`
   following the same two-client pattern as `invite-user`. Short-
   code generation. Settings → Diagnostics panel: list view,
   Copy / Send / Clear actions. The Send button is live from day
   one. `docs/operational-runbook.md` gets the short-code lookup
   recipe (W13).
4. **PR D — `audit_events` table + triggers + Edge Function
   emits.** Migration with the table, RLS (owner OR designated
   trainer), all the triggers from the table above with the
   gates correctly set (B1) and `NEW.*`-based actor reads (B2).
   `invite-user` Edge Function gains the `already_existed`
   emit; `share_plan` and `promote_to_trainer` RPCs gain their
   structured emits. Tests assert one event per trigger
   condition, exactly. `pg_cron` job for 90-day TTL ships in the
   same migration with a fallback comment if `pg_cron` isn't
   available.
5. **PR E — Remote alerting** (S9). Daily Edge Function (or
   `pg_cron` job) that:
   - Counts `sync_dead_letter` rows; alerts if growth > N/day or
     total > M.
   - Counts `audit_events.event_type LIKE '%.failed'` in the
     last 24h; alerts on a spike.
   - Sends an email to the project owner via the same custom
     SMTP. ~30 lines.
6. **PR F (optional, deferred) — Sentry / Axiom tap.** Logger
   already exposes an `onLog` callback; integration is a single
   file. Re-evaluate after we have 100+ active users or hit the
   second class of issue this plan doesn't catch.

## Tests

- **Logger**: buffer trims to 500, mask redacts emails, error stack
  captured when an `Error` is passed.
- **Strategic call sites**: at least one assertion that a sync
  failure ends up in the buffer with category=sync, level=error.
- **Diagnostics panel**: copy-to-clipboard produces valid JSON;
  clear empties the buffer.
- **submit-diagnostics**: payload size cap (513 KB rejected);
  unauth caller returns 401; happy path returns a `reportId`.
- **audit_events**: invitation insert emits exactly one
  `invite.sent`; share creation emits one `share.created`; share
  revoke (via deleted_at flip) emits one `share.revoked`.

## Risks / open items

(Risk #1 from the original draft — "buffer flushes on sign-out" —
is resolved by S4: the logger uses its own Dexie database.
Risk #5 from the original — "no remote alerting" — is resolved by
S9: PR E ships a cron. Both have been removed from this list.)

1. **iOS Safari IndexedDB throughput.** Writes on iOS have
   historically been slow under memory pressure. Mitigated by the
   in-memory queue + 250 ms debounce + `bulkAdd` flush
   (≤4 transactions/sec regardless of emit rate; B3).
2. **Diagnostics upload over slow networks.** A 512 KB JSON over a
   3G handshake is non-trivial. The Edge Function streams the body
   to `diagnostics_reports.payload` directly (Postgres TOAST
   handles the compression); client shows a progress indicator.
3. **Audit log growth past 1 GB.** `pg_cron` 90-day TTL is in PR D.
   If usage outpaces that, partition the table by month (cheap
   migration when needed, not now).
4. **Diagnostics submitted via screenshot can leak masked-but-
   contextual data.** Even with emails masked and no display-name
   masking, a snippet of a screenshot shared in the wrong place
   could expose trainer↔trainee relationships and exercise
   content. Mitigation: the panel's Copy button copies JSON
   (not pretty-printed), making casual screenshotting harder than
   plain text. The Send-to-support button uploads via TLS to a
   table the recipient owns, no third-party hop.
5. **ESLint rule false positives.** `no-unmasked-email` flags any
   `email:` key whose value isn't `maskEmail(...)` or already-
   masked. Legitimate non-email fields named `email` would trip
   it (none exist today; flagged if one is added).

## Open decisions

All four locked by operator response on 2026-05-19:

- ✅ **Buffer size**: 500 entries / ~300 KB. User-configurable later
  if needed.
- ✅ **Log levels**: `info + warn + error` buffered; `debug` dropped
  entirely (every event we'd want to debug rises to info or above).
- ✅ **Display names**: **never masked** in either diagnostics or
  audit_events. The operator-friendliness of reading "Leo couldn't
  accept" trumps the marginal PII concern at beta scale. Emails
  still masked everywhere via `maskEmail()`; call sites pass that
  explicitly when an email goes into context.
- ✅ **Audit events**: **both triggers and Edge Functions** write
  rows. Triggers are the server-of-truth; Edge Functions add
  per-event context (caller UA, original-plan-id on plan.shared,
  promoter on trainer.promoted) that triggers can't see. No
  double-emit because the trigger and function paths use distinct
  `event_type` values.

---

## Review (independent)

An independent pass over this draft against the current code in
`src/db.ts`, `src/sync/*`, `src/auth/AuthProvider.tsx`, and the
existing migrations. Findings grouped by severity. The **Blocking**
items are schema/SQL-level mistakes that would ship as wrong audit
data — must be resolved before PR A starts.

### Blocking

**B1. Trigger double-emit on `invitations` INSERT.** The plan
claims "distinct `event_type` values mean no double-emit," but the
flow doesn't hold up. The Edge Function `invite-user` inserts a row
into `invitations` in *both* branches — the fresh-invite branch
(where Supabase emails the user) and the "already registered"
branch (where it doesn't). The proposed trigger on `invitations`
INSERT fires unconditionally and emits `invite.sent`. So an
"already in" invite would emit BOTH `invite.sent` (from the
trigger) AND `invite.already_existed` (from the function), making
it look like Supabase sent an email when it didn't. **Fix**: have
the trigger inspect `NEW.already_existed` and emit `invite.sent`
only when false; otherwise emit nothing and let the function emit
the `already_existed` event.

**B2. Trigger context has no `auth.uid()`.** The plan's
`audit_events.user_id` is meant to record "who did this," but when
the trigger fires from a `service_role` insert (every `invite-user`
call), `auth.uid()` is null inside the trigger context. If the
trigger uses `auth.uid()` for `user_id`, every invitation event
will have `user_id = null` — useless for audit. **Fix**: read the
actor from `NEW.inviter_id`, `NEW.granter_id`, `NEW.trainer_id`
etc. depending on the source table. Same fix applies to triggers
on `shares` (use `NEW.granter_id`) and `trainer_trainees` (use
`NEW.trainer_id` for create / `NEW.trainee_id` for trainee
response — distinguish via the row's prior state).

**B3. Ring-buffer trim semantics are unspecified.** "500 entries,
auto-trim on insert" + a hand-wave at "debounce 250ms" in the
risks doesn't constitute an implementation. Two concurrent emits
(push worker + image upload sweep, both firing during a busy sync
tick) racing on `count() + delete oldest` will either over-trim or
leave the buffer growing past 500. **Fix**: pick one and write it
down. Recommended: in-memory queue + debounced `bulkAdd` every
~250 ms + post-batch prune by `ts < (now - 7d)` OR by row count.
Or drop the "ring buffer" framing and call it a "periodic prune"
with a once-per-minute housekeeping pass that runs in the existing
sync orchestrator's tick.

### Should-fix

**S4. The buffer is wiped at exactly the worst time.** Risk #1
acknowledges it but the v1 decision was "nuked, easier." Threat
model is exactly backwards though: sign-out is what frustrated
users do when something's broken. Losing the pre-signout buffer
right before they want to file a report destroys the diagnostic
value. **Fix**: give the logger its own Dexie database
(`ah-keung-diagnostics`) that the existing `db.delete()` doesn't
touch. Needs a "Clear all diagnostics" action in Settings since
sign-out no longer does it — small UX cost, big debugging win.

**S5. `diagnostics_reports` RLS is too permissive.** Plan says
`SELECT user_id = auth.uid() OR is_trainer()`. W16 in the
trainer-exercises doc already flagged "any trainer reads any
user's data" as a beta-acceptable wide grant — but **diagnostics
reports include the full client log**, which is materially more
sensitive than display names or exercise rows. **Fix**: tighten the
SELECT policy to `owner OR (trainer with an 'accepted'
designation to this user via trainer_trainees)`. Apply the same
tightening to `audit_events`.

**S6. Email leak from "no automatic redactor."** The plan's
reasoning for explicit `maskEmail()` is sound, but in practice any
new contributor (or future-me) writes
`log.warn('invite', 'failed', { email: user.email, ... })` once
and ships an unmasked email. **Fix**: pick one enforcement layer.
Smallest cost: an ESLint custom rule banning `email` as an
unmasked context key. Stronger: a `MaskedEmail` branded type so
`context.email` requires `maskEmail(…)`. Strongest: runtime warn
in dev mode when the logger sees an `@` in any string-typed
context field. Recommend ESLint rule.

**S7. `info` to buffer-only is hostile in dev.** Production console
quiet is good; dev console quiet means contributors lose grep-able
event traces during local work. **Fix**: two lines —
`if (import.meta.env.DEV) console.log(...)` for the `info` path.
`warn`/`error` mirror policy stays.

**S8. `audit_events` volume estimate is wrong by ~5×.** "100
events/user/day at peak" doesn't square with the event list. Sync
ticks alone (push every 30s, pull every 60s) emit ~3 events/min
when active — call it 2 hours of active use → ~360/day from sync
alone. With share, designate, invite, plan-edit on top,
500–1000/day per user at peak is more realistic. With 100 users
that's 50–100k rows/day → ~15–30 MB/day → ~1.5–2.5 GB at 90-day
TTL. Still cheap, but the storage section's figures are off.
**Recompute** and **actually write the TTL job** — the plan says
"TTL job described above" but no SQL exists. Concrete: a `pg_cron`
job (or Edge Function on a daily cron) that runs
`delete from audit_events where created_at < now() - interval '90 days';`.

**S9. Promote remote alerting from "v1.1 risk" to a real PR.** The
entire plan exists because we keep discovering issues only when
users complain. The most common silent breakage we've had — stuck
dead-letter — happens to multiple users at once (it's a sync layer
bug, not user-specific) and currently no observability surface
tells the operator. A 30-line daily cron RPC that scans
`sync_dead_letter` (and `audit_events` for error-type spikes) and
emails the project owner above a threshold pays off the first time
it fires. **Fix**: add as PR F in the execution plan, not a future
risk.

**S10. Stack trace truncation policy missing.** A deeply-nested
rejected promise produces 50+ frames × ~80 chars ≈ 4 KB per
entry. 30 errors in quick succession during a network blip pushes
the buffer past 100 KB on stacks alone, displacing meaningful
older entries. **Fix**: cap each `errorStack` at ~2 KB (or top-10
frames) at log-write time.

### Worth considering

**W11. Categories as a typed const.** Plan says "codify them as a
const" but doesn't show what. Concrete sketch worth adding to
Layer 1:
```ts
export const CATEGORY = {
  sync: 'sync', auth: 'auth', invite: 'invite',
  share: 'share', exercise: 'exercise', onboarding: 'onboarding',
  uncaught: 'uncaught',
  'unhandled-rejection': 'unhandled-rejection',
  'image-upload': 'image-upload',
} as const;
export type Category = typeof CATEGORY[keyof typeof CATEGORY];
```
Then `log.warn(c: Category, ...)`. Typo = compile error.

**W12. "6-char short code" for diagnostics reports is undefined.**
Plan returns "the new id (6-char short code)" from
`submit-diagnostics`, but a UUID is 36 chars. Pick one: an extra
`short_code` column (random base32, retried on unique conflict),
or derive from the UUID's first 6 hex chars (collision space
~16M — fine for hundreds of reports/year). Spell it out.

**W13. Operator lookup path missing.** When a user says "report
code XK7P3D" via Slack, how does the operator turn that into the
actual log? A one-line SQL recipe in
`docs/operational-runbook.md` (mentioned in the plan but
undefined) makes this concrete:
`select payload, notes from diagnostics_reports where short_code = 'XK7P3D';`.

**W14. `audit_events.user_id` nullability is implicit.** The
schema says `references profiles(id) on delete set null` so it's
nullable. Document that `null` means "system event" (cron prune,
etc.) and the trigger code must explicitly populate from
`NEW.inviter_id` etc. for any human-attributable event.

### Out of scope but flag

**O15. PR-sequencing inversion in the user-visible UI.** PR A
(logger) and PR B (call sites) are correctly ordered. PR C
(panel) before PR D (Edge Function) means users *see* the panel
with a "Send to support" button that doesn't work yet. Either
ship D before C, or hide the Send button behind a build-time
feature flag until D lands.

### Resolution log

| Finding | Status | Where addressed |
|---|---|---|
| B1 | **Landed in PR D** | `0008_audit_events.sql` — `audit_invitations_insert()` gates `invite.sent` on `new.already_existed = false`. `invite-user` Edge Function emits `invite.already_existed` itself on the alreadyExisted branch with `{inviter, email_masked, ua}` metadata. No double-emit. |
| B2 | **Landed in PR D** | Every trigger function in `0008_audit_events.sql` reads the actor from `NEW.*` / `OLD.*` columns explicitly (e.g. `NEW.inviter_id`, `NEW.granter_id`, `NEW.trainer_id` / `NEW.trainee_id` depending on the transition, `OLD.trainer_id` on the DELETE trigger). All functions are `SECURITY DEFINER set search_path = public`; `auth.uid()` is not referenced inside any trigger. |
| B3 | **Landed in PR A** | `src/diagnostics/logger.ts`: in-memory `pending: LogEntry[]` queue, `setTimeout` 250 ms debounced flush + immediate flush at `pending.length >= 50`, post-flush prune by `seq` keeping count = 500. `flushing` guard prevents re-entry. The `__flushForTest` helper drains the queue + waits for in-flight flushes so test assertions are deterministic. |
| S4 | **Landed in PR A** | Logger uses its own Dexie database `ah-keung-diagnostics` (`class DiagnosticsDB extends Dexie`), separate from the main `ah-keung` DB. The sign-out handler's `db.delete()` doesn't touch it. Settings "Clear all diagnostics" action ships with PR C. |
| S5 | **Landed in PR C + PR D** | `0007_diagnostics_reports.sql` and `0008_audit_events.sql` both have SELECT policies joining through `trainer_trainees` with `status = 'accepted'`. No `is_trainer()`. No INSERT/UPDATE/DELETE policies on either; writes happen only via `SECURITY DEFINER` functions and `service_role`. |
| S6 | **Landed in PR A** | `eslint-rules/no-unmasked-email.js` + plugin wiring in `eslint.config.js`. Scoped to `log.info/warn/error(...)` call sites only (not every object literal) so the false-positive surface is minimal. |
| S7 | **Landed in PR A** | `log.info` mirrors to `console.log` only under `import.meta.env.DEV`; `log.warn`/`log.error` mirror to console unconditionally. |
| S8 | **Landed in PR D** | `0008_audit_events.sql` ships the `prune-audit-events` `pg_cron` job (daily 03:00 UTC, `delete from audit_events where created_at < now() - interval '90 days'`). Conditional `do $$` block skips silently if `pg_cron` isn't installed; the runbook documents the manual fallback. |
| S9 | **Landed in PR E** | `supabase/functions/alert-scan/index.ts` + migration `0009_alert_scan.sql`. `record_dead_letter(p_table, p_row_id, p_op, p_reason)` RPC lets clients beacon their local `sync_dead_letter` moves into `audit_events` (`event_type = 'sync.dead_letter'`); `pushWorker.moveToDeadLetter()` calls it fire-and-forget. The Edge Function runs daily (pg_cron+pg_net or GitHub-Actions cron — both documented), counts `sync.dead_letter` + `*.failed` events in 24h, and emails the project owner via the configured SMTP if either threshold is exceeded. Thresholds + recipient configured via env vars. |
| S10 | **Landed in PR A** | `truncateStack()` in `logger.ts` caps at first line + 10 frames, then bytes-cap at 2 KB. Tested. |
| W11 | **Landed in PR A** | `src/diagnostics/categories.ts` exports `CATEGORY` const + `Category` type. `log.warn/info/error` signatures require `Category`. |
| W12 | **Landed in PR C** | `diagnostics_reports.short_code text not null unique`. `submit-diagnostics` Edge Function generates 6-char Crockford base32 (no 0/O/1/I/L) with retry-on-conflict up to 5 attempts. UI displays it prominently in the success panel. |
| W13 | **Landed in PR C** | `docs/operational-runbook.md` written. Includes the short-code lookup recipe, the paired `audit_events` query (works once PR D ships), and dashboard-log surface pointers. |
| W14 | **Landed in PR D** | `audit_events.user_id` declared `uuid references profiles(id) on delete set null` with a column comment in `0008_audit_events.sql` and a paragraph in `docs/operational-runbook.md` ("`user_id = null` is reserved for system events"). |
| O15 | **Folded into PR sequencing** | PR C now combines the Edge Function + table + Settings panel so the Send button is live from day one. The PR C-before-D inversion is gone. |
