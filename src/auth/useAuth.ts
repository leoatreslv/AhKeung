import { createContext, useContext } from 'react';

export interface Profile { id: string; displayName: string | null; isTrainer: boolean; }
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: { id: string; email: string } | null;
  profile: Profile | null;
  /** Non-null when the most recent profile fetch failed (network etc.).
   *  Lets the gate distinguish "first-time user (profile fetched, empty
   *  display_name)" from "fetch failed (don't auto-route to onboarding)". */
  profileFetchError: string | null;
  /** True when the user signed in via a ?type=recovery link. Gate routes
   *  to the reset-password screen until the user picks a new password. */
  needsPasswordReset: boolean;
  signOut: () => Promise<void>;
  /** Re-fetches the profile and (on success) clears any
   *  profileFetchError. Used by the onboarding flow after writing
   *  display_name, and by retry buttons on the error state. */
  refreshProfile: () => Promise<void>;
  /** Clears needsPasswordReset (called after a successful password
   *  reset to drop the gate). */
  clearPasswordReset: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
