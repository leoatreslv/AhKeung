import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeSupabase } from './fakeSupabase';

describe('fakeSupabase', () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => { fake = createFakeSupabase(); });

  it('starts with no session', async () => {
    const { data } = await fake.client.auth.getSession();
    expect(data.session).toBeNull();
  });

  it('signInWithOtp + manual deliver triggers SIGNED_IN', async () => {
    const events: string[] = [];
    fake.client.auth.onAuthStateChange((e) => { events.push(e); });
    await fake.client.auth.signInWithOtp({ email: 'a@b.com' });
    fake.deliverMagicLink('a@b.com', 'u-1');
    expect(events).toContain('SIGNED_IN');
    const { data } = await fake.client.auth.getSession();
    expect(data.session?.user.id).toBe('u-1');
  });

  it('insert/select round-trip with user_id filter', async () => {
    fake.deliverMagicLink('a@b.com', 'u-1');
    await fake.client.from('plans').insert({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: ['chest'], exercises: [],
    });
    const { data } = await fake.client.from('plans').select('*').eq('user_id', 'u-1');
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe('p1');
  });

  it('conditional update returns empty when WHERE does not match', async () => {
    fake.deliverMagicLink('a@b.com', 'u-1');
    await fake.client.from('plans').insert({
      id: 'p1', user_id: 'u-1', name: 'A', week_start: '2025-03-10',
      focus: [], exercises: [],
    });
    // First update — succeeds
    const first = await fake.client.from('plans').update({ name: 'B' })
      .eq('id', 'p1').eq('updated_at', fake.rowOf('plans', 'p1').updated_at)
      .select();
    expect(first.data).toHaveLength(1);
    // Second update with stale expected — empty result
    const stale = await fake.client.from('plans').update({ name: 'C' })
      .eq('id', 'p1').eq('updated_at', 'stale-iso').select();
    expect(stale.data).toEqual([]);
  });

  it('network failure toggle causes throws', async () => {
    fake.setNetworkUp(false);
    await expect(fake.client.from('plans').select('*')).rejects.toThrow(/network/i);
  });
});
