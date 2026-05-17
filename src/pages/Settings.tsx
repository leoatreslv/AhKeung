import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase } from '../supabase';
import { useAuth } from '../auth/useAuth';

export function Settings() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [online, setOnline] = useState(navigator.onLine);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | string>('idle');

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Auto-clear the "Saved" badge after 2s so a later stale state can't linger.
  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(t);
  }, [status]);

  async function save() {
    if (!user) return;
    setSaving(true);
    setStatus('idle');
    try {
      const { error } = await getSupabase().from('profiles')
        .update({ display_name: name }).eq('id', user.id) as { error: { message: string } | null };
      if (error) {
        setStatus(`Save failed: ${error.message}`);
      } else {
        setStatus('saved');
      }
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 space-y-4 text-slate-100">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/')}
          aria-label="back"
          className="text-slate-300 text-xl leading-none px-1"
        >←</button>
        <h2 className="text-lg font-bold">Settings</h2>
        {profile?.isTrainer && (
          <span className="ml-auto text-[10px] uppercase tracking-wider bg-keung-600/30 border border-keung-600/60 text-keung-300 px-2 py-0.5 rounded-full">
            Trainer
          </span>
        )}
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">Display name</label>
        <input
          value={name}
          disabled={!online}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 disabled:opacity-50"
        />
        {!online && <p className="text-xs text-slate-500 mt-1">Connect to edit.</p>}
        <button
          onClick={save} disabled={!online || saving}
          className="mt-2 px-3 py-1.5 text-sm bg-keung-600 hover:bg-keung-700 disabled:opacity-50 rounded"
        >{saving ? 'Saving…' : 'Save'}</button>
        {status === 'saved' && <span className="ml-2 text-xs text-slate-400">Saved</span>}
        {status !== 'idle' && status !== 'saved' && (
          <p className="text-rose-400 text-xs mt-1">{status}</p>
        )}
      </div>
      <p className="text-sm text-slate-400">Signed in as {user?.email}</p>
      <button
        onClick={async () => { await signOut(); navigate('/'); }}
        className="bg-rose-900/40 border border-rose-800 text-rose-300 px-4 py-2 rounded-lg"
      >Sign out</button>
    </div>
  );
}
