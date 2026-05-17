import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { stubAuthenticatedUser } from '../test/authStub';

describe('Login', () => {
  it('submits email and shows confirmation', async () => {
    stubAuthenticatedUser({ id: 'unused' });  // just to set up the mocked client
    render(<Login />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument());
    expect(screen.getByText(/a@b\.com/)).toBeInTheDocument();
  });
});
