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
      // detectSessionInUrl=false: supabase-js's auto-detect only looks for
      // ?code= (PKCE OAuth code exchange) and #access_token= (implicit
      // flow). We use neither: invite + recovery links arrive as
      // ?type=…&token_hash=… and are handled explicitly in
      // src/auth/AuthProvider.tsx#consumeAuthLink via verifyOtp. Disabling
      // auto-detect removes a code path we don't use — no functional
      // change for our flows, but eliminates one potential source of
      // races between our manual handler and supabase-js's internal
      // bootstrap.
      detectSessionInUrl: false,
      // PKCE is still required for the password-recovery email
      // (resetPasswordForEmail emits ?code= links protected by a
      // verifier stored in this browser's localStorage). Don't drop it.
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
