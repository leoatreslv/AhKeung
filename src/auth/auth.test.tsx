import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { db } from '../db';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { stubAuthenticatedUser, getActiveFake } from '../test/authStub';

beforeEach(async () => { await db.delete(); await db.open(); });

function Probe() {
  const { status, profile } = useAuth();
  return <div>status={status} name={profile?.displayName ?? 'null'} trainer={String(profile?.isTrainer ?? false)}</div>;
}

describe('AuthProvider', () => {
  it('reports loading then authenticated when a session exists', async () => {
    stubAuthenticatedUser({ id: 'u-1', isTrainer: true });
    getActiveFake().tables.profiles[0].display_name = 'Leo';

    render(<AuthProvider><Probe /></AuthProvider>);

    expect(screen.getByText(/status=loading/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/status=authenticated/)).toBeInTheDocument());
    expect(screen.getByText(/name=Leo/)).toBeInTheDocument();
    expect(screen.getByText(/trainer=true/)).toBeInTheDocument();
  });

  it('reports unauthenticated when no session', async () => {
    const { stubUnauthenticated } = await import('../test/authStub');
    stubUnauthenticated();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText(/status=unauthenticated/)).toBeInTheDocument());
  });
});
