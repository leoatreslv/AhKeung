import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RoleModeProvider, ROLE_MODE_STORAGE_KEY } from '../auth/RoleMode';
import { I18nProvider } from '../i18n';
import { ModeSwitcher } from './ModeSwitcher';
import type { Profile } from '../auth/useAuth';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'u', displayName: 'P', isTrainer: false, isAdmin: false, ...over,
});

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function setup(p: Profile) {
  return render(
    <I18nProvider>
      <RoleModeProvider profile={p}>
        <MemoryRouter initialEntries={['/']}>
          <ModeSwitcher />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </RoleModeProvider>
    </I18nProvider>
  );
}

describe('ModeSwitcher', () => {
  beforeEach(() => localStorage.clear());

  it('renders nothing when user has only one role', () => {
    const { container } = setup(profile());
    expect(container.querySelector('[data-testid="mode-switcher"]')).toBeNull();
  });

  it('renders pills for each available mode when multi-role', () => {
    setup(profile({ isTrainer: true, isAdmin: true }));
    expect(screen.getByRole('button', { name: /Trainee/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Trainer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Admin/ })).toBeInTheDocument();
  });

  it('tapping a pill calls setMode (persists) AND navigates to that mode default route', () => {
    setup(profile({ isTrainer: true }));
    act(() => { screen.getByRole('button', { name: /Trainer/ }).click(); });
    expect(localStorage.getItem(ROLE_MODE_STORAGE_KEY)).toBe('trainer');
    expect(screen.getByTestId('path').textContent).toBe('/trainer');
  });
});
