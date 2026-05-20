import { useState } from 'react';
import { getSupabase } from '../supabase';
import { useI18n } from '../i18n';

type Mode = 'magic' | 'password' | 'forgot';

export function Login() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('magic');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function classifyError(err: unknown): string {
    const msg = err instanceof Error ? err.message : '';
    if (/signups not allowed/i.test(msg) || /not found/i.test(msg) || /user not found/i.test(msg)) {
      return t.login.noAccountYet;
    }
    if (/rate limit/i.test(msg) || /too many/i.test(msg)) {
      return t.login.rateLimited;
    }
    if (/invalid (login )?credentials/i.test(msg) || /invalid password/i.test(msg)) {
      return t.login.invalidPassword;
    }
    return t.login.linkFailed;
  }

  async function submitMagic(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      // shouldCreateUser: false makes the OTP path reject unknown emails
      // — belt and suspenders with the dashboard's "Allow new user
      // sign-ups: off" flag.
      await getSupabase().auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: window.location.origin,
        },
      });
      setSubmittedEmail(email);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSending(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const { error: err } = await getSupabase().auth.signInWithPassword({ email, password });
      if (err) throw err;
      // SIGNED_IN event fires; AuthProvider routes us in.
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSending(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await getSupabase().auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      setResetSent(email);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSending(false);
    }
  }

  if (submittedEmail) {
    return (
      <div className="p-6 max-w-sm mx-auto text-center text-slate-100">
        <h1 className="text-2xl font-bold mb-4">Ah Keung 💪</h1>
        <p className="mb-4">{t.login.checkEmail} <strong>{submittedEmail}</strong>.</p>
        <p className="text-sm text-slate-400 mb-6">{t.login.tapLinkHere}</p>
        <button
          type="button"
          onClick={() => { setSubmittedEmail(null); setError(null); }}
          className="text-keung-500 text-sm"
        >{t.login.differentEmail}</button>
      </div>
    );
  }

  if (resetSent) {
    return (
      <div className="p-6 max-w-sm mx-auto text-center text-slate-100">
        <h1 className="text-2xl font-bold mb-4">Ah Keung 💪</h1>
        <p className="mb-4">{t.login.resetSent} <strong>{resetSent}</strong>.</p>
        <p className="text-sm text-slate-400 mb-6">{t.login.resetInstructions}</p>
        <button
          type="button"
          onClick={() => { setResetSent(null); setMode('magic'); setError(null); }}
          className="text-keung-500 text-sm"
        >{t.login.backToSignIn}</button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-sm mx-auto text-slate-100">
      <h1 className="text-2xl font-bold mb-2 text-center">Ah Keung 💪</h1>
      <p className="text-xs text-slate-400 mb-6 text-center">{t.login.byInvitationOnly}</p>

      {mode !== 'forgot' && (
        <div role="tablist" className="flex bg-slate-800 rounded-lg p-1 mb-4">
          <button
            type="button" role="tab" aria-selected={mode === 'magic'}
            onClick={() => { setMode('magic'); setError(null); }}
            className={`flex-1 text-sm py-1.5 rounded ${mode === 'magic' ? 'bg-keung-600 text-white' : 'text-slate-300'}`}
          >{t.login.useMagicLink}</button>
          <button
            type="button" role="tab" aria-selected={mode === 'password'}
            onClick={() => { setMode('password'); setError(null); }}
            className={`flex-1 text-sm py-1.5 rounded ${mode === 'password' ? 'bg-keung-600 text-white' : 'text-slate-300'}`}
          >{t.login.usePassword}</button>
        </div>
      )}

      <form onSubmit={
        mode === 'magic' ? submitMagic
          : mode === 'password' ? submitPassword
          : submitReset
      }>
        <label className="block mb-4">
          <span className="block text-sm mb-1">{t.login.emailLabel}</span>
          <input
            type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
            aria-label="email"
          />
        </label>

        {mode === 'password' && (
          <label className="block mb-4">
            <span className="block text-sm mb-1">{t.login.passwordLabel}</span>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
              aria-label="password"
            />
          </label>
        )}

        {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}

        <button
          type="submit" disabled={sending}
          className="w-full bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white py-2.5 rounded-lg font-semibold"
        >
          {sending ? t.login.sending
            : mode === 'magic'    ? t.login.sendMagicLink
            : mode === 'password' ? t.login.signIn
            :                       t.login.sendReset}
        </button>
      </form>

      <div className="mt-4 text-center text-xs">
        {mode === 'forgot' ? (
          <button
            type="button"
            onClick={() => { setMode('magic'); setError(null); }}
            className="text-keung-500"
          >{t.login.backToSignIn}</button>
        ) : (
          <button
            type="button"
            onClick={() => { setMode('forgot'); setError(null); }}
            className="text-slate-400 hover:text-keung-500"
          >{t.login.forgotPassword}</button>
        )}
      </div>
    </div>
  );
}
