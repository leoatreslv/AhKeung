import { useAuth } from './useAuth';

/** Returns the current user's UUID, or null if not signed in. */
export function useCurrentUserId(): string | null {
  return useAuth().user?.id ?? null;
}
