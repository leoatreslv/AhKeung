import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { RoleModeProvider, useRoleMode, ROLE_MODE_STORAGE_KEY } from './RoleMode';
import type { Profile } from './useAuth';

function Probe() {
  const ctx = useRoleMode();
  return (
    <div>
      <span data-testid="mode">{ctx.mode}</span>
      <span data-testid="available">{ctx.availableModes.join(',')}</span>
      <button onClick={() => ctx.setMode('trainer')}>setMode trainer</button>
      <button onClick={() => ctx.setModeTransient('admin')}>transient admin</button>
    </div>
  );
}

function withProvider(profile: Profile) {
  return render(<RoleModeProvider profile={profile}><Probe /></RoleModeProvider>);
}

const PROFILE = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

describe('RoleModeProvider', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to trainee when no localStorage entry', () => {
    withProvider(PROFILE({ isTrainer: true }));
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
  });

  it('honors a valid stored mode', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'trainer');
    withProvider(PROFILE({ isTrainer: true }));
    expect(screen.getByTestId('mode').textContent).toBe('trainer');
  });

  it('falls back to trainee when stored mode is not in availableModes', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'admin');
    withProvider(PROFILE({ isTrainer: true })); // no isAdmin
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
  });

  it('availableModes derives correctly from flags', () => {
    withProvider(PROFILE({ isTrainer: true, isAdmin: true }));
    expect(screen.getByTestId('available').textContent).toBe('trainee,trainer,admin');
  });

  it('setMode writes localStorage', () => {
    withProvider(PROFILE({ isTrainer: true }));
    act(() => { screen.getByText('setMode trainer').click(); });
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBe('trainer');
  });

  it('setModeTransient does NOT write localStorage', () => {
    withProvider(PROFILE({ isAdmin: true }));
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
    act(() => { screen.getByText('transient admin').click(); });
    expect(screen.getByTestId('mode').textContent).toBe('admin');
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });

  it('reactively resets to trainee when availableModes shrinks below the active mode', () => {
    localStorage.setItem(ROLE_MODE_STORAGE_KEY, 'admin');
    const profileWithAdmin = PROFILE({ isAdmin: true });
    const { rerender } = render(<RoleModeProvider profile={profileWithAdmin}><Probe /></RoleModeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('admin');
    // Simulate demotion mid-session.
    rerender(<RoleModeProvider profile={PROFILE()}><Probe /></RoleModeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('trainee');
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBeNull();
  });
});
