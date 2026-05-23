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
| `invite.accepted`         | trigger on `invitations` UPDATE      | inviter | `accepted_at` flipped null → not null (stamped by `mark_invitation_accepted` trigger on `profiles` UPDATE — see migration 0010) |
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

## Email templates

Dashboard → **Authentication → Email Templates**. Two templates
matter for this app: **Invite user** and **Reset password**.

### Why this matters (read before editing)

The default Supabase templates use `{{ .ConfirmationURL }}`, which
routes through the Supabase auth endpoint `/auth/v1/verify`. That
endpoint **consumes the one-time token on a single GET request** —
fine for the human clicker, fatal when an inbox / scanner / link
preview service fetches the URL first. Yahoo Mail's "Safe View",
Gmail's corporate scanners, Outlook's "Safe Links", and most
enterprise security gateways all GET every link in incoming mail
to scan for malware. By the time the recipient taps, the token is
already burned and they land on the Login screen with no session.

The fix is to deliver the token to the client directly and let the
client call `verifyOtp` from JavaScript. A passive prefetch only
loads HTML; it can't trigger a JS function. Use the
`{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=<kind>` pattern
in every template where Supabase issues a one-time link.

The app's `consumeAuthLink()` in `src/auth/AuthProvider.tsx`
detects both `?type=invite` and `?type=recovery` URL params, runs
`verifyOtp`, and routes the user to Onboarding (if their profile
has no display name) or ResetPassword (if they're an existing
user resetting their password).

### Invite user template

**Subject:**

```
{{ .Data.inviter_name }} invited you to I am Ah Keung! 💪
```

**Body (HTML):**

```html
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px;">
    <div style="max-width: 480px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155;">
      <h1 style="margin: 0 0 16px; color: #f97316; font-size: 22px;">
        I am Ah Keung! 💪
      </h1>

      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5;">
        Hi — <strong>{{ .Data.inviter_name }}</strong> invited you to train with them on
        <strong>I am Ah Keung!</strong>, a private gym-training app for tracking plans,
        workouts, and progress with your coach.
      </p>

      <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.5;">
        Tap the button below to accept the invitation and set up your account.
        The link expires in 24 hours.
      </p>

      <p style="text-align: center; margin: 0 0 24px;">
        <a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=invite"
           style="display: inline-block; background: #ea580c; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Accept invitation
        </a>
      </p>

      <p style="margin: 0 0 8px; font-size: 12px; color: #94a3b8;">
        Or copy and paste this URL into your browser:
      </p>
      <p style="margin: 0 0 24px; font-size: 12px; color: #94a3b8; word-break: break-all;">
        {{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=invite
      </p>

      <hr style="border: none; border-top: 1px solid #334155; margin: 24px 0;" />

      <p style="margin: 0; font-size: 12px; color: #64748b;">
        如果你並不認識 <strong>{{ .Data.inviter_name }}</strong>,請忽略此電郵。<br>
        If you don't know <strong>{{ .Data.inviter_name }}</strong>, just ignore this email — no account is created until you click the link.
      </p>
    </div>
  </body>
</html>
```

`{{ .Data.inviter_name }}` is populated by the `invite-user` Edge
Function from the inviting trainer's `profiles.display_name`. Falls
back to `your trainer` when the trainer hasn't set a display name.

### Reset password template

The invite-user Edge Function's "already_existed" branch falls
back to a password-reset email (because Supabase refuses to
re-invite an email that already has an `auth.users` row). The
recipient then onboards through the same flow as a fresh invite,
so this template needs the same prefetcher-safe link pattern.

**Subject:**

```
Sign in to I am Ah Keung!
```

**Body (HTML):**

```html
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px;">
    <div style="max-width: 480px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155;">
      <h1 style="margin: 0 0 16px; color: #f97316; font-size: 22px;">
        I am Ah Keung! 💪
      </h1>

      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5;">
        Tap the button below to sign in. You'll be asked to set or
        update your password.
      </p>

      <p style="text-align: center; margin: 0 0 24px;">
        <a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery"
           style="display: inline-block; background: #ea580c; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Sign in
        </a>
      </p>

      <p style="margin: 0 0 8px; font-size: 12px; color: #94a3b8;">
        Or copy and paste this URL into your browser:
      </p>
      <p style="margin: 0 0 24px; font-size: 12px; color: #94a3b8; word-break: break-all;">
        {{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery
      </p>

      <hr style="border: none; border-top: 1px solid #334155; margin: 24px 0;" />

      <p style="margin: 0; font-size: 12px; color: #64748b;">
        如果你並冇要求重設,請忽略此電郵。<br>
        If you didn't request this, just ignore the email — no change is made until you click the link.
      </p>
    </div>
  </body>
</html>
```

### Verifying after a template edit

1. Save in the Dashboard, then send yourself a test invite to a
   personal address (use a Gmail / iCloud, not Yahoo, the first
   time so prefetcher noise doesn't muddy the test).
2. Click the link. You should land on `https://ahkeung.netlify.app/?token_hash=…&type=invite`
   (URL bar visible for ~1s before the SPA rewrites it).
3. Recipient should land on **Onboarding** (display name + password
   form). Existing users with a display name already set land on
   **ResetPassword** instead.
4. After onboarding, the trainer's My Trainees page shows the row
   as **Joined / Accepted** (the `accepted_at` stamp is now driven
   by migration 0010's `profiles` UPDATE trigger).

If the recipient lands on **Login** with no session, the link was
burned mid-flight — check `Dashboard → Authentication → Logs` for
`403 Email link is invalid or has expired` and confirm the
template's anchor `href` is the `{{ .SiteURL }}/?token_hash=…`
form, not `{{ .ConfirmationURL }}`.

## Email deliverability (Custom SMTP + auth records)

Default Supabase mail sends from `noreply@mail.app.supabase.io`,
which Yahoo, Outlook.com, and most enterprise gateways treat as
suspicious. Symptoms when this bites: invitations arriving in
Spam, or not arriving at all, especially for Yahoo and iCloud
recipients.

The single biggest deliverability lever is **Custom SMTP on a
domain you own**, with proper DNS records. ~30 minutes of setup
saves an indefinite stream of "did you get my invite?" support
threads.

### Pick an SMTP provider

Any transactional-email provider works. Common picks with free
tiers that comfortably cover a beta-scale app:

| Provider | Free tier | Notes |
|---|---|---|
| Resend     | 3k emails/month, 100/day | Newest, simplest setup |
| SendGrid   | 100/day                  | Mature; lots of dashboards |
| Mailgun    | 5k/month for 3 months    | EU + US regions; pay-as-you-go after |
| AWS SES    | 62k/month from EC2       | Cheap at scale; manual approval |
| Postmark   | (paid only)              | Best deliverability reputation |

### Configure Supabase to use it

1. **Project Settings → Authentication → SMTP Settings → Enable
   Custom SMTP**.
2. Fill in host / port / username / password from the provider's
   dashboard.
3. **Sender email**: must be on a domain you own (e.g.
   `no-reply@your-domain.com`). Free-mail addresses
   (`@gmail.com`) won't work; providers reject sending as them.
4. **Sender name**: anything friendly (e.g. `Ah Keung`).
5. Save.

### Set DNS auth records (the part that actually fixes deliverability)

In your DNS host (Cloudflare, Route53, Namecheap, etc.), add the
three records the provider gives you:

- **SPF** — a TXT record on your apex domain authorising the SMTP
  provider's servers to send as your domain. Example:
  `v=spf1 include:sendgrid.net include:_spf.google.com ~all`.
  Combine includes if you already use other senders.
- **DKIM** — usually one or more CNAME records under
  `<selector>._domainkey.your-domain.com` pointing at the
  provider. They sign every outgoing message; receiving servers
  use the signature to verify the mail wasn't tampered with.
- **DMARC** — a TXT record at `_dmarc.your-domain.com` telling
  receivers what to do when SPF/DKIM fail. Start lenient:
  `v=DMARC1; p=none; rua=mailto:postmaster@your-domain.com`.
  Once you've watched the reports for a week and confirmed
  legitimate mail passes, tighten to `p=quarantine` then
  `p=reject`.

After setting them, give DNS ~15 minutes to propagate, then verify
via the SMTP provider's "domain verification" page (every
provider has one) and via [mail-tester.com](https://www.mail-tester.com)
— it scores an outbound email out of 10 and tells you exactly
which records are missing.

### Sanity check

Send yourself an invite to a Gmail address. Open the email →
three-dot menu → **Show original**. You should see
`SPF: PASS`, `DKIM: PASS`, `DMARC: PASS` in the headers. If any
of those say `fail` or `softfail`, fix that record before
relying on the setup.

### Once Custom SMTP is on

- The `ALERT_SMTP_*` env vars for `alert-scan` (see above)
  should reuse the same credentials so operator alerts ride the
  same trusted lane.
- Don't change the sender address afterwards — every change
  starts the IP-reputation warm-up clock over with receiving
  providers.

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

## "Invitation row still shows + Designate after I've designated them"

Should not happen after migration 0012 — but if it does:

1. Confirm the trigger is registered:
   ```sql
   select tgname from pg_trigger
    where tgrelid = 'public.trainer_trainees'::regclass
      and tgname = 'trainer_trainees_mark_invitation_designated';
   ```
2. Confirm the recipient's invitation row got stamped:
   ```sql
   select email, accepted_at, designated_at, cancelled_at
     from invitations
    where email = '<recipient-email>'
      and inviter_id = '<your-uuid>';
   ```
   `designated_at` should be non-NULL. If not, run the backfill
   for this single row by hand:
   ```sql
   update invitations
      set designated_at = now()
    where email = '<recipient-email>'
      and inviter_id = '<your-uuid>'
      and designated_at is null;
   ```
3. To resurface a previously-designated invitation (rare — e.g.
   you want to resend the email to a designated user):
   ```sql
   update invitations set designated_at = null where id = '<inv-id>';
   ```

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

Magic-link sign-in was removed; the only flows are password sign-in
and the recovery / invitation links. Walk through these in order:

1. **Did they finish onboarding?** If they were invited but never
   completed the Onboarding screen, their account exists in
   `auth.users` but has no password. They cannot sign in via
   email + password. In My Trainees, find their invitation row
   and tap **Resend** — that re-issues the invite (or a
   recovery email if Supabase says the user already exists). When
   they click the new link they land on Onboarding to finish.
2. **Did the link click silently fail?** Yahoo and corporate
   inboxes prefetch email links and burn the one-time token before
   the human clicks. Confirm in **Dashboard → Authentication →
   Logs** by filtering on the recipient's email — a row like
   `403: Email link is invalid or has expired` with
   `path: /verify` is the prefetcher signature. Resend, and
   double-check the email template uses the prefetcher-safe
   `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=...`
   pattern (see "Email templates" below).
3. **Forgot their password?** The "Forgot password?" link on the
   Login screen sends a recovery email. Same prefetcher concern
   applies — confirm the Reset password template uses the
   `token_hash` pattern.
4. **Read their diagnostics dump.** If they're partway in (got a
   session but hit an error), Settings → Diagnostics →
   Send to support produces a short code; the
   `auth verifyOtp failed` entries spell out the underlying
   error.

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
