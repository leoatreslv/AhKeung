import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useAuth } from './useAuth';
import { useI18n } from '../i18n';
import { withTimeout } from '../utils';

const MIN_PASSWORD = 8;
const SUBMIT_TIMEOUT_MS = 10_000;

export function ResetPassword() {
  const { clearPasswordReset } = useAuth();
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | string>('idle');

  const passwordOk = password.length >= MIN_PASSWORD;
  const confirmOk = password === confirm;
  const canSubmit = passwordOk && confirmOk && status !== 'submitting';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus('submitting');
    try {
      // withTimeout (PR 6d) — a hung network can't leave the button
      // stuck on "Submitting…" indefinitely.
      const { error } = await withTimeout(
        getSupabase().auth.updateUser({ password }),
        SUBMIT_TIMEOUT_MS,
        'updateUser(password)',
      );
      if (error) {
        setStatus(`${t.resetPassword.failed}: ${error.message}`);
        return;
      }
      clearPasswordReset();
      // The gate flips on the next render and Shell takes over.
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setStatus((s) => (s === 'submitting' ? 'idle' : s));
    }
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-sm mx-auto text-slate-100">
      <h1 className="text-2xl font-bold mb-2 text-center">{t.resetPassword.title}</h1>
      <p className="text-sm text-slate-400 mb-6 text-center">{t.resetPassword.subtitle}</p>

      <label className="block mb-2">
        <span className="block text-sm mb-1">{t.resetPassword.passwordLabel}</span>
        <input
          type="password" required value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="new password"
        />
      </label>
      {password.length > 0 && !passwordOk && (
        <p className="text-amber-400 text-xs mb-3">{t.onboarding.passwordTooShort}</p>
      )}

      <label className="block mb-2">
        <span className="block text-sm mb-1">{t.resetPassword.confirmLabel}</span>
        <input
          type="password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="confirm new password"
        />
      </label>
      {confirm.length > 0 && !confirmOk && (
        <p className="text-amber-400 text-xs mb-3">{t.onboarding.passwordMismatch}</p>
      )}

      {status !== 'idle' && status !== 'submitting' && (
        <p className="text-rose-400 text-sm my-3">{status}</p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white py-2.5 rounded-lg font-semibold mt-4"
      >{status === 'submitting' ? t.resetPassword.submitting : t.resetPassword.submit}</button>
    </form>
  );
}
