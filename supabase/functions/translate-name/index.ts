// translate-name Edge Function
//
// Proxies Google Cloud Translation v2 so the API key never leaves the
// server. Authenticates the caller via the standard Supabase JWT
// verification (Deno runtime gates the request before this handler).
//
// Deploy:
//   supabase functions deploy translate-name
//   supabase secrets set GOOGLE_TRANSLATE_API_KEY=...
//
// Request body:  { q: string, source: 'en'|'zh-TW', target: 'en'|'zh-TW' }
// Response 200:  { translatedText: string }
// Response 4xx:  { error: string }

// @ts-expect-error — Deno globals are available at runtime in Supabase Edge Functions
const KEY = Deno.env.get('GOOGLE_TRANSLATE_API_KEY');

interface Body {
  q: string;
  source: 'en' | 'zh-TW';
  target: 'en' | 'zh-TW';
}

function isValidBody(b: unknown): b is Body {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return typeof o.q === 'string' && o.q.length > 0 && o.q.length <= 200
    && (o.source === 'en' || o.source === 'zh-TW')
    && (o.target === 'en' || o.target === 'zh-TW')
    && o.source !== o.target;
}

// @ts-expect-error — Deno.serve is provided by the Supabase Edge runtime
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }
  if (!KEY) {
    return new Response(JSON.stringify({ error: 'translate not configured' }), { status: 503 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!isValidBody(body)) {
    return new Response(JSON.stringify({ error: 'invalid body' }), { status: 400 });
  }

  const url = `https://translation.googleapis.com/language/translate/v2?key=${KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      q: body.q,
      source: body.source,
      target: body.target,
      format: 'text',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: `upstream ${res.status}: ${text}` }), { status: 502 });
  }

  const json = await res.json() as {
    data?: { translations?: { translatedText?: string }[] };
  };
  const translatedText = json.data?.translations?.[0]?.translatedText;
  if (!translatedText) {
    return new Response(JSON.stringify({ error: 'no translation in response' }), { status: 502 });
  }

  return new Response(JSON.stringify({ translatedText }), {
    headers: { 'content-type': 'application/json' },
  });
});
