import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';
import type { MemoryDump } from '@equationalapplications/core-llm-wiki';

export function useWikiExport() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<MemoryDump | null>(null);

  const execute = useCallback(async (entityIds?: string[]): Promise<MemoryDump> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      const result = await wikiRef.current.exportDump(entityIds);
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
