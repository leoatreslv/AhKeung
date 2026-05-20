# Operational logging + diagnostics

**Status:** draft, not approved
**Scope:** observable client + server activity so the next time something
breaks ("trainee can't see invitations", "image upload stuck"), the path
from "user reports it" to "I know exactly what happened" is minutes,
not the multi-step debug-by-screenshot we've been doing.

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

A single module `src/diagnostics/logger.ts`:

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: number;          // epoch ms
  level: Level;
  category: string;    // 'sync' | 'auth' | 'invite' | 'exercise' | …
  message: string;
  context?: Record<string, unknown>;  // structured fields
  errorStack?: string; // captured when level === 'error' + Error supplied
}

export const log = {
  debug(category: string, message: string, context?: Record<string, unknown>): void,
  info(category: string,  message: string, context?: Record<string, unknown>): void,
  warn(category: string,  message: string, context?: Record<string, unknown>): void,
  error(category: string, message: string, contextOrError?: unknown): void,
};

// Buffer lives in a dedicated Dexie store `diagnostics_log` with the
// existing AhKeungDB instance — bumps to v6 (schema-only, no data
// migration). Ring-buffer kept at 500 entries (auto-trim on insert).
// Estimated footprint: ~200–400 KB. Cap visible to the user.

export function recentLog(limit = 500): Promise<LogEntry[]>;
export function clearLog(): Promise<void>;
```

Every `log.warn` / `log.error` mirrors to `console.warn` / `console.error`
so dev-tools-in-hand inspection still works. `log.debug` and `log.info`
write to the buffer only (not the console) so production console
isn't noisy.

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
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references profiles(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  app_version text,             -- git sha, set by vite-define at build time
  user_agent  text,
  locale      text,
  payload     jsonb        not null,  -- the actual log entries + env snapshot
  notes       text                    -- optional free-text from the user
);

create index diagnostics_user on diagnostics_reports(user_id, submitted_at desc);
```

RLS:
- INSERT only via the Edge Function (service role).
- SELECT for `user_id = auth.uid()` (so the user can see their own
  past submissions, audit-style) and for trainers via the existing
  `is_trainer()` predicate (so trainers can pull a trainee's last
  diagnostic with their consent).
- No UPDATE / DELETE policies — reports are immutable.

Edge Function `submit-diagnostics`:
- Verifies JWT (same pattern as `invite-user`).
- Validates payload size (cap at ~512 KB JSON to avoid spam).
- Inserts the row, returns the new `id` (6-char short code for the
  user to read back).

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
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        references profiles(id) on delete set null,
  event_type  text        not null,  -- e.g. 'invite.sent', 'share.created'
  resource    jsonb,                 -- { type, id, …}
  metadata    jsonb,                 -- event-specific context
  created_at  timestamptz not null default now()
);

create index audit_events_user on audit_events(user_id, created_at desc);
create index audit_events_type on audit_events(event_type, created_at desc);
```

Sources of events:

- **Trigger on `invitations` INSERT/UPDATE** — emits `invite.sent`,
  `invite.cancelled`, `invite.accepted`.
- **Trigger on `trainer_trainees` INSERT/UPDATE** — emits
  `designation.created`, `designation.accepted`, `designation.declined`.
- **Trigger on `shares` INSERT/UPDATE** — emits `share.created`,
  `share.revoked`.
- **Trigger on `exercises` UPDATE (deleted_at)** — emits
  `exercise.deleted`.
- **Edge Functions** — `invite-user` writes a row directly when it
  returns success.

RLS: same as `diagnostics_reports` — owner sees their own events;
trainers see their trainees' events. Useful for "what happened to my
account between Monday and Wednesday" without grepping triggers.

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

What we log:

- User IDs (UUIDs) — yes, freely.
- Timestamps, table names, error messages — yes.
- Exercise IDs, plan IDs, share IDs — yes.

What we never log:

- Passwords, JWTs, or any auth tokens.
- Full email addresses (mask to `a***@example.com`).
- Display names? Optional — leaning **mask in error logs but keep in
  audit events** (the trainer needs to see "shared with Leo"; the
  diagnostics dump doesn't).

Logger has a `mask()` helper enforced for `email` and
`display_name` fields by default.

## Storage / volume

Per-user ring buffer (500 entries × ~600 bytes avg) ≈ **300 KB**
worst-case in IndexedDB. Trivial.

`diagnostics_reports` table — assume <5 reports per user per month at
peak, ~200 KB each → ~10 MB per 10 users per month. Trivial.

`audit_events` table — assume 100 events per user per day at peak →
~3 MB per user per month. Add a TTL job (RPC + cron) that prunes
rows older than 90 days; with the trainer feature set, 90 days is
plenty for "what happened recently" debugging.

## Execution plan (5 PRs)

1. **PR A — Logger module + Dexie ring buffer + console-mirror.**
   Standalone; doesn't change any existing call sites. Verifies the
   buffer survives reload, doesn't survive sign-out (the existing
   `db.delete()` in the sign-out handler clears it). Tests for
   insert / read / trim / mask.
2. **PR B — Strategic call sites.** Replaces ~10 `console.warn`s in
   `src/sync/*`, `src/auth/AuthProvider.tsx`, `src/invitations.ts`,
   `src/sharing.ts` with `log.warn` / `log.error`. Adds new info-
   level emits at the sync-success and user-action points listed
   above. No new tests strictly required; smoke-test by reading the
   buffer after a sync round-trip.
3. **PR C — Diagnostics panel in Settings.** "View diagnostics"
   collapsible, list view, Copy + Clear actions. No remote upload
   yet (Send button stubbed disabled).
4. **PR D — submit-diagnostics Edge Function + `diagnostics_reports`
   table.** Send button wired up. Returns short code for the user
   to read back to support.
5. **PR E — `audit_events` table + triggers on the existing share /
   designate / invitation tables.** Adds the server-side audit
   trail. Edge Functions write rows from inside their existing
   transactions. Tests assert events are emitted on each trigger
   condition.

Sentry / Axiom integration is intentionally not in the plan.
Re-evaluate after we have 100+ active users or after we hit the
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

1. **Buffer flushes on sign-out.** The existing sign-out handler in
   `AuthProvider` does `db.delete()` to clear all user data — that
   also nukes the log buffer. If we want the buffer to survive
   sign-out (for "I signed out then back in and the issue persists"
   reports), the logger needs its own database OR an opt-in
   "preserve diagnostics across sessions" toggle. v1: nuked, easier.
2. **Logger volume on iOS Safari.** IndexedDB writes on iOS have
   historically been slow under memory pressure. The ring buffer
   batches inserts every 250ms via a debounce so the 60Hz tick of a
   busy sync push doesn't open 60 transactions/sec.
3. **Diagnostics upload over slow networks.** A 512 KB JSON over a
   3G handshake is non-trivial. The Edge Function streams the body
   to `diagnostics_reports.payload` directly (Postgres TOAST handles
   the compression); client shows a progress indicator.
4. **Audit log growth.** TTL job described above; if usage outpaces
   the 90-day rule, swap to a partitioned table by month (cheap
   migration when needed, not now).
5. **Mask-by-default of display names** is currently inconsistent —
   audit_events show names (operationally useful), diagnostics_reports
   mask them. Document the asymmetry in the runbook.
6. **No remote alerting.** If the dead-letter queue grows or an
   Edge Function starts failing, no one knows until a user reports
   it. v1.1: a daily cron RPC that scans dead-letter + emails the
   project owner on growth.

## Open decisions

Before I start on PR A, want your call on:

- **Buffer size**: 500 entries (~300 KB) vs 1000 (~600 KB) vs make
  it user-configurable in Settings?
- **Log levels in production**: log everything (debug + info + warn
  + error) or only warn + error? Debug bloats the buffer; info is
  useful for tracing actions. My default: `info + warn + error`
  buffered, `debug` only when a `?debug=1` URL param is set.
- **Mask display names in diagnostics?** I leaned yes; you may want
  full names since the trainer support flow is "Leo says his app's
  broken" → you'd want to see "Leo" in the log.
- **Audit events: written by triggers or by Edge Functions?**
  Triggers are more reliable (can't be bypassed). Edge Functions are
  more flexible (can add custom metadata). My default: triggers
  where possible, Edge Functions for the things they're already
  doing (invite, share-plan RPC).
