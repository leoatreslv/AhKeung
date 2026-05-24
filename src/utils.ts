export const todayISO = () => new Date().toISOString().slice(0, 10);

export const weekStartISO = (d: Date = new Date()) => {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
};

export const formatDate = (iso: string, locale?: string) =>
  new Date(iso).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });

export const formatDuration = (ms: number) => {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
};

/** Race a promise against a setTimeout-driven reject. Used at every
 *  Supabase-call site that's on a user-blocking path (AuthProvider
 *  bootstrap, Onboarding submit, ResetPassword submit, Settings
 *  password change / display-name save). Without it, a hung network
 *  request leaves the user on a "Saving…" / "Loading…" screen with
 *  no recovery surface; with it, the call throws after `ms` and the
 *  caller's catch can show an error or fall through to a safe state.
 *
 *  The timer is cleared on success so it doesn't outlive the
 *  operation (no leaked setTimeout). `label` is included in the
 *  rejection message so diagnostics can tell which call site
 *  timed out. */
export async function withTimeout<T>(
  promise: Promise<T>, ms: number, label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
