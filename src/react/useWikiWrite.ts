import { useState, useCallback, useRef } from 'react';
import type { WikiEvent } from '../types';
import { useWiki } from './WikiContext';

type WriteEvent = Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>;

export function useWikiWrite() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<void | null>(null);

  const execute = useCallback(async (entityId: string, event: WriteEvent): Promise<void> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      await wikiRef.current.write(entityId, event);
      setLastResult(undefined);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      setError(error);
      throw error;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, lastResult, isPending, error };
}
