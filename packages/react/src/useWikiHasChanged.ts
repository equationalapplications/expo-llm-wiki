import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

export function useWikiHasChanged() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<boolean | null>(null);

  const execute = useCallback(
    async (entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> => {
      setError(null);
      setIsPending(true);
      setLastResult(null);
      try {
        const result = await wikiRef.current.hasChanged(entityId, sourceRef, sourceHash);
        setLastResult(result);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    []
  );

  return { execute, lastResult, isPending, error };
}
