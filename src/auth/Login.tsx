import { useState } from 'react';
import { getSupabase } from '../supabase';

export function Login() {
  const [email, setEmail] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await getSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      setSubmittedEmail(email);
    } catch {
      setError("Couldn't send the link. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (submittedEmail) {
    return (
      <div className="p-6 max-w-sm mx-auto text-center text-slate-100">
        <h1 className="text-2xl font-bold mb-4">Ah Keung 💪</h1>
        <p className="mb-4">Check your email at <strong>{submittedEmail}</strong>.</p>
        <p className="text-sm text-slate-400 mb-6">Tap the link on this device to sign in.</p>
        <button
          onClick={() => { setSubmittedEmail(null); setError(null); }}
          className="text-keung-500 text-sm"
        >Try a different email</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="p-6 max-w-sm mx-auto text-slate-100">
      <h1 className="text-2xl font-bold mb-6 text-center">Ah Keung 💪</h1>
      <label className="block mb-4">
        <span className="block text-sm mb-1">Email</span>
        <input
          type="email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
          aria-label="email"
        />
      </label>
      {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
      <button
        type="submit" disabled={sending}
        className="w-full bg-keung-600 hover:bg-keung-700 disabled:opacity-50 text-white py-2.5 rounded-lg font-semibold"
      >{sending ? 'Sending…' : 'Send sign-in link'}</button>
    </form>
  );
}
