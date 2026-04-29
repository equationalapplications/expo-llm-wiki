import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

interface ForgetParams {
  entryId?: string;
  taskId?: string;
  sourceRef?: string;
  clearAll?: boolean;
}

export function useWikiForget() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async (entityId: string, params: ForgetParams) => {
    setError(null);
    setIsPending(true);
    try {
      await wikiRef.current.forget(entityId, params);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, isPending, error };
}
