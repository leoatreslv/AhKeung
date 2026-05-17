import { createContext, useContext } from 'react';

export interface Profile { id: string; displayName: string | null; isTrainer: boolean; }
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

export interface AuthState {
  status: AuthStatus;
  user: { id: string; email: string } | null;
  profile: Profile | null;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
