// src/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function buildRealClient(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.',
    );
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PKCE binds the magic link to a verifier stored in this browser's
      // localStorage. Defeats email-scanner pre-fetch (Gmail safe browsing,
      // Outlook SafeLinks) since the scanner has no verifier and gets bounced;
      // only the real tap from the same browser can complete the exchange.
      // Trade-off: dashboard "Send/Generate Magic Link" and cross-device link
      // clicks stop working — those don't go through signInWithOtp, so no
      // verifier exists for them.
      flowType: 'pkce',
    },
  });
}

export function getSupabase(): SupabaseClient {
  if (!_client) _client = buildRealClient();
  return _client;
}

/** Test-only: inject a fake client and reset the cached one. */
export function setSupabase(client: SupabaseClient | null): void {
  _client = client;
}
