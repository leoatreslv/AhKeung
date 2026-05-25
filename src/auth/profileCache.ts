import type { Profile } from './useAuth';

/** Defaults the new `isAdmin` field when reading a cached profile written
 *  before the field existed (v1 cache shape). Used by AuthProvider's
 *  cache rehydration branch so an offline boot after the role-separation
 *  deploy doesn't surface `isAdmin: undefined`. */
export function rehydrateCachedProfile(parsed: Partial<Profile> & { id: string }): Profile {
  return {
    id: parsed.id,
    displayName: parsed.displayName ?? null,
    isTrainer: parsed.isTrainer ?? false,
    isAdmin: parsed.isAdmin ?? false,
  };
}
