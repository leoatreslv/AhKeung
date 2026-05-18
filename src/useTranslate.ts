import { useState, useCallback } from 'react';
import { getSupabase } from './supabase';

export type TranslateLang = 'en' | 'zh-TW';

interface TranslateResult {
  translatedText: string;
}

/** Calls the `translate-name` Edge Function. Returns a stable callback and
 *  loading/error state for binding into a translate button. */
export function useTranslate(): {
  translate: (q: string, source: TranslateLang, target: TranslateLang) => Promise<string | null>;
  loading: boolean;
  error: string | null;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translate = useCallback(async (
    q: string, source: TranslateLang, target: TranslateLang,
  ): Promise<string | null> => {
    if (!q.trim()) return null;
    setLoading(true);
    setError(null);
    try {
      const res = await getSupabase().functions.invoke<TranslateResult>('translate-name', {
        body: { q: q.trim(), source, target },
      });
      if (res.error) {
        setError(res.error.message ?? 'translate failed');
        return null;
      }
      const text = res.data?.translatedText;
      if (!text) {
        setError('no translation returned');
        return null;
      }
      return text;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { translate, loading, error };
}
