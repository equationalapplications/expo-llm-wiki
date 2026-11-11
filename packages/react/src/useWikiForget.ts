import { useState, useCallback, useRef } from 'react';
import type { ForgetParams, ForgetResult } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

export function useWikiForget() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<ForgetResult | null>(null);

  const execute = useCallback(async (entityId: string, params: ForgetParams): Promise<ForgetResult> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      const result = await wikiRef.current.forget(entityId, params);
      setLastResult(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, lastResult, isPending, error };
}
