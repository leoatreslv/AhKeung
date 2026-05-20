import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Login } from './Login';
import { I18nProvider } from '../i18n';
import { stubAuthenticatedUser } from '../test/authStub';

function renderLogin() {
  return render(
    <I18nProvider>
      <Login />
    </I18nProvider>,
  );
}

describe('Login', () => {
  it('renders password sign-in by default', () => {
    stubAuthenticatedUser({ id: 'unused' });
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('switches to forgot-password and back', () => {
    stubAuthenticatedUser({ id: 'unused' });
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
    // Password input is hidden in the forgot-password view.
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });
});
