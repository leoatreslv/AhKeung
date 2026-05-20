// Structured client logger backed by a dedicated IndexedDB ring buffer.
//
// Storage isolation (per docs/logging-plan.md S4): the buffer lives in
// its OWN Dexie database `ah-keung-diagnostics`, NOT in the main
// `ah-keung` DB. The existing sign-out handler does `db.delete()` on
// `ah-keung` to wipe user data — but the diagnostics DB is untouched
// so the buffer survives sign-out, which is precisely when users want
// to file a support report.
//
// Concurrency (B3): no race-prone "count + delete on every insert"
// pattern. All emits append to an in-memory queue; a debounced flush
// every 250 ms (or immediately on >= 50 pending entries) writes them
// in one bulkAdd transaction and prunes to MAX_BUFFER_ROWS afterward
// via `seq` ordering. A `flushing` guard prevents re-entry.

import Dexie, { type Table } from 'dexie';
import type { Category } from './categories';

export type Level = 'info' | 'warn' | 'error';

export interface LogEntry {
  seq?: number;
  ts: number;
  level: Level;
  category: Category;
  message: string;
  context?: Record<string, unknown>;
  errorStack?: string;
}

class DiagnosticsDB extends Dexie {
  diagnostics_log!: Table<LogEntry, number>;
  constructor() {
    super('ah-keung-diagnostics');
    this.version(1).stores({
      diagnostics_log: '++seq, ts',
    });
  }
}

let diagDb: DiagnosticsDB = new DiagnosticsDB();

/** Test-only: replace the Dexie instance so fake-indexeddb can isolate
 *  per-test state. Not exported from the public surface in real use. */
export function __setDb(next: DiagnosticsDB): void { diagDb = next; }
export function __resetDb(): void { diagDb = new DiagnosticsDB(); }

const MAX_BUFFER_ROWS = 500;
const FLUSH_DEBOUNCE_MS = 250;
const FLUSH_THRESHOLD = 50;
const STACK_BYTE_CAP = 2048;
const STACK_FRAME_CAP = 10;

const pending: LogEntry[] = [];
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushing) return;
  if (pending.length === 0) return;
  flushing = true;
  try {
    const toWrite = pending.splice(0, pending.length);
    await diagDb.transaction('rw', diagDb.diagnostics_log, async () => {
      await diagDb.diagnostics_log.bulkAdd(toWrite);
      const count = await diagDb.diagnostics_log.count();
      if (count > MAX_BUFFER_ROWS) {
        const excess = count - MAX_BUFFER_ROWS;
        const oldestKeys = await diagDb.diagnostics_log
          .orderBy('seq').limit(excess).primaryKeys();
        await diagDb.diagnostics_log.bulkDelete(oldestKeys);
      }
    });
  } catch (e) {
    // Don't recursively log — if logging is broken, fall back to console
    // so the diagnostic system's failure mode isn't silent.
    console.warn('[diagnostics] flush failed', e);
  } finally {
    flushing = false;
    if (pending.length > 0) schedule();
  }
}

function truncateStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  // First line is the error name/message; keep it + STACK_FRAME_CAP frames.
  const lines = stack.split('\n').slice(0, STACK_FRAME_CAP + 1);
  const joined = lines.join('\n');
  return joined.length > STACK_BYTE_CAP ? joined.slice(0, STACK_BYTE_CAP) : joined;
}

type Tap = (entry: LogEntry) => void;
const taps: Tap[] = [];

/** Subscribe to every emitted log entry. Used by future integrations
 *  (Sentry / Axiom) without coupling them to the storage layer. */
export function onLog(cb: Tap): () => void {
  taps.push(cb);
  return () => {
    const i = taps.indexOf(cb);
    if (i >= 0) taps.splice(i, 1);
  };
}

function emit(entry: LogEntry): void {
  pending.push(entry);
  if (pending.length >= FLUSH_THRESHOLD) {
    void flush();
  } else {
    schedule();
  }
  for (const t of taps) {
    try { t(entry); } catch { /* tap failure can't break logging */ }
  }
}

function normalizeErrorArg(arg: unknown): { context?: Record<string, unknown>; errorStack?: string } {
  if (arg instanceof Error) {
    return {
      context: { name: arg.name, message: arg.message },
      errorStack: truncateStack(arg.stack),
    };
  }
  if (arg && typeof arg === 'object') {
    return { context: arg as Record<string, unknown> };
  }
  if (arg !== undefined) {
    return { context: { value: String(arg) } };
  }
  return {};
}

export const log = {
  info(category: Category, message: string, context?: Record<string, unknown>): void {
    if (import.meta.env.DEV) {
      console.log(`[${category}]`, message, context ?? '');
    }
    emit({ ts: Date.now(), level: 'info', category, message, context });
  },
  warn(category: Category, message: string, context?: Record<string, unknown>): void {
    console.warn(`[${category}]`, message, context ?? '');
    emit({ ts: Date.now(), level: 'warn', category, message, context });
  },
  error(category: Category, message: string, contextOrError?: unknown): void {
    const { context, errorStack } = normalizeErrorArg(contextOrError);
    console.error(`[${category}]`, message, context ?? '', errorStack ?? '');
    emit({ ts: Date.now(), level: 'error', category, message, context, errorStack });
  },
};

/** Returns the most recent N entries (newest first). */
export async function recentLog(limit = MAX_BUFFER_ROWS): Promise<LogEntry[]> {
  // Flush any pending before reading so the view matches "what just happened."
  await flush();
  return await diagDb.diagnostics_log.orderBy('seq').reverse().limit(limit).toArray();
}

/** Drains the in-memory queue + clears the persisted buffer. */
export async function clearLog(): Promise<void> {
  pending.length = 0;
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  await diagDb.diagnostics_log.clear();
}

/** Masks the local-part of an email — `leo@reslv.io` → `l**@reslv.io`.
 *  Call sites must wrap user-supplied emails when logging them; the
 *  logger itself does NOT auto-redact arbitrary fields. The
 *  `local/no-unmasked-email` ESLint rule (PR A) enforces this at CI. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;  // not an email, leave alone
  const local = email.slice(0, at);
  const head = local[0];
  const masked = head + '*'.repeat(Math.max(1, local.length - 1));
  return masked + email.slice(at);
}

// Test-only: drain the in-memory queue to disk. Loops until pending
// is empty + no flush is in-flight, so the post-flush prune has run
// to completion before the test asserts on the row count.
export async function __flushForTest(): Promise<void> {
  // Bounded loop: a misbehaving test that keeps emitting entries
  // while flushing would otherwise hang here. 32 iterations is way
  // more than any sane test should need.
  for (let i = 0; i < 32; i++) {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    await flush();
    if (pending.length === 0 && !flushing) return;
    // Yield so an in-flight flush can settle the `flushing` flag.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
