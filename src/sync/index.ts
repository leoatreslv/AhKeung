import { runPushOnce } from './pushWorker';
import { runPullOnce } from './pullWorker';
import { runImageUploadSweep } from './imageUploadSweep';

let pushTimer: ReturnType<typeof setInterval> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let listeners: { event: string; handler: () => void }[] = [];

async function safeRun(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { console.warn('[sync]', e); }
}

// Image upload always runs immediately before push: when the sweep
// succeeds, the row's existing syncQueue entry picks up the new
// imagePath on the same push tick.
async function pushWithSweep(): Promise<void> {
  await runImageUploadSweep();
  await runPushOnce();
}

export async function flushNow(): Promise<void> {
  await safeRun(pushWithSweep);
  await safeRun(runPullOnce);
}

export function startSync(): void {
  pushTimer = setInterval(() => { safeRun(pushWithSweep); }, 30_000);
  pullTimer = setInterval(() => { safeRun(runPullOnce); }, 60_000);
  const onTrigger = () => { safeRun(pushWithSweep); safeRun(runPullOnce); };
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
