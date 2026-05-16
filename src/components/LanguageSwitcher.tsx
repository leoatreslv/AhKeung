import { useI18n, LOCALES } from '../i18n';

export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
      aria-label="Language"
      className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-md px-2 py-1"
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
