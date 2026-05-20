// Client-side wrapper around the submit-diagnostics Edge Function.
// Collects the in-memory log buffer + an env snapshot and posts it.

import { getSupabase } from '../supabase';
import { recentLog } from './logger';

export interface SubmitResult {
  ok: boolean;
  id?: string;
  shortCode?: string;
  error?: string;
}

interface FunctionsHttpError {
  message?: string;
  context?: { json?: () => Promise<{ error?: string }> };
}

export async function submitDiagnostics(opts: { notes?: string } = {}): Promise<SubmitResult> {
  const entries = await recentLog();
  const payload = {
    entries,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    locale: typeof navigator !== 'undefined' ? navigator.language : null,
    // VITE_APP_VERSION is set at build time via vite.config.ts's define.
    // Absent in test/dev: null is fine.
    appVersion: import.meta.env.VITE_APP_VERSION ?? null,
    notes: opts.notes ?? null,
  };
  const { data, error } = await getSupabase()
    .functions.invoke<SubmitResult>('submit-diagnostics', { body: payload });
  if (error) {
    let body: { error?: string } | null = null;
    try {
      const json = await (error as FunctionsHttpError).context?.json?.();
      if (json) body = json;
    } catch { /* non-JSON body */ }
    return {
      ok: false,
      error: body?.error ?? (error as FunctionsHttpError).message ?? 'submit failed',
    };
  }
  return data ?? { ok: false, error: 'no response' };
}
