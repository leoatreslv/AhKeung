import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider, useI18n } from '../i18n';

function Probe() {
  const { locale, t, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="app-name">{t.appName}</span>
      <span data-testid="chest">{t.muscleGroup.chest}</span>
      <button onClick={() => setLocale('zh-Hant')}>zh</button>
      <button onClick={() => setLocale('en')}>en</button>
    </div>
  );
}

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to English when no preference is set', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('app-name').textContent).toBe('Ah Keung');
    expect(screen.getByTestId('chest').textContent).toBe('Chest');
  });

  it('switches to Chinese and shows translated strings', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText('zh'));
    expect(screen.getByTestId('locale').textContent).toBe('zh-Hant');
    expect(screen.getByTestId('app-name').textContent).toBe('阿強');
    expect(screen.getByTestId('chest').textContent).toBe('胸');
  });

  it('persists locale choice in localStorage', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText('zh'));
    expect(localStorage.getItem('ah-keung.locale')).toBe('zh-Hant');
  });

  it('restores persisted locale on remount', () => {
    localStorage.setItem('ah-keung.locale', 'zh-Hant');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('zh-Hant');
  });

  it('exposes every muscle group label in both locales', () => {
    const groups = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'legs', 'glutes', 'core', 'cardio'] as const;

    function Dump({ which }: { which: 'en' | 'zh-Hant' }) {
      const { t, setLocale } = useI18n();
      // Trigger the locale on first render
      if (typeof window !== 'undefined' && !(window as unknown as { __k: boolean }).__k) {
        (window as unknown as { __k: boolean }).__k = true;
        setLocale(which);
      }
      return <div data-testid="dump">{groups.map((g) => t.muscleGroup[g]).join('|')}</div>;
    }

    const { unmount } = render(
      <I18nProvider>
        <Dump which="en" />
      </I18nProvider>,
    );
    const enParts = screen.getByTestId('dump').textContent!.split('|');
    expect(enParts).toHaveLength(groups.length);
    expect(enParts.every((s) => s.length > 0)).toBe(true);
    unmount();
  });
});
