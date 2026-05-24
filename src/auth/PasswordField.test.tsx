import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PasswordField } from './PasswordField';
import { I18nProvider } from '../i18n';

function renderField(value = '') {
  const onChange = vi.fn();
  const utils = render(
    <I18nProvider>
      <form onSubmit={(e) => e.preventDefault()}>
        <PasswordField
          value={value}
          onChange={onChange}
          label="Password"
          ariaLabel="password"
        />
        <button type="submit">submit</button>
      </form>
    </I18nProvider>,
  );
  return { ...utils, onChange };
}

describe('PasswordField', () => {
  it('renders the input with type=password by default', () => {
    renderField();
    const input = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('toggling the button flips the input type without swapping nodes', () => {
    renderField();
    const input = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: /show/i });
    fireEvent.click(toggle);
    // Same input node, type changed → password managers stay bound.
    expect(input.type).toBe('text');
    const toggleHide = screen.getByRole('button', { name: /hide/i });
    fireEvent.click(toggleHide);
    expect(input.type).toBe('password');
  });

  it('toggle button is type="button" and does not submit the enclosing form', () => {
    const { container } = renderField();
    const form = container.querySelector('form')!;
    const submitSpy = vi.fn();
    form.addEventListener('submit', submitSpy);
    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('toggle button aria-label does NOT contain the bare word "password"', () => {
    // Prevents getByRole({name:/password/i}) collisions in tests
    // elsewhere — e.g. Login.test.tsx looks up the input via
    // getByLabelText(/^password$/i); we don't want the toggle to
    // also be matched.
    renderField();
    const toggle = screen.getByRole('button', { name: /show/i });
    expect(toggle.getAttribute('aria-label') ?? '').not.toMatch(/password/i);
  });

  it('calls onChange when the user types', () => {
    const { onChange } = renderField('abc');
    const input = screen.getByLabelText(/^password$/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abcd' } });
    expect(onChange).toHaveBeenCalledWith('abcd');
  });
});
