// submit-diagnostics Edge Function
//
// POST body (JSON):
//   {
//     entries:    LogEntry[],
//     userAgent:  string,
//     locale:     string,
//     appVersion: string | null,
//     notes?:     string,
//   }
//
// - Verifies the caller via JWT (user client) per the same pattern as
//   invite-user.
// - Validates payload size cap (512 KB raw JSON).
// - Inserts via admin client (bypasses RLS) with a 6-char Crockford
//   base32 short_code generated server-side. Retries on the (very
//   unlikely) unique-constraint collision.
// - Returns { ok: true, id, shortCode } the UI displays so the user
//   can read the code back to support.
//
// Deploy:
//   supabase functions deploy submit-diagnostics
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

const MAX_PAYLOAD_BYTES = 512 * 1024;
// Crockford base32: no 0/O/1/I/L so the user can read codes back
// without ambiguity. 32^6 ≈ 1 billion combinations.
const SHORT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHORT_CODE_LENGTH = 6;
const MAX_CODE_RETRIES = 5;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function generateShortCode(): string {
  // @ts-expect-error — crypto is global in the Edge runtime
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH));
  let out = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) out += SHORT_CODE_ALPHABET[bytes[i] % 32];
  return out;
}

interface Body {
  entries?: unknown[];
  userAgent?: string;
  locale?: string;
  appVersion?: string | null;
  notes?: string;
}

// @ts-expect-error — Deno.serve is provided by the Edge runtime
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  // ─── Caller auth ─────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'missing Authorization header' }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: 'unauthenticated' }, 401);

  // ─── Payload validation ──────────────────────────────────────────
  let raw: string;
  try { raw = await req.text(); }
  catch { return jsonResponse({ error: 'unreadable body' }, 400); }
  if (raw.length === 0) return jsonResponse({ error: 'empty body' }, 400);
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: 'payload too large', maxBytes: MAX_PAYLOAD_BYTES }, 413);
  }

  let body: Body;
  try { body = JSON.parse(raw); }
  catch { return jsonResponse({ error: 'invalid JSON' }, 400); }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'invalid body shape' }, 400);

  // ─── Insert with retry on short_code collision ───────────────────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    const shortCode = generateShortCode();
    const { data, error } = await admin.from('diagnostics_reports').insert({
      short_code: shortCode,
      user_id: user.id,
      app_version: body.appVersion ?? null,
      user_agent: body.userAgent ?? null,
      locale: body.locale ?? null,
      payload: { entries: body.entries ?? [] },
      notes: body.notes ?? null,
    }).select('id').single();

    if (error) {
      // 23505 = unique_violation on short_code — retry with fresh code.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((error as any).code === '23505') continue;
      return jsonResponse({ error: error.message }, 500);
    }
    return jsonResponse({ ok: true, id: data?.id, shortCode });
  }
  return jsonResponse({ error: 'short_code generation exhausted' }, 500);
});
