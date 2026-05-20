# By-invitation signup + onboarding

**Status:** revised after independent review, ready to implement
**Scope:** close open self-signup, require invitation from an existing
trainer for any new account, give first-time users a mandatory
onboarding step where they pick a display name and set a password.

> **Revision note.** This revision folds in all 4 blocking and 7
> should-fix findings from the independent review at the foot of
> this doc. The biggest change vs the original draft is the explicit
> `verifyOtp` path in AuthProvider — the project's PKCE flow type
> means server-issued links (invite, password-reset) don't
> auto-consume the way `signInWithOtp` magic links do, so the
> original draft's "lands on the app, auto-signed in" was wrong.
> See the resolution log at the bottom for a per-finding trace.

## Background

Today anyone who knows the URL can hit the Login screen, type any
email, and create an account via the magic-link flow (Supabase's
`signInWithOtp` with `shouldCreateUser: true` is the default). For a
trainer-curated app, that's wrong on two counts:

1. **Spam / random signups** clutter the auth.users table.
2. **No initial relationship.** Even when a trainer designates a
   freshly-signed-up trainee, the trainee was at one point "in" with
   no trainer attached, which doesn't match the actual workflow.

## Goals

- **Closed signup.** A non-invited email cannot create an account.
- **Invitation flow.** A trainer enters an email; the invitee gets an
  emailed link; clicking it brings them into the app, signed in.
- **Mandatory onboarding.** First-time users complete a short form
  (display name **required**, password **required**) before they
  reach the app's main surfaces.
- **Invitation ≠ designation.** Receiving an invite is purely an
  authorization-to-create-an-account event. The inviting trainer is
  *not* automatically attached as the trainee's designated trainer
  (the trainee may end up with a different trainer entirely), so
  there's no auto-trainer-trainees row. The trainer who wants the
  designation still goes through MyTrainees → designate → trainee
  accepts via the existing banner. The invitation row is kept purely
  for audit / "who let you in."

## Non-goals

- **Self-serve "request an invite" form.** Out of scope; the app has
  no public on-ramp.
- **Org / team / admin role.** Two roles only (trainer, trainee).
  Promotion still goes through `promote_to_trainer` from 0004.
- **OAuth / SSO** (Google, Apple). Email + magic-link + password only.
- **Bulk invite / CSV import.** v1 is one-at-a-time.

## High-level flow

1. Trainer opens **My Trainees → Invite by email**, types
   `trainee@example.com`, taps Send.
2. Client calls Edge Function `invite-user`. Function:
   - Verifies caller is a trainer (JWT + `is_trainer()` check).
   - Inserts a row into `invitations`
     (`inviter_id, email, created_at, expires_at`).
   - Calls `supabase.auth.admin.inviteUserByEmail(email, { data: {
     invited_by: trainerId } })` (admin op; requires service-role
     key, only the function has it). This bypasses the dashboard's
     "Allow new user sign-ups" off-flag.
3. Supabase emails the invitee an invitation link via your custom
   SMTP provider (already configured in your project — no Supabase
   email-rate limit applies).
4. Invitee taps the link. The default invite URL carries
   `?type=invite&token_hash=...`. **AuthProvider explicitly parses
   these parameters** and calls
   `supabase.auth.verifyOtp({ type: 'invite', token_hash })`,
   which exchanges the token for a session. The PKCE flow type the
   project uses (see `src/supabase.ts`) does NOT auto-consume
   server-issued links because there's no client verifier — without
   this explicit branch the link silently fails and the invitee
   lands on Login with no signal. (See B1, B2 in the review.)
5. After `verifyOtp` succeeds the URL is cleaned (`token_hash` +
   `type` stripped, same way `?code=` is stripped today) and
   AuthProvider transitions to `authenticated` with the new session.
   `user_metadata.invited_by` is set; the new `profiles` row exists
   (via the existing `handle_new_user` trigger) with `display_name`
   still null.
6. Client detects "first-time user" (profile fetched successfully
   AND `display_name` is null) and routes to `<OnboardingScreen />`
   instead of the main Shell:
   - Display name (required).
   - Password + confirm (required).
7. On submit (resilient against mid-flow crash — password first,
   profile second; S6):
   1. `supabase.auth.updateUser({ password })`. If this fails the
      profile is still pristine and onboarding re-prompts on next
      open.
   2. `update profiles set display_name = X where id = me`.
   3. Refetch profile in AuthProvider.
   4. Navigate to `/`.
8. Server-side trigger on `auth.users` insert marks the matching
   `invitations` row's `accepted_at = now()` for audit; **no
   trainer_trainees row is created**. (Falls back to email-only
   match if `invited_by` is missing, per W13.)
9. From here on, the trainee is a regular signed-in user with no
   trainer attached. The inviting trainer (or any other trainer) can
   designate them through MyTrainees → search → designate, and the
   normal accept-via-banner flow takes over.

## Data model

### New table

```sql
create table invitations (
  id              uuid        primary key default gen_random_uuid(),
  inviter_id      uuid        not null references profiles(id) on delete cascade,
  email           text        not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '7 days',
  accepted_at     timestamptz,
  cancelled_at    timestamptz,
  -- True when the invited email was already a registered user at the
  -- time the trainer invited; in that case the invite-user Edge
  -- Function records the row without sending an auth email and the
  -- trainer's UI shows "Already had an account" rather than
  -- "Accepted". Without this flag we'd have to overload `accepted_at`
  -- and lose the distinction (S10).
  already_existed boolean     not null default false,
  unique (inviter_id, email)
);

create index invitations_email   on invitations(lower(email))
  where accepted_at is null and cancelled_at is null;
create index invitations_inviter on invitations(inviter_id);
```

### RLS

| Op | Who |
|---|---|
| SELECT | `inviter_id = auth.uid()` (trainer sees their own outbound invites) |
| INSERT | only via the `invite-user` Edge Function (service role) — no client INSERT policy |
| UPDATE | inviter may set `cancelled_at` only |
| DELETE | none — soft-tracked via `cancelled_at` + `accepted_at` |

The recipient never reads `invitations` directly.

### Trigger: stamp `accepted_at` on signup, nothing else

```sql
create or replace function public.handle_invited_signup() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  inviter uuid;
  email_lc text;
begin
  email_lc := lower(new.email);
  -- Preferred attribution: the `invited_by` UUID written by the
  -- Edge Function into raw_user_meta_data. Per B4, this path has
  -- shifted across Supabase SDK versions and is user-writable
  -- post-signup, so don't trust it as the only path.
  inviter := nullif(new.raw_user_meta_data->>'invited_by', '')::uuid;

  if inviter is not null then
    update invitations
       set accepted_at = coalesce(accepted_at, now())
     where inviter_id = inviter
       and lower(email) = email_lc
       and accepted_at is null
       and cancelled_at is null;
  end if;

  -- Fallback (W13): catch any other pending invitations for this
  -- email so audit isn't lost when invited_by drifts or is missing.
  -- coalesce() guards against overwriting an existing accepted_at.
  update invitations
     set accepted_at = coalesce(accepted_at, now())
   where lower(email) = email_lc
     and accepted_at is null
     and cancelled_at is null;

  -- Audit only. The trainer_trainees designation is intentionally
  -- NOT created here: the inviting trainer may not end up as the
  -- trainee's designated trainer, and forcing the link would corrupt
  -- the existing pending → accept ceremony in MyTrainees.
  return new;
end $$;

create trigger on_invited_user_created
  after insert on auth.users
  for each row execute function public.handle_invited_signup();
```

Order doesn't matter relative to the existing `handle_new_user`
trigger; they touch different tables.

## Server config: disable open signup

In Supabase Dashboard → **Authentication → Providers → Email**:

- **Enable email provider**: on.
- **Confirm email**: on.
- **Allow new user sign-ups**: **off**. ← the key flip.

`auth.admin.inviteUserByEmail` bypasses the sign-up flag, so the
Edge Function still works. Magic-link sign-in for *existing* users
also keeps working.

## Edge Function `invite-user`

POST `{ email: string }`. Two Supabase clients in one function (per
S8 in the review):

- **User client** — created with the anon key + caller's
  `Authorization` header forwarded. Used for `getUser()` and
  `rpc('is_trainer')` so the trainer check runs *as the caller*
  under RLS. The standard `Deno.env.get('SUPABASE_ANON_KEY')` and
  forwarding `req.headers.get('Authorization')!` into
  `global.headers` does the job.
- **Admin client** — created with `SUPABASE_SERVICE_ROLE_KEY`
  (exposed in the Edge runtime by default; no secret to set). Used
  for `auth.admin.inviteUserByEmail`, the invitations-table
  insert, and the rate-limit advisory lock.

Function body, in order:

1. **CORS preflight**. The Supabase function template doesn't
   include OPTIONS handling — add it explicitly:
   `if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });`.
2. **Caller auth**. `getUser()` on the user client; reject with
   401 if no user. `rpc('is_trainer')`; reject with 403 if false.
3. **Rate limit (S9)**. Inside a transaction on the admin client:
   `select pg_advisory_xact_lock(hashtext(<caller_id>::text));`
   then `select count(*) from invitations where inviter_id =
   <caller_id> and created_at > now() - interval '1 day' and
   cancelled_at is null;`. If count ≥ 10, return 429. The advisory
   lock collapses concurrent requests so they serialise on the
   same lock id and can't race to "both see 9, both insert."
4. **Admin invite**.
   `supabase.auth.admin.inviteUserByEmail(email, { data: {
   invited_by: callerId } })`.
   - On success: continue to step 5.
   - On `User already registered`: skip step 5's INSERT-as-pending
     in favour of the "already-existed" path:
     `insert ... values (..., accepted_at = now(), already_existed
     = true) on conflict (inviter_id, email) do update set
     already_existed = true, cancelled_at = null;`. Return 200
     with `{ ok: true, alreadyExisted: true }`. The trainer's UI
     surfaces this as an info chip ("already had an account —
     designate via search").
   - Other errors: surface as 500.
5. **Record the invitation**. Upsert with explicit handling for
   cancel/resend (S11):
   ```sql
   insert into invitations (inviter_id, email)
     values ($1, $2)
   on conflict (inviter_id, email) do update set
       cancelled_at = null,
       created_at   = now(),
       expires_at   = now() + interval '7 days',
       accepted_at  = case
         when invitations.accepted_at is not null
              then invitations.accepted_at
         else null
       end;
   ```
   This restores a cancelled row to active without losing the
   original `accepted_at` if one was already set.
6. **Return** `{ ok: true, invitationId, alreadyExisted: false }`.

Resend = call this function again with the same email; the
on-conflict branch is the resend path. No new row, fresh
`created_at` / `expires_at`. The auth email is regenerated by
`inviteUserByEmail`.

Cancel: a separate function `cancel-invite(invitationId)` (or a
direct authenticated UPDATE under the existing RLS that allows
inviter to set `cancelled_at`) flips the column. Resend after
cancel works via step 5's on-conflict.

## Client surfaces

### AuthProvider URL handling for invite + recovery (B1, B2)

The project's client uses `flowType: 'pkce'` (see `src/supabase.ts`).
PKCE binds magic-link URLs to a verifier stored in the originating
browser's localStorage, which is correct for `signInWithOtp` but
**incompatible with server-issued links** (admin invite, password
reset). Without a verifier the SDK can't auto-consume the URL, so
the invite link silently lands on Login with no error.

The fix is to teach AuthProvider to recognise the two server-link
shapes and exchange them via `verifyOtp`:

```ts
// inside AuthProvider's bootstrap, before getSession():
const params = new URLSearchParams(window.location.search);
const tokenHash = params.get('token_hash');
const type = params.get('type');  // 'invite' | 'recovery' | 'magiclink'

if (tokenHash && (type === 'invite' || type === 'recovery')) {
  const { error } = await supabase.auth.verifyOtp({
    type: type as 'invite' | 'recovery',
    token_hash: tokenHash,
  });
  // Clean the URL the same way the existing ?code= path does so a
  // refresh doesn't re-attempt verifyOtp on a now-consumed token.
  cleanQueryParams(['token_hash', 'type']);
  if (error) {
    // Render a friendly "this link is invalid or expired" page;
    // user can request a new invite/reset from Login.
    setError(t.auth.linkExpired);
    return;
  }
  // verifyOtp populates the session; the existing getSession() path
  // below will pick it up.
}

const { data: { session } } = await supabase.auth.getSession();
// ... rest of existing bootstrap
```

The `type === 'recovery'` branch is what makes the
`/reset-password` route work: after `verifyOtp` succeeds the user
is signed in temporarily, the route's form calls
`supabase.auth.updateUser({ password })`, and they're done.

### Onboarding screen (`/onboarding` — gated route)

`AuthProvider` exposes a new `profileFetchError: string | null`
alongside `status` and `profile`. The gate routes:

| status | profile | profileFetchError | Render |
|---|---|---|---|
| `loading` | * | * | "Loading…" splash |
| `unauthenticated` | * | * | `<Login />` |
| `authenticated` | non-null & `displayName` set | * | `<Shell />` |
| `authenticated` | non-null & `displayName == null` | `null` | `<OnboardingScreen />` |
| `authenticated` | null | non-null | "Couldn't load profile — Retry" |
| `authenticated` | null | null | shouldn't happen (the existing
                                  `handle_new_user` trigger creates a
                                  row on signup); treat as the error
                                  case |

This avoids the trap (S5) where a network failure made
`profile === null` look like "first-time user."

Form:
- **Display name** input (required; non-empty after trim).
- **Password** input (required; min 8 chars; agree with Supabase
  dashboard's minimum, see W14).
- **Confirm password** input (must match).
- **Submit** button — disabled until all three pass validation.

On submit (per S6, password before profile):
1. `supabase.auth.updateUser({ password })`. On failure, surface
   the error and stop — profile is still pristine, so onboarding
   re-prompts on next open.
2. `update profiles set display_name = X where id = me`.
3. Refetch profile.
4. Navigate to `/`.

Not skippable — by design. Recovery if the user closes the app
mid-flow: magic link still works (the dashboard's "Allow new user
sign-ups: off" flag only blocks *first* signup, not re-issuing a
magic link to an existing-but-incomplete user — W12). Once they're
back in, the gate re-routes them to onboarding.

### MyTrainees → "Invite by email" surface

Two stacked sections on the same screen:

```
┌─────────────────────────────────────────────────┐
│ Find an existing user            [name search ▾]│  ← existing
│ Invite someone new               [email input ▾]│  ← new
└─────────────────────────────────────────────────┘
```

The "Invite someone new" submit calls the Edge Function; on success
a new "Pending invites" section appears below the existing
designation status sections.

### Pending invites section (trainer-side)

| Email | Sent | Status | Action |
|---|---|---|---|
| `trainee@example.com` | 2026-05-18 | Pending | Cancel · Resend |
| `bob@example.com` | 2026-05-17 | Accepted ✓ | — |
| `expired@x.com` | 2026-05-01 | Expired | Resend |

Accepted invites stay listed (audit). They don't auto-create a
designation; the trainer who wants to actually train them goes
through the normal search → designate path. (The trainee will
appear in profile search results as soon as they finish
onboarding.)

### Login screen

Add a subtitle: "Invite-only — ask a trainer for an invitation."

Add a **password sign-in** path alongside the existing magic-link
form. Two visible toggles: "Magic link" (default) and "Password".
The password tab is only for *returning* users (per S7) — every
post-onboarding user has a password, so it works for everyone
who's previously completed onboarding.

Set `shouldCreateUser: false` on the `signInWithOtp` call — belt
and suspenders since the dashboard flag also blocks it.

**Error handling (per B3 / W15).** Today `Login.tsx` catches all
errors with a single "Couldn't send the link" message. Add three
explicit branches:

```ts
catch (err: unknown) {
  const msg = err instanceof Error ? err.message : '';
  if (/signups not allowed/i.test(msg) || /not found/i.test(msg)) {
    setStatus(t.login.noAccountYet);     // "No account yet — ask a trainer for an invitation."
  } else if (/rate limit/i.test(msg)) {
    setStatus(t.login.rateLimited);      // "Too many requests — try again in a few minutes."
  } else {
    setStatus(t.login.linkFailed);       // Fallback: generic "Couldn't send the link."
  }
}
```

The message-sniffing is brittle (Supabase doesn't expose a stable
code for "user not found on otp"), so the fallback string catches
any future drift.

### Settings — "Change password"

Add a section for updating the password later
(`supabase.auth.updateUser({ password })`). Optional; not gating
anything.

### Settings — "Forgot password" (login screen)

Standard `supabase.auth.resetPasswordForEmail` flow, served via
your custom SMTP. The reset link takes the user to a small
`/reset-password` route that calls
`supabase.auth.updateUser({ password })`.

## i18n

New strings in `en` + `zh-Hant`:

- `onboarding.title`, `welcome`, `displayNameLabel`,
  `displayNamePlaceholder`, `passwordLabel`, `passwordConfirm`,
  `passwordMismatch`, `passwordTooShort`, `submit`.
- `myTrainees.findExisting`, `inviteByEmail`,
  `inviteEmailPlaceholder`, `inviteSend`, `inviteSent`,
  `inviteRateLimited`, `inviteAlreadyRegistered`, `pendingInvites`,
  `inviteExpired`, `inviteAccepted`, `inviteResend`, `inviteCancel`,
  `inviteCancelConfirm`.
- `login.byInvitationOnly`, `login.usePassword`, `login.useMagicLink`,
  `login.forgotPassword`.
- `settings.changePassword`, `settings.passwordSaved`,
  `settings.passwordMismatch`.
- `resetPassword.title`, `resetPassword.submit`, `resetPassword.success`.

## Code removal / change

- `Login.tsx`: explicit `shouldCreateUser: false` on the
  `signInWithOtp` call. Add a password sign-in form alongside the
  magic-link form. Add a "Forgot password" link.

## Execution plan (4 PRs)

The dashboard flip ("Allow new user sign-ups: off") is bundled
with PR B, not PR A — otherwise the gap between deploying A and B
would leave nobody able to create accounts (O17). The AuthProvider
URL handling for invite + recovery lands in PR A so existing users
can use password reset on day one and the *infrastructure* is
ready when PR B turns on closed signup.

1. **PR A — AuthProvider URL handling + Onboarding + password
   sign-in + reset-password.**
   - `AuthProvider` learns to call `verifyOtp` for `?type=invite`
     and `?type=recovery` URL params, with URL cleanup; new
     `profileFetchError` state for the onboarding-gate state
     machine.
   - `<OnboardingScreen />` rendered when authenticated + profile
     `displayName` is null AND fetch succeeded.
   - `Login.tsx`: password tab, `shouldCreateUser: false`, the
     three-branch error handling.
   - `/reset-password` route outside the auth guard.
   - No dashboard flip yet. Existing self-signup still works.
2. **PR B — `invitations` table + `invite-user` Edge Function +
   audit trigger + dashboard flip.**
   - Migration `0006_invitations.sql`: table (with
     `already_existed`), RLS, trigger, indexes.
   - Edge Function deployed via `supabase functions deploy
     invite-user`. Two-client pattern + CORS + advisory-lock rate
     limit per S8/S9.
   - **Deploy step:** flip Authentication → "Allow new user
     sign-ups: off" in the dashboard. Document in the PR
     description.
3. **PR C — MyTrainees invite UI + pending invites section.**
   Depends on B. Includes Cancel and Resend. Surfaces
   `already_existed` invites as "Already had an account" (chip,
   not a CTA — trainer goes through search → designate for these).
4. **PR D — Settings "Change password" section.** Polish; can ship
   anywhere after A.

## Tests

- **Onboarding gate state machine** (S5): AuthProvider routes
  new user to onboarding when fetched profile has `displayName ==
  null`; routes to error-with-retry when profile fetch *failed*
  (the trap the previous draft fell into); routes to Shell after
  submit. Submit refuses missing password or mismatched confirm.
- **Onboarding submit order** (S6): if `updateUser({ password })`
  fails, `profiles.display_name` stays null and the gate
  re-prompts on next render.
- **AuthProvider URL handling** (B1/B2): given a URL with
  `?type=invite&token_hash=…`, AuthProvider calls
  `verifyOtp({ type: 'invite', … })` and strips the params on
  success. Mocked Supabase client; assert against the verify
  call and the cleaned URL.
- **Invitation RLS**: trainer SELECTs own invites; non-trainer
  cannot; non-inviter cannot SELECT another trainer's invites.
- **`invite-user` Edge Function**: deny for non-trainer caller;
  rate-limit (11th invite in a day fails *deterministically*
  under concurrent access — exercise the advisory lock); the
  re-invite-after-cancel path restores `cancelled_at = null` and
  bumps `created_at`; "already registered" branch sets
  `already_existed = true` and returns 200; CORS OPTIONS
  preflight returns 200.
- **Trigger**: invited signup marks matching `invitations` row
  `accepted_at = now()`; **does not** create a `trainer_trainees`
  row. Fallback path (W13): if `invited_by` is missing from
  metadata, all pending invitations for that lowercase email get
  stamped.
- **Login error sniffing** (B3): given a thrown
  `AuthApiError: Signups not allowed for otp`, the friendly
  message is "No account yet — ask a trainer for an invitation."
- **Password sign-in**: existing user with password signs in via
  `signInWithPassword`; AuthProvider transitions through
  `applySession` once.
- **Reset password** (manual smoke): existing user requests
  reset → email delivered (custom SMTP); link with
  `?type=recovery&token_hash=…` lands on `/reset-password` →
  AuthProvider verifyOtp branch → `updateUser({ password })`
  succeeds → navigate to `/`.

## Risks / open items

1. **Inviting an already-registered user.** Supabase's
   `inviteUserByEmail` returns "User already registered". The
   function catches it and records the invitation with
   `already_existed = true` (no `accepted_at` overwrite — preserves
   audit). UI surfaces this as "Already had an account" and the
   trainer designates them via the existing search → designate
   path.
2. **Email deliverability.** Your custom SMTP is configured, so
   the Supabase Free auth-email rate limit isn't a concern.
   Verify the templates in Dashboard → Auth → Email Templates
   render correctly with your sender identity. **Important**:
   the invite + recovery templates' redirect URL must point to
   your Netlify origin, and the link template must include
   `?type=invite&token_hash={{ .TokenHash }}` (likewise
   `?type=recovery`). The current default templates already use
   `token_hash`; verify before PR B deploy.
3. **Forgot-password recovery route.** `/reset-password` lives
   outside the auth-guarded shell so unauthenticated users can
   finish the reset. AuthProvider's `?type=recovery` branch
   verifies the OTP, the route's form calls
   `updateUser({ password })`, the user is signed in afterwards.
   Ships as part of PR A.
4. **`invited_by` integrity.** The Edge Function uses
   `auth.uid()` from the verified JWT, not any client-supplied
   value, so a trainer cannot impersonate another inviter.
   `raw_user_meta_data` is user-writable post-signup but by then
   the audit row is already stamped (trigger ran during INSERT
   on `auth.users`).
5. **Invite expiry honour.** `expires_at` is informational only
   today. If hard expiry is wanted, add a check in
   `handle_invited_signup` to refuse the audit-update if all
   matching rows are expired, *and* have the Edge Function reject
   re-invites that hit an expired-but-uncancelled row. Not v1.
6. **Password complexity in two places** (W14). Supabase
   dashboard has its own min-length and complexity sliders; the
   client's "min 8 chars" check must agree or `updateUser` will
   throw post-validation with a non-friendly error. Pin both at
   8 chars / no complexity in v1; tighten later.
7. **Stranded-onboarding recovery** (W12). A user who taps the
   invite, signs in, but closes the app before completing
   onboarding still has a confirmed auth.users row. They can come
   back via magic link from Login (the dashboard's
   "Allow new user sign-ups: off" flag only blocks *first* signup,
   not magic links to existing users). On return, AuthProvider's
   gate routes them back to OnboardingScreen because
   `display_name` is still null.
8. **No "Resend invite" rate limit** (O18). Spamming Resend
   re-issues auth emails freely. v1 mitigation: Resend hits the
   same 10/day bucket the function already enforces. v1.1: add a
   per-row "last_resent_at" column and a minimum interval.
9. **`profiles_write` self-elevation** (O16). 0004 tightened
   profiles_write so users cannot flip their own `is_trainer`.
   Verify the migration is applied to the live project before PR
   B ships, because the entire invite system's threat model
   assumes trainer status is privileged. If for any reason the
   trainer-flag is still self-flippable, anyone signing up via
   an invite link could then promote themselves and start
   inviting others.

## Open decisions

None — your responses locked all four:

- ✅ **SMTP**: your project is on a custom provider — no Supabase
  email-rate concerns.
- ✅ **Existing user wipe**: pre-launch reset is acceptable. PR A
  doesn't need to grandfather anyone in.
- ✅ **Designation status**: invitation does **not** auto-create a
  `trainer_trainees` row. Designation stays a separate, explicit
  pending→accept step.
- ✅ **Password mandatory**: required during onboarding (no skip
  toggle).

---

## Review (independent)

An independent pass over this draft against the current code in
`src/supabase.ts`, `src/auth/AuthProvider.tsx`, `src/auth/Login.tsx`,
`src/App.tsx`, and the existing migrations. Findings grouped by
severity; the **Blocking** items have to be resolved before PR A
starts or the design is wrong.

### Blocking

**B1. The PKCE flow type breaks invite links as currently designed.**
`src/supabase.ts` sets `flowType: 'pkce'`, and the comment is
explicit: cross-device link clicks and any link not originating from
this browser's `signInWithOtp` *do not work*, because the verifier
lives in the originating browser's localStorage.
`auth.admin.inviteUserByEmail` issues a link from the server with
**no client verifier ever generated**. The default Supabase invite
template redirects with `?token_hash=...&type=invite` (a verifyOtp
link, not `?code=`) — under PKCE this lands in `AuthProvider`'s
`getSession()` path, finds no session, and falls through to the
Login screen with no error and no signal that an invite was just
consumed. The plan needs either (a) to override the invite template
to use a verifyOtp path that AuthProvider explicitly handles via
`supabase.auth.verifyOtp({ type: 'invite', token_hash })`, or (b) to
drop PKCE for invite flows specifically (it can't be conditional
per-link — flowType is per-client). Pick (a). This is the single
biggest gap.

**B2. AuthProvider has no `?type=invite` / `?type=recovery` branch.**
The current URL-cleanup code strips `?code=` only. Invite and
reset-password URLs use `token_hash` + `type` query params (or a
`#access_token=...` fragment depending on template version). On
first invite tap the SDK won't auto-consume those; AuthProvider
needs an explicit `verifyOtp` step before `getSession()`, and it
has to clean up `token_hash`/`type` from the URL the same way it
cleans up `code`. The doc treats invite and recovery as "they just
land in the app, signed in" — they don't, under the current client
config.

**B3. "No account yet" error sniffing is brittle.**
`signInWithOtp` with `shouldCreateUser: false` on an unknown email
returns a generic `AuthApiError: Signups not allowed for otp` (HTTP
400) — same shape as several other failure modes.
`src/auth/Login.tsx` currently catches *all* errors with
`"Couldn't send the link. Check your connection"`. The plan calls
for a specific "no account yet — ask a trainer" message but doesn't
note that distinguishing this case requires sniffing the error
message string (no stable error code exists). Acceptable but needs
to be in the doc, with a sensible fallback string for unknown
errors.

**B4. The `invited_by` metadata path is fragile.**
`inviteUserByEmail(email, { data: {...} })` writes the `data` object
to `raw_user_meta_data`. As of recent Supabase auth versions, that
exact landing has shifted between releases and `raw_user_meta_data`
is also writable by the user post-signup via `updateUser({ data })`.
The trigger should read from `raw_user_meta_data->>'invited_by'`
*and* fall back to matching purely on `lower(email)` if it's
null/missing, so an SDK-version change doesn't silently break audit.
The trigger as written returns early on missing `invited_by`,
leaving the invitation row stuck on `pending` forever.

### Should-fix

**S5. Onboarding state machine has three half-states.** Walk the
boot sequence: (a) `status='loading'` while `getSession()` resolves,
then `fetchProfile()` runs; (b) if profile fetch *fails* (network)
AuthProvider falls back to cached profile from `localStorage` — but
a fresh invitee has no cached profile, so `profile` stays `null` and
the gate can't distinguish "first-time user, needs onboarding" from
"offline, profile fetch failed". The check
`profile.displayName == null` is true in both cases. Solutions:
add a separate `profileFetchError` state, and never route to
onboarding on an errored fetch (show retry). Or persist a
`needsOnboarding` boolean computed from a *successful* fetch only.

**S6. Mid-onboarding crash leaves users wedged.** Submit order is
`update profiles`, then `updateUser({ password })`. If step 1
succeeds and step 2 fails (network / weak-password rejection from
auth), the profile has `display_name` set, so the onboarding gate
will *not* re-route them on next open — they'll land in Shell with
no password set. They can never sign in with password and have to
use magic link forever. Reverse the order: `updateUser({ password })`
first (atomic on the auth server), *then* `update profiles`. If
step 2 fails, profile is still pristine and onboarding re-prompts
on reopen.

**S7. `signInWithPassword` under PKCE is fine, but document the
boundary.** Password sign-in returns the session synchronously;
`onAuthStateChange` fires `SIGNED_IN` once. AuthProvider's
`applySession` dedupes by `signedInUserId`, so this is benign — but
the password path lands in `applySession` with no profile yet for
brand-new users. By definition, the password tab is for *returning*
users only; hide it during the post-invite first-render.

**S8. Edge Function caller-auth requires the JWT to be forwarded
correctly.** `supabase.functions.invoke()` forwards the user's JWT
in `Authorization` automatically. The plan says "Verifies caller
is a trainer (JWT + `is_trainer()` check)" but doesn't say how.
Concretely: the function must `createClient(URL, SERVICE_ROLE_KEY)`
for the admin call, but separately
`createClient(URL, ANON_KEY, { global: { headers: { Authorization:
req.headers.get('Authorization')! } } })` to call `.auth.getUser()`
and then `.rpc('is_trainer')` *as that user*. Two clients in one
function. CORS preflight (`OPTIONS`) also needs an explicit handler
— the Supabase template doesn't include it.

**S9. Rate-limit race.** "10/day counted via the invitations table"
is racy: two concurrent requests both `SELECT count(*) ... WHERE
inviter_id=me AND created_at > now()-'1 day'`, both see 9, both
insert → 11. Fix with `pg_advisory_xact_lock(hashtext(
inviter_id::text))` inside a transaction, or counted via an `INSERT
... WHERE (SELECT count(*) ...) < 10` pattern. Also: the count
should exclude `cancelled_at IS NOT NULL` rows (a cancelled invite
shouldn't burn quota) but **include** `accepted_at IS NOT NULL`
ones (those did send a real email).

**S10. `accepted_at` overwrite on re-invite of accepted user.** The
"already registered" branch inserts with `accepted_at = now()` and
the table has `unique (inviter_id, email)`. An on-conflict-do-update
will overwrite the *original* `accepted_at` timestamp, losing the
real signup time. Either `on conflict do update set accepted_at =
coalesce(invitations.accepted_at, excluded.accepted_at)`, or `do
nothing` on the already-accepted case. The `accepted_at = now()`
for an "already registered" invite is also semantically dubious —
the user didn't accept *this* invite. Add a separate
`already_existed boolean` column or skip the stamp, otherwise audit
shows fake acceptances.

**S11. Re-invite after cancellation collides with the unique
constraint.** The unique constraint is `(inviter_id, email)`, so a
trainer who hits "Cancel" cannot then re-invite the same email
(insert violates unique). The plan's "Resend" action is also
undefined — does it just call `inviteUserByEmail` again (which
generates a new auth token) or insert a new row? Spell out:
**Resend** = call `inviteUserByEmail` again *without* touching the
invitations row. **Cancel** = `cancelled_at = now()`. **Re-invite
after cancel** = upsert with `cancelled_at = null` and `created_at
= now()`.

### Worth considering

**W12. Magic-link path for stranded onboarding.** A user who set
neither display_name nor password and closed the app *can* re-enter
via magic link from Login — the "Allow new user sign-ups: off" flag
only blocks *first* signup, not re-sending magic links to confirmed
users. Document this as the recovery story explicitly.

**W13. The trigger isn't idempotent against trainer-attribution
churn.** If `invited_by` is missing from metadata (B4) the trigger
updates *nothing*, leaving audit stuck. Add a NULL-`invited_by`
fallback that updates *all* pending invitations for the lowercase
email to `accepted_at = now()` — attribution is fuzzy but audit
isn't lost.

**W14. Password complexity is set in two places.** Supabase
dashboard has its own min-length and complexity sliders; the
client's "min 8 chars" check needs to agree or `updateUser` will
throw post-validation. Pin both.

**W15. Login.tsx error catch is too broad.** Once
`shouldCreateUser: false` is added, the most likely error becomes
"user not found" — that needs a distinct, friendly message. Same
for "rate limited" once SMTP custom rate caps apply.

### Out of scope but flag

**O16. `profiles_write` lets users self-set `is_trainer`.** 0004
supposedly tightened this (resolution log of trainer-exercises-plan
O17) — verify it does, because the entire invite-system threat model
assumes "trainer" is privileged. The Edge Function's `is_trainer()`
check is moot if any user can flip the bit.

**O17. PR sequencing problem.** PR A flips the dashboard switch at
deploy time but PR B (Edge Function + invitations table) lands
separately. Between A and B, *nobody* can create accounts. Either
bundle the dashboard flip into PR B, or have PR A ship behind a
feature flag.

**O18. No "Resend invite" rate limit.** Spamming Resend on the same
row would re-issue auth emails freely. Either bound it (one resend
per hour per invitation) or charge it to the same 10/day bucket.

### Resolution log

| Finding | Status | Where addressed |
|---|---|---|
| B1 | **Folded into design** | New "AuthProvider URL handling" section spells out the explicit `verifyOtp({ type: 'invite', token_hash })` path. Lands in PR A so the infrastructure is in place when PR B turns on closed signup. |
| B2 | **Folded into design** | Same AuthProvider section: `?type=invite` / `?type=recovery` URL params are parsed, exchanged via `verifyOtp`, and stripped on success (mirroring the existing `?code=` cleanup). |
| B3 | **Folded into design** | Login screen section's "Error handling" subsection gives the three-branch sniff (`Signups not allowed` → no-account; `rate limit` → throttled; fallback). |
| B4 | **Folded into design** | Trigger now reads `invited_by` first and *also* runs a fallback `UPDATE` matching on lowercase email — audit isn't lost if the metadata path drifts across SDK versions. |
| S5 | **Folded into design** | AuthProvider exposes `profileFetchError`; gate table distinguishes "first-time user" (profile fetched, displayName null) from "fetch failed" (error → retry). |
| S6 | **Folded into design** | Onboarding submit order reversed: `updateUser({ password })` first, `profiles.display_name` second. Mid-flow crash leaves the gate intact for re-prompt. |
| S7 | **Folded into design** | Login screen section notes the password tab is for returning users only. |
| S8 | **Landed in PR B** | `supabase/functions/invite-user/index.ts`: two clients (user client with forwarded Authorization for `getUser` + `is_trainer` RPC; admin client with service-role key for the admin invite + table writes). CORS preflight handler at top of `Deno.serve`. |
| S9 | **Landed in PR B** | `invite_rate_check(inviter, max_per_day)` SECURITY DEFINER RPC in migration 0006: `pg_advisory_xact_lock(hashtext(inviter::text))` then a count of `created_at > now() - interval '1 day'` excluding `cancelled_at IS NOT NULL`. Function returns `{ exceeded, count_24h }` and the Edge Function returns 429 on `exceeded = true` before calling the admin API. |
| S10 | **Landed in PR B** | `invitations.already_existed boolean not null default false` in 0006. Edge Function sets it to `true` on the "User already registered" branch without stamping `accepted_at`. |
| S11 | **Landed in PR B** | `invitations` upsert in the Edge Function uses `onConflict: 'inviter_id,email'`, clearing `cancelled_at`, bumping `created_at` + `expires_at`. `accepted_at` is preserved (Postgres's default upsert doesn't touch unmentioned columns). |
| W12 | **Folded into design** | Risks #7: magic link is the stranded-onboarding recovery path; the dashboard flag doesn't block re-issuing magic links to existing-but-incomplete users. |
| W13 | **Landed in PR B** | `handle_invited_signup` trigger in 0006 runs two updates: first attempting attribution via `raw_user_meta_data->>'invited_by'` (with `nullif()` guarding against empty-string), then a fallback that updates *every* still-pending invitation matching `lower(email)` so audit isn't lost on metadata drift. `coalesce(accepted_at, now())` prevents overwriting an existing stamp. |
| W14 | **Folded into design** | Risks #6 calls out the dashboard-min-length / client-validator pin. |
| W15 | **Folded into design** | Login error sniff has the three-branch catch with a friendly fallback. |
| O16 | **Re-verified in risks** | 0004 tightened `profiles_write`; risks #9 notes to verify on the live project before PR B ships. |
| O17 | **Landed in PR B** | Dashboard flip ("Allow new user sign-ups": off) is a deploy-time step alongside the migration. The migration's header comment is the prompt; no gap because the Edge Function's admin invite bypasses the flag from the same deploy. |
| O18 | **Partially mitigated, flagged** | Resend uses the same 10/day bucket the invite path enforces, so spam still hits the rate limit. A per-row minimum interval is v1.1 (Risks #8). |

