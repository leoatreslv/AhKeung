import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RoleModeProvider, ROLE_MODE_STORAGE_KEY } from '../auth/RoleMode';
import { ModeGate } from './ModeGate';
import type { Profile } from '../auth/useAuth';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

function setup(p: Profile, initial: string) {
  return render(
    <RoleModeProvider profile={p}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/trainer" element={
            <ModeGate allowedIn={['trainer']}><div>TRAINER PAGE</div></ModeGate>
          } />
        </Routes>
      </MemoryRouter>
    </RoleModeProvider>
  );
}

describe('ModeGate', () => {
  beforeEach(() => localStorage.clear());

  it('renders children when current mode is allowed', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'trainer');
    setup(profile({ isTrainer: true }), '/trainer');
    expect(screen.getByText('TRAINER PAGE')).toBeInTheDocument();
  });

  it('auto-switches transiently when current mode wrong but allowedIn is available', async () => {
    setup(profile({ isTrainer: true }), '/trainer'); // mode defaults to trainee
    // findByText awaits the useEffect that flips mode and re-renders children.
    expect(await screen.findByText('TRAINER PAGE')).toBeInTheDocument();
    // Critical: must NOT have persisted the new mode.
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });

  it('redirects to / when no allowedIn mode is available', () => {
    setup(profile(), '/trainer'); // trainee-only
    expect(screen.getByText('HOME')).toBeInTheDocument();
    expect(screen.queryByText('TRAINER PAGE')).not.toBeInTheDocument();
  });
});
