import { useState, type ChangeEvent } from 'react';
import { useI18n } from '../i18n';

interface Props {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Used for the input's aria-label so tests can find it via
   *  getByLabelText. Defaults to `label` if not given. */
  ariaLabel?: string;
  autoComplete?: string;
  required?: boolean;
}

/** Password input + a small "Show / Hide" toggle button. Internal
 *  reveal state lives in this component, so each PasswordField is
 *  independently toggled.
 *
 *  Implementation notes:
 *  - `type` is mutated on the same `<input>` (not swapped between
 *    two nodes) so password managers don't lose their bound field.
 *  - The toggle button uses `type="button"` so it never submits the
 *    enclosing form.
 *  - `onMouseDown(preventDefault)` on the toggle: prevents the
 *    button from stealing focus from the input (and prevents the
 *    parent <label>'s default-action from re-focusing the input
 *    twice in some browsers, notably Safari).
 *  - aria-label uses "Reveal" / "Hide" — deliberately no bare
 *    "password" word so getByRole({name:/password/}) test queries
 *    don't accidentally match the toggle button. */
export function PasswordField({
  value, onChange, label, ariaLabel, autoComplete, required,
}: Props) {
  const { t } = useI18n();
  const [reveal, setReveal] = useState(false);
  return (
    <label className="block mb-2">
      <span className="block text-sm mb-1">{label}</span>
      <div className="relative">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          aria-label={ariaLabel ?? label}
          autoComplete={autoComplete}
          required={required}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 pr-16"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? t.login.hidePassword : t.login.showPassword}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-200 px-2 py-1"
        >{reveal ? t.login.hidePassword : t.login.showPassword}</button>
      </div>
    </label>
  );
}
