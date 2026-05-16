import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './en';
import { zhHant } from './zh-Hant';
import type { Locale, Translation } from './types';

export { LOCALES } from './types';
export type { Locale } from './types';

const translations: Record<Locale, Translation> = {
  'en': en,
  'zh-Hant': zhHant,
};

const STORAGE_KEY = 'ah-keung.locale';

const detectInitial = (): Locale => {
  if (typeof window === 'undefined') return 'en';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh-Hant') return saved;
  const nav = navigator.language || '';
  if (nav.toLowerCase().startsWith('zh')) return 'zh-Hant';
  return 'en';
};

interface I18nContextValue {
  locale: Locale;
  t: Translation;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh-Hant' ? 'zh-Hant' : 'en';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLocaleState(l);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: translations[locale], setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useT = () => useI18n().t;
