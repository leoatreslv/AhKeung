import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetApp } from './resetApp';
import { db } from './db';

// db.delete + db.open are mocked per-test so we don't actually nuke
// the fake-indexeddb between assertions. The other browser globals
// (caches, serviceWorker, location) are injected via the deps arg
// so we don't have to monkey-patch window.

beforeEach(async () => {
  // Reset the real Dexie between tests so the import is fresh.
  await db.delete();
  await db.open();
});

function makeLocalStorage(seed: Record<string, string>): Storage {
  const data: Record<string, string> = { ...seed };
  return {
    get length() { return Object.keys(data).length; },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
  };
}

describe('resetApp', () => {
  it('clears sb-*-auth-token and ahKeung.lastKnownProfile but keeps locale', async () => {
    const ls = makeLocalStorage({
      'sb-abc-auth-token': 'session-1',
      'sb-xyz-auth-token': 'session-2',
      'ahKeung.lastKnownProfile': '{"id":"u-1"}',
      'ah-keung.locale': 'zh-Hant',
      'unrelated-key': 'keep me',
    });
    await resetApp({ localStorage: ls, caches: undefined, serviceWorker: undefined, location: { replace: () => {} } });
    expect(ls.getItem('sb-abc-auth-token')).toBeNull();
    expect(ls.getItem('sb-xyz-auth-token')).toBeNull();
    expect(ls.getItem('ahKeung.lastKnownProfile')).toBeNull();
    // Locale preserved across resets.
    expect(ls.getItem('ah-keung.locale')).toBe('zh-Hant');
    // Unrelated keys also preserved — we're surgical, not nuclear.
    expect(ls.getItem('unrelated-key')).toBe('keep me');
  });

  it('iterates Cache Storage and deletes every named cache', async () => {
    const deleted: string[] = [];
    const fakeCaches = {
      keys: async () => ['workbox-precache-v2', 'exercise-images', 'other'],
      delete: async (name: string) => { deleted.push(name); return true; },
    } as unknown as CacheStorage;
    await resetApp({ localStorage: makeLocalStorage({}), caches: fakeCaches, serviceWorker: undefined, location: { replace: () => {} } });
    expect(deleted.sort()).toEqual(['exercise-images', 'other', 'workbox-precache-v2']);
  });

  it('unregisters every service worker registration', async () => {
    const unregisterCalls: number[] = [];
    const reg = (id: number) => ({
      unregister: async () => { unregisterCalls.push(id); return true; },
    });
    const fakeSW = {
      getRegistrations: async () => [reg(1), reg(2), reg(3)],
    } as unknown as ServiceWorkerContainer;
    await resetApp({ localStorage: makeLocalStorage({}), caches: undefined, serviceWorker: fakeSW, location: { replace: () => {} } });
    expect(unregisterCalls.sort()).toEqual([1, 2, 3]);
  });

  it('calls location.replace("/") last for a hard reload', async () => {
    const replaces: string[] = [];
    await resetApp({
      localStorage: makeLocalStorage({}),
      caches: undefined,
      serviceWorker: undefined,
      location: { replace: (url) => { replaces.push(url); } },
    });
    expect(replaces).toEqual(['/']);
  });

  it('tolerates a caches.delete failure and still reloads', async () => {
    const replaces: string[] = [];
    const fakeCaches = {
      keys: async () => ['bad'],
      delete: async () => { throw new Error('quota'); },
    } as unknown as CacheStorage;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resetApp({
      localStorage: makeLocalStorage({}),
      caches: fakeCaches,
      serviceWorker: undefined,
      location: { replace: (url) => { replaces.push(url); } },
    });
    expect(replaces).toEqual(['/']);  // reload still happened
    warn.mockRestore();
  });

  it('tolerates a serviceWorker.unregister failure and still reloads', async () => {
    const replaces: string[] = [];
    const fakeSW = {
      getRegistrations: async () => [{ unregister: async () => { throw new Error('nope'); } }],
    } as unknown as ServiceWorkerContainer;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resetApp({
      localStorage: makeLocalStorage({}),
      caches: undefined,
      serviceWorker: fakeSW,
      location: { replace: (url) => { replaces.push(url); } },
    });
    expect(replaces).toEqual(['/']);
    warn.mockRestore();
  });
});
