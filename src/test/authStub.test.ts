import { describe, it, expect } from 'vitest';
import { stubAuthenticatedUser } from './authStub';

describe('stubAuthenticatedUser', () => {
  it('returns a fake with the given user already signed in', async () => {
    const fake = stubAuthenticatedUser({ id: 'u-1', isTrainer: true });
    const { data } = await fake.client.auth.getSession();
    expect(data.session?.user.id).toBe('u-1');
  });
});
