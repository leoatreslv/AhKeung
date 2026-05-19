# By-invitation signup + onboarding

**Status:** approved, ready to implement
**Scope:** close open self-signup, require invitation from an existing
trainer for any new account, give first-time users a mandatory
onboarding step where they pick a display name and set a password.

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
4. Invitee taps the link → lands on the app, auto-signed in, with
   `user_metadata.invited_by` populated.
5. Client detects "first-time user" (no `display_name` on the
   `profiles` row) and routes to `<OnboardingScreen />` instead of
   the main Shell:
   - Display name (required).
   - Password + confirm (required).
6. On submit:
   1. `update profiles set display_name = X where id = me`.
   2. `supabase.auth.updateUser({ password })`.
   3. Refetch profile in AuthProvider.
   4. Navigate to `/`.
7. Server-side trigger on `auth.users` insert only marks the matching
   `invitations` row's `accepted_at = now()` for audit; **no
   trainer_trainees row is created**.
8. From here on, the trainee is a regular signed-in user with no
   trainer attached. The inviting trainer (or any other trainer) can
   designate them through MyTrainees → search → designate, and the
   normal accept-via-banner flow takes over.

## Data model

### New table

```sql
create table invitations (
  id           uuid        primary key default gen_random_uuid(),
  inviter_id   uuid        not null references profiles(id) on delete cascade,
  email        text        not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  cancelled_at timestamptz,
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
  inviter := (new.raw_user_meta_data->>'invited_by')::uuid;
  if inviter is null then return new; end if;

  -- Audit only. The trainer_trainees designation is intentionally
  -- NOT created here: the inviting trainer may not end up as the
  -- trainee's designated trainer, and forcing the link would
  -- corrupt the existing pending → accept ceremony in MyTrainees.
  email_lc := lower(new.email);
  update invitations
     set accepted_at = now()
   where inviter_id = inviter
     and lower(email) = email_lc
     and accepted_at is null
     and cancelled_at is null;

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

```ts
// supabase/functions/invite-user/index.ts
// POST { email: string }
//
// - Verifies caller is a trainer via JWT (looks up profile.is_trainer).
// - Rate-limits: 10 invites/day/trainer (counted via the invitations
//   table itself — no extra storage).
// - Inserts an invitations row (on-conflict-do-update for re-invite).
// - Calls supabase.auth.admin.inviteUserByEmail with the trainer's
//   id in user_metadata.invited_by.
// - If the email is already registered, the admin call returns
//   "user already registered"; the function catches that, records the
//   invitation with accepted_at = now() (so it shows up as "already
//   in" in the trainer's pending list), and returns success — the
//   trainer can then designate the existing user normally.
// - Returns { ok: true, invitationId } or { error: '...' }.
```

Function secret: none — the runtime exposes `SUPABASE_SERVICE_ROLE_KEY`
in the Edge Function context by default.

## Client surfaces

### Onboarding screen (`/onboarding` — gated route)

Detected by `AuthProvider`: after fetching the profile, if
`profile.displayName` is null AND user is authenticated, the route
tree renders `<OnboardingScreen />` instead of `<Shell />`.

Form:
- **Display name** input (required; non-empty).
- **Password** input (required; min 8 chars, no other complexity
  rules in v1).
- **Confirm password** input (must match).
- **Submit** button — disabled until all three pass validation.

On submit:
1. `update profiles set display_name = X where id = me`.
2. `supabase.auth.updateUser({ password })`.
3. Refetch profile.
4. Navigate to `/`.

Not skippable — by design.

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
form (since password is now mandatory, every user has one and may
prefer it over checking email). Two visible toggles: "Magic link"
(default) and "Password".

Set `shouldCreateUser: false` on the `signInWithOtp` call — belt
and suspenders since the dashboard flag also blocks it.

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

1. **PR A — Onboarding + password sign-in + dashboard flip.**
   `<OnboardingScreen />` for first-time users (no `display_name`),
   forms both display name and password. Login screen gains
   password tab and "forgot password" link.
   `/reset-password` route.
   Dashboard switch happens at deploy time.
2. **PR B — `invitations` table + Edge Function + audit trigger.**
   Self-contained. Edge Function deploys via
   `supabase functions deploy invite-user`.
3. **PR C — MyTrainees invite UI + pending invites section.**
   Depends on B. Includes Cancel and Resend.
4. **PR D — Settings "Change password" section.** Polish; can ship
   anywhere after A.

## Tests

- **Onboarding gate**: AuthProvider routes new user to onboarding
  when `display_name` is null; routes them to Shell after submit.
  Submit refuses missing password or mismatched confirm.
- **Invitation RLS**: trainer SELECTs own invites; non-trainer
  cannot; non-inviter cannot SELECT another trainer's invites.
- **`invite-user` Edge Function**: deny for non-trainer caller;
  rate-limit (11th invite in a day fails); on-conflict-do-update
  for re-invites; "already registered" branch records the
  invitation as accepted.
- **Trigger**: invited signup marks matching `invitations` row
  `accepted_at = now()`; **does not** create a `trainer_trainees`
  row.
- **Login flow**: `signInWithOtp` with `shouldCreateUser: false`
  rejects unknown email cleanly (UI message: "no account yet —
  ask a trainer").
- **Password sign-in**: existing user with password signs in via
  `signInWithPassword`.
- **Reset password**: existing user requests reset → email
  delivered (covered by integration test against a fixture
  inbox; out of scope for unit test suite — manual smoke).

## Risks / open items

1. **Inviting an already-registered user.** Supabase's
   `inviteUserByEmail` returns "User already registered". The
   function catches it and inserts the invitation with
   `accepted_at = now()` so the trainer's UI shows it as "already
   in" rather than failing. The trainer then designates them via
   the existing search → designate path.
2. **Email deliverability.** You have a custom SMTP already
   configured, so the Supabase auth-email rate-limit (3/hr on
   free) is not a concern. Verify the templates in Dashboard →
   Auth → Email Templates render correctly with your sender
   identity.
3. **Forgot-password flow needs a small new route.**
   `/reset-password` lives outside the auth-guarded shell so
   unauthenticated users can finish the reset. Plan to ship it as
   part of PR A so password recovery is functional on day one.
4. **`invited_by` integrity.** The Edge Function uses
   `auth.uid()` from the verified JWT, not any client-supplied
   value, so a trainer cannot impersonate another inviter.
5. **Invite expiry honour.** `expires_at` is informational only
   today. If hard expiry is wanted, add a check in
   `handle_invited_signup` to reject the row update (and let
   Supabase still create the user — they'd just lack an audit
   link). Not v1.
6. **Password complexity.** v1 enforces only "min 8 chars." If you
   want stronger (mixed case, digits, symbols), tighten in the
   onboarding validator. Supabase auth itself enforces nothing
   beyond minimum length you set in the dashboard.

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
