// invite-user Edge Function
//
// POST { email: string }
//
// - Verifies caller is a trainer (JWT + is_trainer RPC).
// - Rate-limits to 10 active invites per trainer per rolling 24h
//   window, serialised via pg_advisory_xact_lock to defeat the
//   "both see 9, both insert" race.
// - Calls supabase.auth.admin.inviteUserByEmail with the caller's id
//   in user_metadata.invited_by so the handle_invited_signup trigger
//   can stamp accepted_at on the row.
// - If the email is already registered, the admin call returns
//   "User already registered". The function catches that, records the
//   invitation with already_existed = true (NO accepted_at stamp —
//   the user never accepted *this* invite; they were already in), and
//   returns 200 so the trainer's UI can surface it as
//   "already had an account". The trainer then designates the
//   existing user via the regular search → designate path.
//
// Deploy:
//   supabase functions deploy invite-user
//
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are
// provided to Edge Functions automatically — no secrets to set.

// @ts-expect-error — Deno-native imports
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.4';

// @ts-expect-error — Deno globals available at runtime
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error — Deno globals
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// @ts-expect-error — Deno globals
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RATE_LIMIT_PER_DAY = 10;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

// @ts-expect-error — Deno.serve is provided by the Edge runtime
Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (e) {
    // Anything that escapes `handle` becomes a structured 500 instead
    // of an EDGE_FUNCTION_ERROR shutdown. The body carries the actual
    // error message so the next debug round-trip points at the real
    // throw site instead of "function crashed".
    console.error('[invite-user] unhandled throw:', e);
    return jsonResponse({
      error: 'unhandled exception',
      message: e instanceof Error ? e.message : String(e),
      name:    e instanceof Error ? e.name    : null,
    }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405);
  }

  // ─── Caller auth (user client, forwards JWT) ─────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'missing Authorization header' }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'unauthenticated' }, 401);

  const { data: isTrainerData, error: rpcErr } = await userClient.rpc('is_trainer');
  if (rpcErr) return jsonResponse({ error: `is_trainer check failed: ${rpcErr.message}` }, 500);
  if (!isTrainerData) return jsonResponse({ error: 'trainer only' }, 403);

  // ─── Parse body ──────────────────────────────────────────────────
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'invalid body' }, 400);
  const email = (body as { email?: unknown }).email;
  if (!isValidEmail(email)) return jsonResponse({ error: 'invalid email' }, 400);
  const normalisedEmail = email.toLowerCase();

  // ─── Admin client (service role) for everything below ────────────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ─── Rate limit — serialise via advisory lock ────────────────────
  // The lock key is derived from the inviter's UUID so concurrent
  // requests from the same trainer block each other but unrelated
  // trainers don't contend. Using a transaction-scoped lock means it
  // releases when this function's connection commits/rolls back.
  const { data: lockData, error: lockErr } = await admin.rpc('invite_rate_check', {
    inviter: user.id,
    max_per_day: RATE_LIMIT_PER_DAY,
  });
  if (lockErr) return jsonResponse({ error: `rate check failed: ${lockErr.message}` }, 500);
  if (lockData && lockData.exceeded) {
    return jsonResponse({ error: 'rate limit exceeded', limit: RATE_LIMIT_PER_DAY }, 429);
  }

  // ─── Look up the inviter's display name for the email template ───
  // The template (Dashboard → Authentication → Email Templates → "Invite
  // user") can reference {{ .Data.inviter_name }} to personalise the
  // greeting. Falls back to "your trainer" if the trainer hasn't set a
  // display name yet, or if the lookup throws/fails for any reason
  // (the invite must not 500 because we couldn't read one column).
  let inviterName = 'your trainer';
  try {
    const { data: inviterRow } = await admin.from('profiles')
      .select('display_name').eq('id', user.id).maybeSingle() as
      { data: { display_name: string | null } | null };
    const trimmed = inviterRow?.display_name?.trim();
    if (trimmed) inviterName = trimmed;
  } catch (e) {
    console.warn('[invite-user] inviter name lookup failed:',
      e instanceof Error ? e.message : String(e));
  }

  // ─── Send the admin invite ───────────────────────────────────────
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      invited_by:   user.id,
      inviter_name: inviterName,
    },
  });

  const alreadyExisted = !!inviteErr && /already (registered|exists)/i.test(inviteErr.message);

  if (inviteErr && !alreadyExisted) {
    return jsonResponse({ error: `invite failed: ${inviteErr.message}` }, 500);
  }

  // ─── Already-existed branch: send a recovery email instead ───────
  // The user has an auth.users row (either from a previous self-signup
  // attempt or because their first invite link was burned by an inbox
  // pre-fetcher before they clicked it). inviteUserByEmail refuses to
  // re-issue, so fall back to resetPasswordForEmail. The recipient
  // verifies that link via the same ?type=recovery path the
  // AuthProvider already handles, and since their profile has no
  // display_name yet, App.tsx routes them straight to Onboarding —
  // not ResetPassword, courtesy of the routing guard added in the
  // same PR that landed this branch.
  //
  // Use a fresh anon-keyed client (not the admin one): the auth
  // /recover endpoint authenticates the request via the anon apikey
  // header; a service-role apikey path can throw in some supabase-js
  // versions. Wrapped in try/catch so a recovery-email failure can
  // NEVER 500 the function — the trainer's UI can still fall back to
  // asking the recipient to use "Forgot password?" themselves.
  if (alreadyExisted) {
    const origin = req.headers.get('origin') ?? req.headers.get('referer') ?? undefined;
    try {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: recoverErr } = await anonClient.auth.resetPasswordForEmail(email, {
        redirectTo: origin,
      });
      if (recoverErr) {
        console.warn('[invite-user] recovery email failed:', recoverErr.message);
      }
    } catch (e) {
      console.warn('[invite-user] recovery email threw:',
        e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Record / upsert the invitation row ──────────────────────────
  // - cancelled_at cleared (re-invite after cancel).
  // - created_at / expires_at bumped (re-invite = fresh window).
  // - accepted_at preserved via coalesce if previously set.
  // - already_existed = true on the existing-user branch; else false.
  const { data: upserted, error: upsertErr } = await admin
    .from('invitations')
    .upsert({
      inviter_id:      user.id,
      email:           normalisedEmail,
      created_at:      new Date().toISOString(),
      expires_at:      new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      cancelled_at:    null,
      already_existed: alreadyExisted,
    }, { onConflict: 'inviter_id,email' })
    .select('id')
    .single() as { data: { id: string } | null; error: { message: string } | null };

  if (upsertErr) return jsonResponse({ error: `record failed: ${upsertErr.message}` }, 500);

  // ─── Audit emit (already_existed branch only) ────────────────────
  // The trigger on invitations.INSERT emits `invite.sent` for the
  // fresh-invite branch (already_existed=false). The already_existed
  // path is silent at the trigger level (B1 gate), so the function
  // emits its own event here with extra metadata the trigger can't
  // see (caller UA).
  if (alreadyExisted) {
    const maskedEmail = normalisedEmail.length > 1 && normalisedEmail.includes('@')
      ? normalisedEmail[0]
        + '*'.repeat(Math.max(1, normalisedEmail.indexOf('@') - 1))
        + normalisedEmail.slice(normalisedEmail.indexOf('@'))
      : normalisedEmail;
    const userAgent = req.headers.get('user-agent') ?? null;
    // Best-effort: a failed audit insert must not fail the invite.
    // The function already returned all its work; we just log.
    const { error: auditErr } = await admin.from('audit_events').insert({
      user_id:    user.id,
      event_type: 'invite.already_existed',
      resource:   { type: 'invitation', id: upserted?.id ?? null },
      metadata:   { inviter: user.id, email_masked: maskedEmail, ua: userAgent },
    });
    if (auditErr) console.warn('[invite-user] audit emit failed:', auditErr.message);
  }

  return jsonResponse({
    ok: true,
    invitationId: upserted?.id,
    alreadyExisted,
  });
}
