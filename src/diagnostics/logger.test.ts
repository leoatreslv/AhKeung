import { describe, it, expect, beforeEach, vi } from 'vitest';
import Dexie from 'dexie';
import { log, recentLog, clearLog, maskEmail, onLog, __flushForTest } from './logger';
import { CATEGORY } from './categories';

// fake-indexeddb is auto-installed via src/test/setup.ts so the
// ah-keung-diagnostics database is created on a fresh IndexedDB
// for each test. We don't have to swap the Dexie instance.

beforeEach(async () => {
  await Dexie.delete('ah-keung-diagnostics');
  await clearLog();   // also clears the in-memory queue
});

describe('logger', () => {
  it('records info entries into the buffer', async () => {
    log.info(CATEGORY.sync, 'pulled page', { table: 'plans', rows: 3 });
    await __flushForTest();
    const entries = await recentLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'sync',
      message: 'pulled page',
      context: { table: 'plans', rows: 3 },
    });
  });

  it('captures + truncates errorStack when an Error is passed', async () => {
    // Synthesise a long stack the truncation cap will actually clip.
    const err = new Error('boom');
    err.stack = 'Error: boom\n' + Array.from(
      { length: 30 },
      (_, i) => `    at frame${i} (file:${i}:1)`,
    ).join('\n');
    log.error(CATEGORY.sync, 'tick failed', err);
    await __flushForTest();
    const [entry] = await recentLog();
    expect(entry.errorStack).toBeDefined();
    // Top 10 frames + first line = 11 lines max.
    const lines = entry.errorStack!.split('\n');
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines[0]).toMatch(/^Error: boom/);
    // 2 KB cap.
    expect(entry.errorStack!.length).toBeLessThanOrEqual(2048);
  });

  it('returns entries newest-first', async () => {
    log.info(CATEGORY.sync, 'a');
    log.info(CATEGORY.sync, 'b');
    log.info(CATEGORY.sync, 'c');
    await __flushForTest();
    const entries = await recentLog();
    expect(entries.map((e) => e.message)).toEqual(['c', 'b', 'a']);
  });

  it('trims the buffer to at most 500 entries on flush', async () => {
    // Emit 550 entries; should leave 500 after prune.
    for (let i = 0; i < 550; i++) log.info(CATEGORY.sync, `m${i}`);
    await __flushForTest();
    const entries = await recentLog();
    expect(entries).toHaveLength(500);
    // Oldest survivors are m50…m549 (m0..m49 pruned).
    expect(entries[entries.length - 1].message).toBe('m50');
    expect(entries[0].message).toBe('m549');
  });

  it('clearLog drains the in-memory queue + persisted rows', async () => {
    log.info(CATEGORY.sync, 'first');
    log.info(CATEGORY.sync, 'second');
    await clearLog();
    const entries = await recentLog();
    expect(entries).toHaveLength(0);
  });

  it('onLog taps every emit and unsubscribe stops them', async () => {
    const seen: string[] = [];
    const unsub = onLog((e) => seen.push(e.message));
    log.info(CATEGORY.sync, 'one');
    log.warn(CATEGORY.sync, 'two');
    unsub();
    log.info(CATEGORY.sync, 'three');
    expect(seen).toEqual(['one', 'two']);
  });
});

describe('maskEmail', () => {
  it('keeps the first character and replaces the rest of the local-part with asterisks', () => {
    expect(maskEmail('leo@reslv.io')).toBe('l**@reslv.io');
    expect(maskEmail('a@b.com')).toBe('a*@b.com');
    expect(maskEmail('something@example.org')).toBe('s********@example.org');
  });

  it('leaves non-email strings alone', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
    expect(maskEmail('')).toBe('');
  });
});

describe('logger does not crash a tap that throws', () => {
  it('continues emitting even if a tap throws', async () => {
    const unsub = onLog(() => { throw new Error('tap exploded'); });
    // Should not throw despite the tap.
    expect(() => log.info(CATEGORY.sync, 'still works')).not.toThrow();
    await __flushForTest();
    const entries = await recentLog();
    expect(entries[0].message).toBe('still works');
    unsub();
  });
});

describe('error level captures non-Error contexts as objects', () => {
  it('stores plain object context as-is', async () => {
    log.error(CATEGORY.sync, 'failed with code', { code: 23505, table: 'plans' });
    await __flushForTest();
    const [entry] = await recentLog();
    expect(entry.context).toEqual({ code: 23505, table: 'plans' });
    expect(entry.errorStack).toBeUndefined();
  });

  it('stores string non-Error context under value key', async () => {
    log.error(CATEGORY.sync, 'failed', 'some string');
    await __flushForTest();
    const [entry] = await recentLog();
    expect(entry.context).toEqual({ value: 'some string' });
  });
});

// Sanity check: the install module is importable and idempotent.
describe('install', () => {
  it('installs window handlers once', async () => {
    const { installDiagnostics } = await import('./install');
    const spy = vi.spyOn(window, 'addEventListener');
    installDiagnostics();
    const firstCallCount = spy.mock.calls.length;
    installDiagnostics();  // second call — should be a no-op
    expect(spy.mock.calls.length).toBe(firstCallCount);
    spy.mockRestore();
  });
});
