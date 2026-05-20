// alert-scan Edge Function — daily threshold check + email alert.
//
// Counts in the last 24h:
//   - sync.dead_letter audit events
//   - *.failed audit events
// If either exceeds its threshold, sends one email summary to ALERT_TO
// via the configured SMTP creds.
//
// Caller auth: requires the service-role JWT as Bearer. This function
// is intended to be called by a pg_cron job via pg_net.http_post, or
// manually by an operator. NEVER expose it to the anon client.
//
// Deploy:
//   supabase functions deploy alert-scan
//   supabase secrets set ALERT_SMTP_HOST=...     \
//                        ALERT_SMTP_PORT=587     \
//                        ALERT_SMTP_USER=...     \
//                        ALERT_SMTP_PASS=...     \
//                        ALERT_FROM=alerts@example.com \
//                        ALERT_TO=ops@example.com
//
// Schedule via pg_cron (run once in the SQL editor; needs pg_net):
//   select cron.schedule(
//     'daily-alert-scan',
//     '0 9 * * *',
//     $$ select net.http_post(
//          url     := '<your-project>.supabase.co/functions/v1/alert-scan',
//          headers := jsonb_build_object(
//            'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
//            'Content-Type',  'application/json'
//          )
//        ); $$
//   );

// @ts-expect-error — Deno-native imports
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.4';
// @ts-expect-error — Deno-native imports
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

// @ts-expect-error — Deno globals available at runtime
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// @ts-expect-error — Deno globals
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// @ts-expect-error — Deno globals
const SMTP_HOST = Deno.env.get('ALERT_SMTP_HOST');
// @ts-expect-error — Deno globals
const SMTP_PORT = parseInt(Deno.env.get('ALERT_SMTP_PORT') ?? '587');
// @ts-expect-error — Deno globals
const SMTP_USER = Deno.env.get('ALERT_SMTP_USER');
// @ts-expect-error — Deno globals
const SMTP_PASS = Deno.env.get('ALERT_SMTP_PASS');
// @ts-expect-error — Deno globals
const ALERT_FROM = Deno.env.get('ALERT_FROM');
// @ts-expect-error — Deno globals
const ALERT_TO = Deno.env.get('ALERT_TO');

const DEAD_LETTER_THRESHOLD = parseInt(
  // @ts-expect-error — Deno globals
  Deno.env.get('ALERT_DEAD_LETTER_THRESHOLD') ?? '5',
);
const FAILED_EVENT_THRESHOLD = parseInt(
  // @ts-expect-error — Deno globals
  Deno.env.get('ALERT_FAILED_THRESHOLD') ?? '10',
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// @ts-expect-error — Deno.serve provided by the Edge runtime
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ error: 'POST or GET only' }, 405);
  }

  // Caller auth: must present the service-role JWT. pg_cron + pg_net
  // is the intended caller. We can't use the anon-key + getUser()
  // pattern here because there's no end-user.
  const auth = req.headers.get('Authorization');
  if (auth !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Two head-counts in parallel — cheap with the audit_events_type index.
  const [{ count: deadLetterCount, error: dErr },
         { count: failedCount,     error: fErr }] = await Promise.all([
    admin.from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'sync.dead_letter')
      .gte('created_at', since),
    admin.from('audit_events')
      .select('id', { count: 'exact', head: true })
      .like('event_type', '%.failed')
      .gte('created_at', since),
  ]);
  if (dErr || fErr) {
    return jsonResponse({ error: 'count query failed', details: dErr?.message ?? fErr?.message }, 500);
  }

  const dl = deadLetterCount ?? 0;
  const ff = failedCount ?? 0;
  const triggers: string[] = [];
  if (dl >= DEAD_LETTER_THRESHOLD) {
    triggers.push(`sync.dead_letter: ${dl} in 24h (threshold ${DEAD_LETTER_THRESHOLD})`);
  }
  if (ff >= FAILED_EVENT_THRESHOLD) {
    triggers.push(`*.failed: ${ff} in 24h (threshold ${FAILED_EVENT_THRESHOLD})`);
  }

  if (triggers.length === 0) {
    return jsonResponse({ ok: true, deadLetterCount: dl, failedCount: ff, alerted: false });
  }

  if (!SMTP_HOST || !ALERT_FROM || !ALERT_TO) {
    return jsonResponse({
      error: 'SMTP not configured (set ALERT_SMTP_HOST / ALERT_FROM / ALERT_TO)',
      triggers,
    }, 500);
  }

  const smtp = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port: SMTP_PORT,
      tls: SMTP_PORT === 465,
      auth: SMTP_USER && SMTP_PASS ? { username: SMTP_USER, password: SMTP_PASS } : undefined,
    },
  });
  try {
    await smtp.send({
      from:    ALERT_FROM,
      to:      ALERT_TO,
      subject: `[Ah Keung] Alert scan: ${triggers.length} threshold(s) tripped`,
      content: [
        `Window: last 24h (since ${since}).`,
        '',
        ...triggers.map((t) => `  • ${t}`),
        '',
        'Review audit_events in the Supabase dashboard:',
        '  select event_type, user_id, resource, metadata, created_at',
        '    from audit_events',
        `   where created_at >= '${since}'`,
        '   order by created_at desc;',
      ].join('\n'),
    });
  } finally {
    await smtp.close();
  }

  return jsonResponse({ ok: true, alerted: true, triggers, deadLetterCount: dl, failedCount: ff });
});
