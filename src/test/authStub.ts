// src/test/authStub.ts
import { setSupabase } from '../supabase';
import { createFakeSupabase, type FakeSupabase } from './fakeSupabase';

let activeFake: FakeSupabase | null = null;

export function stubAuthenticatedUser(opts: {
  id: string; email?: string; isTrainer?: boolean; isAdmin?: boolean;
} = { id: 'u-test' }): FakeSupabase {
  const fake = createFakeSupabase();
  fake.deliverMagicLink(opts.email ?? 'test@example.com', opts.id);
  if (opts.isTrainer) fake.setTrainer(opts.id, true);
  if (opts.isAdmin)   fake.setAdmin(opts.id, true);
  activeFake = fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSupabase(fake.client as any);
  return fake;
}

export function stubUnauthenticated(): FakeSupabase {
  const fake = createFakeSupabase();
  activeFake = fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSupabase(fake.client as any);
  return fake;
}

export function getActiveFake(): FakeSupabase {
  if (!activeFake) throw new Error('stubAuthenticatedUser/stubUnauthenticated not called');
  return activeFake;
}

export function clearAuthStub() {
  activeFake = null;
  setSupabase(null);
}
