import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { stubUnauthenticated, clearAuthStub } from '../test/authStub';

function Probe() {
  const { status } = useAuth();
  return <span data-testid="status">{status}</span>;
}

function renderWithAuth() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </I18nProvider>,
  );
}

// Reset URL + tear down stubs between tests so URL state doesn't leak.
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  clearAuthStub();
  vi.useRealTimers();
});

describe('AuthProvider — invite/recovery URL bootstrap', () => {
  it('verifyOtp timeout (10s) falls through to unauthenticated', async () => {
    vi.useFakeTimers();
    const fake = stubUnauthenticated();
    // Pin verifyOtp to a never-resolving promise so only the timeout
    // resolves the Promise.race. Models the real-world hang (slow
    // server, headless scanner mid-request) that PR 6a fixes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.client.auth as any).verifyOtp = () => new Promise(() => {});

    window.history.replaceState({}, '', '/?type=invite&token_hash=fake-token');

    renderWithAuth();
    expect(screen.getByTestId('status').textContent).toBe('loading');

    // Fast-forward past the 10s verifyOtp timeout. The IIFE's catch
    // converts the timeout-throw to a null return; the IIFE then
    // calls getSession (returns null) and flips to 'unauthenticated'.
    await vi.advanceTimersByTimeAsync(10_500);

    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });

  it('strips token_hash + type from the URL on timeout (so refresh does not retry)', async () => {
    vi.useFakeTimers();
    const fake = stubUnauthenticated();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.client.auth as any).verifyOtp = () => new Promise(() => {});

    window.history.replaceState({}, '', '/?type=invite&token_hash=fake-token&keep=me');

    renderWithAuth();
    await vi.advanceTimersByTimeAsync(10_500);

    const url = new URL(window.location.href);
    expect(url.searchParams.has('token_hash')).toBe(false);
    expect(url.searchParams.has('type')).toBe(false);
    // Unrelated params survive — we only strip the two auth ones.
    expect(url.searchParams.get('keep')).toBe('me');
  });

  it('verifyOtp returning an error falls through to unauthenticated immediately', async () => {
    const fake = stubUnauthenticated();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.client.auth as any).verifyOtp = async () =>
      ({ data: {}, error: { message: 'token expired' } });

    window.history.replaceState({}, '', '/?type=invite&token_hash=fake-token');

    renderWithAuth();
    // Flush microtasks — no fake timers, no 10s wait, no setTimeout.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });

  it('getSession timeout (10s) falls through to unauthenticated', async () => {
    vi.useFakeTimers();
    const fake = stubUnauthenticated();
    // No URL params — skip consumeAuthLink, go straight to getSession.
    // Pin getSession to never resolve so only the timeout fires.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.client.auth as any).getSession = () => new Promise(() => {});

    renderWithAuth();
    expect(screen.getByTestId('status').textContent).toBe('loading');

    // Wrap in act() — React's state flush after the timeout-throw
    // needs the test runner to know an update is in flight before
    // the assertion reads the DOM.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });

    // The IIFE's try/catch converts the timeout-throw to the
    // unauthenticated state, so the user lands on Login instead of
    // staying on Loading.
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });
});
