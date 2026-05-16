import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { fixtureExercises } from './fixtures';
import { clearAuthStub } from './authStub';

// useExercises.ts kicks off loadExercises() at module load, which runs
// before any beforeEach hook. Install fetch stub at module load so the
// eager load picks up the fixture instead of hitting the network.
const fetchStub = vi.fn((url: RequestInfo | URL): Promise<Response> => {
  const href = typeof url === 'string' ? url : url.toString();
  if (href.endsWith('exercises.json')) {
    return Promise.resolve(
      new Response(JSON.stringify(fixtureExercises), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}) as unknown as typeof fetch;

vi.stubGlobal('fetch', fetchStub);

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  fetchStub.mockClear();
});

afterEach(() => {
  cleanup();
});

afterEach(() => { clearAuthStub(); });
