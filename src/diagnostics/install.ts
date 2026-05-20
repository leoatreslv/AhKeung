// Registers window-level error handlers exactly once. Called from
// main.tsx at app boot so uncaught errors and unhandled promise
// rejections land in the diagnostics buffer with a proper category.

import { log } from './logger';
import { CATEGORY } from './categories';

let installed = false;

export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    log.error(
      CATEGORY.uncaught,
      e.message || 'window error',
      e.error instanceof Error ? e.error : { stack: e.error == null ? null : String(e.error) },
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    log.error(
      CATEGORY['unhandled-rejection'],
      'unhandled promise rejection',
      reason instanceof Error ? reason : { reason: reason == null ? null : String(reason) },
    );
  });
}
