import { describe, it, expect } from 'vitest';
import { rehydrateCachedProfile } from './profileCache';

describe('rehydrateCachedProfile', () => {
  it('defaults isAdmin to false when missing (v1 cache shape)', () => {
    const result = rehydrateCachedProfile({ id: 'u', displayName: 'P', isTrainer: true });
    expect(result.isAdmin).toBe(false);
    expect(result.isTrainer).toBe(true);
    expect(result.displayName).toBe('P');
  });

  it('preserves all fields when present (v2 cache shape)', () => {
    const result = rehydrateCachedProfile({
      id: 'u', displayName: 'P', isTrainer: false, isAdmin: true,
    });
    expect(result.isAdmin).toBe(true);
    expect(result.displayName).toBe('P');
  });

  it('defaults displayName to null and the flags to false when missing', () => {
    const result = rehydrateCachedProfile({ id: 'u' });
    expect(result.displayName).toBeNull();
    expect(result.isTrainer).toBe(false);
    expect(result.isAdmin).toBe(false);
  });
});
