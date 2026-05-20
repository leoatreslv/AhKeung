import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useAuth } from './useAuth';
import { useI18n } from '../i18n';

const MIN_PASSWORD = 8;

export function Onboarding() {
  const { user, refreshProfile } = useAuth();
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | string>('idle');

  const trimmedName = displayName.trim();
  const passwordOk = password.length >= MIN_PASSWORD;
  const confirmOk = password === confirm;
  const canSubmit = !!trimmedName && passwordOk && confirmOk && status !== 'submitting';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !user) return;
    setStatus('submitting');
    try {
      // Password first (S6): if this fails the profile stays pristine and
      // the gate re-prompts on next open.
      const { error: pwError } = await getSupabase().auth.updateUser({ password });
      if (pwError) {
        setStatus(`${t.onboarding.passwordSaveFailed}: ${pwError.message}`);
        return;
      }
      // Profile second. RLS lets the user update their own row.
      const { error: profileError } = await getSupabase().from('profiles')
        .update({ display_name: trimmedName })
        .eq('id', user.id) as { error: { message: string } | null };
      if (profileError) {
        setStatus(`${t.onboarding.profileSaveFailed}: ${profileError.message}`);
        return;
      }
      await refreshProfile();
      // Once profile.displayName is populated the gate flips and Shell
      // renders. No explicit navigate needed.
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'unknown error');
    }
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-sm mx-auto text-slate-100">
      <h1 className="text-2xl font-bold mb-2 text-center">{t.onboarding.title}</h1>
      <p className="text-sm text-slate-400 mb-6 text-center">{t.onboarding.welcome}</p>

      <label className="block mb-4">
        <span className="block text-sm mb-1">{t.onboarding.displayNameLabel}</span>
        <input
          type="text" required value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t.onboarding.displayNamePlaceholder}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="display name"
        />
      </label>

      <label className="block mb-2">
        <span className="block text-sm mb-1">{t.onboarding.passwordLabel}</span>
        <input
          type="password" required value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="password"
        />
      </label>
      {password.length > 0 && !passwordOk && (
        <p className="text-amber-400 text-xs mb-3">{t.onboarding.passwordTooShort}</p>
      )}

      <label className="block mb-2">
        <span className="block text-sm mb-1">{t.onboarding.passwordConfirm}</span>
        <input
          type="password" required value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="confirm password"
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
      >{status === 'submitting' ? t.onboarding.submitting : t.onboarding.submit}</button>
    </form>
  );
}
