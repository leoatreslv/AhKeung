import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { designateInvitedUser } from '../invitations';
import { stubAuthenticatedUser } from './authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

describe('designateInvitedUser', () => {
  it('calls the designate_invited_user RPC with the invitation id and returns the trainee id', async () => {
    const fake = stubAuthenticatedUser({ id: 'trainer-1', isTrainer: true });
    // Stub the rpc on the fake client to return a trainee uuid like
    // the real RPC would.
    fake.client.rpc = (async (name: string, args?: Record<string, unknown>) => {
      expect(name).toBe('designate_invited_user');
      expect(args).toEqual({ invitation_id: 'inv-1' });
      return { data: 'trainee-1', error: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const traineeId = await designateInvitedUser('inv-1');
    expect(traineeId).toBe('trainee-1');
  });

  it('throws with the server error message when the RPC fails', async () => {
    const fake = stubAuthenticatedUser({ id: 'trainer-1', isTrainer: true });
    fake.client.rpc = (async () => {
      return { data: null, error: { message: 'invitation not yet accepted' } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    await expect(designateInvitedUser('inv-1')).rejects.toThrow('invitation not yet accepted');
  });

  it('throws when the RPC returns no data', async () => {
    const fake = stubAuthenticatedUser({ id: 'trainer-1', isTrainer: true });
    fake.client.rpc = (async () => {
      return { data: null, error: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    await expect(designateInvitedUser('inv-1')).rejects.toThrow('no id');
  });

  it('swallows the response if rpc throws synchronously', async () => {
    // Defensive: even if the supabase-js client tosses an exception
    // (instead of returning {error}), the function should surface it.
    const fake = stubAuthenticatedUser({ id: 'trainer-1', isTrainer: true });
    const thrower = vi.fn(() => { throw new Error('boom'); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.client.rpc = thrower as any;

    await expect(designateInvitedUser('inv-1')).rejects.toThrow('boom');
    expect(thrower).toHaveBeenCalledOnce();
  });
});
