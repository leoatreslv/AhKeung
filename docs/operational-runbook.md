# Operational runbook

Quick recipes for the most common "user reports something's broken"
flows. Cross-references `docs/logging-plan.md` for the why.

## Diagnostics report lookup

User reports a problem and reads back a short code (e.g. `XK7P3D`)
from Settings → Diagnostics → Send to support. To open the report:

```sql
select payload, notes, submitted_at, user_id, user_agent, locale, app_version
  from diagnostics_reports
 where short_code = 'XK7P3D';
```

The `payload` column holds the JSON the client sent. Each entry has
`ts`, `level`, `category`, `message`, optional `context`, and an
optional `errorStack`. Read newest-last.

To see all *server-side* events for the same user in the window
leading up to the report:

```sql
with r as (
  select user_id, submitted_at
    from diagnostics_reports
   where short_code = 'XK7P3D'
)
select event_type, resource, metadata, created_at
  from audit_events, r
 where audit_events.user_id = r.user_id
   and audit_events.created_at between r.submitted_at - interval '1 day'
                                   and r.submitted_at + interval '1 hour'
 order by created_at;
```

## `audit_events` event-type catalogue

Reference for the trigger + Edge Function emits from PR D
(`supabase/migrations/0008_audit_events.sql`).

| event_type | Source | `user_id` (actor) | Notes |
|---|---|---|---|
| `invite.sent`             | trigger on `invitations` INSERT      | inviter | only when `already_existed = false` |
| `invite.already_existed`  | Edge Function `invite-user`          | inviter | emitted in place of `invite.sent`; metadata adds caller UA |
| `invite.cancelled`        | trigger on `invitations` UPDATE      | inviter | `cancelled_at` flipped null → not null |
| `invite.accepted`         | trigger on `invitations` UPDATE      | inviter | `accepted_at` flipped null → not null (via auth-signup trigger) |
| `designation.created`     | trigger on `trainer_trainees` INSERT | trainer |  |
| `designation.accepted`    | trigger on `trainer_trainees` UPDATE | trainee | status → accepted |
| `designation.declined`    | trigger on `trainer_trainees` UPDATE | trainee | status → declined |
| `designation.removed`     | trigger on `trainer_trainees` DELETE | trainer | (`OLD.*`) |
| `share.created`           | trigger on `shares` INSERT           | granter | only when `deleted_at IS NULL` at insert |
| `share.revoked`           | trigger on `shares` UPDATE           | granter | `deleted_at` flipped null → not null |
| `plan.shared`             | RPC `share_plan`                     | granter | metadata: `{original_plan_id, cloned_plan_id, recipient, exercise_count, superseded_id}` |
| `exercise.deleted`        | trigger on `exercises` UPDATE        | owner   | `deleted_at` flipped null → not null |
| `bundle.deleted`          | trigger on `exercise_bundles` UPDATE | owner   | `deleted_at` flipped null → not null |
| `trainer.promoted`        | RPC `promote_to_trainer`             | promoter | metadata: `{promoter, promoted}` |

`user_id = null` is reserved for system events (e.g. the daily
`pg_cron` prune). All human-attributable events populate `user_id`
from `NEW.*` / `OLD.*` columns; `auth.uid()` is unused inside
triggers because it's null when the writer is `service_role`.

Retention: 90 days via `pg_cron` job `prune-audit-events`. Verify
the job exists with:

```sql
select jobname, schedule, command from cron.job where jobname = 'prune-audit-events';
```

If `pg_cron` isn't enabled on the tier, run the delete by hand
periodically:

```sql
delete from audit_events where created_at < now() - interval '90 days';
```

## `alert-scan` daily threshold check

Edge Function `alert-scan` (PR E) scans `audit_events` over the
last 24h and emails a summary if either threshold is tripped:

- `sync.dead_letter` events ≥ `ALERT_DEAD_LETTER_THRESHOLD` (default **5**)
- `*.failed` events ≥ `ALERT_FAILED_THRESHOLD` (default **10**)

### One-time setup

1. Deploy the function:
   ```bash
   supabase functions deploy alert-scan
   ```
2. Set SMTP + recipient secrets (reuse the project's existing SMTP
   creds — they're the same ones Auth uses for invite emails):
   ```bash
   supabase secrets set \
     ALERT_SMTP_HOST=smtp.example.com \
     ALERT_SMTP_PORT=587 \
     ALERT_SMTP_USER=apikey \
     ALERT_SMTP_PASS=... \
     ALERT_FROM=alerts@your-domain.com \
     ALERT_TO=ops@your-domain.com
   ```
   Override thresholds with `ALERT_DEAD_LETTER_THRESHOLD` /
   `ALERT_FAILED_THRESHOLD` if the defaults are too noisy.
3. Schedule it. Two options:

   **Option A — `pg_cron` + `pg_net`** (preferred if both
   extensions are available; both ship with Supabase Pro+):

   ```sql
   -- Stash the service-role key in a Postgres setting so the cron
   -- body doesn't bake it into the schedule definition. Run once
   -- in the SQL editor:
   alter database postgres
     set app.service_role_key = '<your service role JWT>';

   select cron.schedule(
     'daily-alert-scan',
     '0 9 * * *',
     $$
       select net.http_post(
         url     := 'https://<project-ref>.supabase.co/functions/v1/alert-scan',
         headers := jsonb_build_object(
           'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
           'Content-Type',  'application/json'
         )
       );
     $$
   );
   ```

   **Option B — GitHub Actions cron** (works on any tier):

   ```yaml
   # .github/workflows/alert-scan.yml
   name: alert-scan
   on:
     schedule: [{ cron: '0 9 * * *' }]
   jobs:
     ping:
       runs-on: ubuntu-latest
       steps:
         - run: |
             curl -X POST \
               -H "Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}" \
               https://<project-ref>.supabase.co/functions/v1/alert-scan
   ```

### Manual verification

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  https://<project-ref>.supabase.co/functions/v1/alert-scan
```

Returns JSON `{ ok, deadLetterCount, failedCount, alerted, triggers? }`.
If counts are below thresholds, no email is sent.

### Threshold tuning

5 dead-letters in 24h is the floor at which "this is a class of bug,
not a one-off." `*.failed` events don't exist yet in v1's audit
vocabulary — the 10-event threshold is forward-compatible for when
future emits use the `.failed` suffix.

## Where to find Supabase's own logs

Most operational issues we've hit ARE visible in the dashboard
already; reach for these first.

| Surface | Where |
|---|---|
| Edge Function logs | Dashboard → Edge Functions → `<function>` → Logs |
| Auth (sign-in, magic-link issuance, password reset) | Dashboard → Authentication → Logs |
| PostgREST queries | Dashboard → Logs → Postgres Logs (filter `role = 'authenticated'`) |
| Storage success/failure | Dashboard → Logs → Storage |

Retention depends on plan: 1–7 days on free, 30+ on pro.

## "Sync is stuck"

The most common silent breakage. Symptoms: user actions appear to
save but don't show up on the trainer's side, or the trainee never
sees a designation banner.

1. **Check dead-letter on the user's device**:
   ```js
   // browser console on the affected device
   const m = await import('./db');
   (await m.db.syncDeadLetter.toArray()).forEach((r) => console.log(r));
   ```
2. **Cross-check server-side**: query `audit_events` for any
   `*.failed` event types around the same time window.
3. **If the dead-letter has rows from a now-resolved bug** (e.g.
   the missing `deleted_at` column in PR-A-of-by-invitation): clear
   them with
   ```js
   await m.db.syncDeadLetter.where('table').equals('<table>').delete();
   ```
   then have the user re-trigger the original action.

## "I can't sign in"

1. **First confirm closed signup didn't bite them**: ask if they
   used to be able to sign in. If they were invited and never
   completed onboarding, they need to use the magic-link from Login
   (their account exists; the dashboard's "Allow new user sign-ups:
   off" only blocks *first* signup, not subsequent magic-link
   re-issues).
2. **Check Auth logs in the dashboard** for the user's email
   (Authentication → Logs → search by email).
3. **If the invite link silently failed**, the `?type=invite`
   AuthProvider branch in src/auth/AuthProvider.tsx emits a
   `log.error('auth', 'verifyOtp failed', ...)` — visible in any
   diagnostics report the user submits.

## Cleaning a single user's local state

If a user's app is wedged and the easiest fix is "blow away the
local Dexie":

```js
indexedDB.deleteDatabase('ah-keung');
// Diagnostics survive (separate DB):
// indexedDB.deleteDatabase('ah-keung-diagnostics');
```

Then reload. The pull worker rebuilds local state from the server
on next sign-in.
