import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

interface ForgetParams {
  entryId?: string;
  taskId?: string;
  sourceRef?: string;
  sourceHash?: string;
  clearAll?: boolean;
}

type ForgetResult = { deleted: { entries: number; tasks: number } };

export function useWikiForget() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<ForgetResult | null>(null);

  const execute = useCallback(async (entityId: string, params: ForgetParams): Promise<ForgetResult | undefined> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      const result = await wikiRef.current.forget(entityId, params);
      setLastResult(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return undefined;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, lastResult, isPending, error };
}
