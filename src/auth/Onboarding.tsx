import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useAuth } from './useAuth';
import { useI18n } from '../i18n';
import { withTimeout } from '../utils';
import { log } from '../diagnostics/logger';
import { CATEGORY } from '../diagnostics/categories';
import { PasswordField } from './PasswordField';
import { resetApp } from '../resetApp';

const MIN_PASSWORD = 8;
const SUBMIT_TIMEOUT_MS = 10_000;

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
      // the gate re-prompts on next open. Wrapped in withTimeout —
      // PR 6d — so a hung network can't leave the button stuck on
      // "Saving…" indefinitely (the bug that hit sylung@gmail.com).
      const { error: pwError } = await withTimeout(
        getSupabase().auth.updateUser({ password }),
        SUBMIT_TIMEOUT_MS,
        'updateUser(password)',
      );
      if (pwError) {
        setStatus(`${t.onboarding.passwordSaveFailed}: ${pwError.message}`);
        log.error(CATEGORY.onboarding, 'password save failed', { message: pwError.message });
        return;
      }
      // Profile second. RLS lets the user update their own row.
      const { error: profileError } = await withTimeout(
        getSupabase().from('profiles')
          .update({ display_name: trimmedName })
          .eq('id', user.id) as unknown as Promise<{ error: { message: string } | null }>,
        SUBMIT_TIMEOUT_MS,
        'profiles.update(display_name)',
      );
      if (profileError) {
        setStatus(`${t.onboarding.profileSaveFailed}: ${profileError.message}`);
        log.error(CATEGORY.onboarding, 'profile save failed', { message: profileError.message });
        return;
      }
      log.info(CATEGORY.onboarding, 'complete');
      // refreshProfile has its own internal timeout via PR 6c.
      await refreshProfile();
      // Once profile.displayName is populated the gate flips and Shell
      // renders. No explicit navigate needed.
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'unknown error');
      log.error(CATEGORY.onboarding, 'submit threw', {
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // If the gate flipped, Onboarding has already unmounted and this
      // setStatus is a no-op. If it didn't flip (refreshProfile errored,
      // or we returned early on a server error), reset to 'idle' so the
      // button is enabled and the user can retry instead of staring at
      // a stuck "Saving…" forever.
      setStatus((s) => (s === 'submitting' ? 'idle' : s));
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

      <PasswordField
        value={password}
        onChange={setPassword}
        label={t.onboarding.passwordLabel}
        ariaLabel="password"
        autoComplete="new-password"
        required
      />
      {password.length > 0 && !passwordOk && (
        <p className="text-amber-400 text-xs mb-3">{t.onboarding.passwordTooShort}</p>
      )}

      <PasswordField
        value={confirm}
        onChange={setConfirm}
        label={t.onboarding.passwordConfirm}
        ariaLabel="confirm password"
        autoComplete="new-password"
        required
      />
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

      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t.resetApp.confirmOnboarding)) void resetApp();
          }}
          className="text-xs text-slate-500 hover:text-slate-300 underline"
        >{t.resetApp.button}</button>
      </div>
    </form>
  );
}
