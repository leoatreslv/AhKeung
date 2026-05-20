import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  it('submits email via magic link and shows confirmation', async () => {
    stubAuthenticatedUser({ id: 'unused' });  // just to set up the mocked client
    renderLogin();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }));
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument());
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument();
  });

  it('switches to password tab and renders a password input', () => {
    stubAuthenticatedUser({ id: 'unused' });
    renderLogin();
    fireEvent.click(screen.getByRole('tab', { name: /^password$/i }));
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('switches to forgot-password and back', () => {
    stubAuthenticatedUser({ id: 'unused' });
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(screen.getByRole('button', { name: /send sign-in link/i })).toBeInTheDocument();
  });
});
