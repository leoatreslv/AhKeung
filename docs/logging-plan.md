# Operational logging + diagnostics

**Status:** approved 2026-05-19, ready to implement
**Scope:** observable client + server activity so the next time something
breaks ("trainee can't see invitations", "image upload stuck"), the path
from "user reports it" to "I know exactly what happened" is minutes,
not the multi-step debug-by-screenshot we've been doing.

> **Revision note.** Open decisions resolved by the operator: log
> levels = `info + warn + error` (no `debug` in the buffer); display
> names are **never** masked (the operator needs to read "Leo" in
> error logs to provide support); `audit_events` are emitted by
> **both** triggers AND Edge Functions; buffer size stays at 500
> entries (default).

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
type Level = 'info' | 'warn' | 'error';

interface LogEntry {
  ts: number;          // epoch ms
  level: Level;
  category: string;    // 'sync' | 'auth' | 'invite' | 'exercise' | …
  message: string;
  context?: Record<string, unknown>;  // structured fields
  errorStack?: string; // captured when level === 'error' + Error supplied
}

export const log = {
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

Levels: `info` (user actions, successful state transitions, sync
ticks), `warn` (recoverable problems — OCC conflict + retry, network
hiccup), `error` (unrecoverable for this attempt — dead-letter,
uncaught exception). `debug` is intentionally dropped: every existing
debug-worthy event we have today rises to at least `info` (sync
events, auth transitions, save outcomes), and keeping the buffer free
of debug noise leaves room for ~500 *meaningful* entries instead of
500 tick-by-tick traces.

Every `log.warn` / `log.error` mirrors to `console.warn` /
`console.error` so dev-tools-in-hand inspection still works.
`log.info` writes to the buffer only (not the console) so production
console isn't noisy.

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

Sources of events — **triggers + Edge Functions, both**. Triggers
catch every row change (including ones we add to the app surface
later without remembering to emit). Edge Functions add per-event
context that the triggers can't see (e.g. the "already registered"
branch of `invite-user` writes a single `invite.already_existed`
event from inside the function, with the caller's IP / user-agent
in metadata).

- **Trigger on `invitations` INSERT/UPDATE** — emits `invite.sent`,
  `invite.cancelled`, `invite.accepted`. Server-of-truth.
- **Trigger on `trainer_trainees` INSERT/UPDATE** — emits
  `designation.created`, `designation.accepted`, `designation.declined`,
  `designation.removed`.
- **Trigger on `shares` INSERT/UPDATE (deleted_at flip)** — emits
  `share.created`, `share.revoked`.
- **Trigger on `exercises` UPDATE (deleted_at NULL→NOT NULL)** —
  emits `exercise.deleted`.
- **Trigger on `exercise_bundles` UPDATE (deleted_at)** — emits
  `bundle.deleted`.
- **`invite-user` Edge Function** — emits
  `invite.already_existed` (the branch where Supabase rejects with
  "user already registered") with `{ inviter, email_masked, ua }` in
  metadata. The `invite.sent` event for fresh invites is emitted by
  the trigger above; the function only writes the "already-in"
  branch so we don't double-emit.
- **`share-plan` RPC** — emits `plan.shared` with
  `{ original_plan_id, cloned_plan_id, recipient, exercise_count }`.
  Trigger-only would just see "new plans row inserted" without the
  `original_plan_id` context.
- **`promote_to_trainer` RPC** — emits `trainer.promoted` with
  `{ promoter, promoted }`. Trigger can't see who did it (only that
  `is_trainer` flipped).

The trigger and function paths write to the same `audit_events`
table; the `event_type` namespace tells them apart
(`invite.sent` from a trigger vs `invite.already_existed` from the
function vs `share.created` from a trigger). No coupling between
the two — if a future trigger fires AND a function emits, the row
just shows up twice with different event_types, both legitimate.

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
5. **No remote alerting.** If the dead-letter queue grows or an
   Edge Function starts failing, no one knows until a user reports
   it. v1.1: a daily cron RPC that scans dead-letter + emails the
   project owner on growth.
6. **Diagnostics submitted via screenshot can leak masked-but-
   contextual data.** Even with emails masked and no display-name
   masking, a snippet of a screenshot shared in the wrong place
   could expose trainer↔trainee relationships and exercise content.
   Mitigation: the diagnostics panel's Copy button copies JSON
   (not pretty-printed), making casual screenshotting harder than
   plain text. The Send-to-support button uploads via TLS to a
   table the recipient owns, no third-party hop.

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

To be filled in as items are addressed in subsequent PRs. Format:
`B1 — resolved by …` or `S6 — accepted, scheduled PR …` or
`O15 — deferred, tracked separately`.
