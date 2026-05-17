import { runPushOnce } from './pushWorker';
import { runPullOnce } from './pullWorker';

let pushTimer: ReturnType<typeof setInterval> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let listeners: { event: string; handler: () => void }[] = [];

async function safeRun(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { console.warn('[sync]', e); }
}

export async function flushNow(): Promise<void> {
  await safeRun(runPushOnce);
  await safeRun(runPullOnce);
}

export function startSync(): void {
  pushTimer = setInterval(() => { safeRun(runPushOnce); }, 30_000);
  pullTimer = setInterval(() => { safeRun(runPullOnce); }, 60_000);
  const onTrigger = () => { safeRun(runPushOnce); safeRun(runPullOnce); };
  window.addEventListener('online', onTrigger);
  window.addEventListener('visibilitychange', onTrigger);
  listeners.push({ event: 'online', handler: onTrigger });
  listeners.push({ event: 'visibilitychange', handler: onTrigger });
}

export function stopSync(): void {
  if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
  for (const { event, handler } of listeners) window.removeEventListener(event, handler);
  listeners = [];
}
