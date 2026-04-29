import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

export function useWikiMaintenance() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Counter so either operation keeping isPending=true keeps it set
  const pendingCount = useRef(0);

  const runLibrarian = useCallback(async (entityId: string) => {
    setError(null);
    pendingCount.current += 1;
    setIsPending(true);
    try {
      await wikiRef.current.runLibrarian(entityId);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      pendingCount.current -= 1;
      if (pendingCount.current === 0) setIsPending(false);
    }
  }, []);

  const runHeal = useCallback(async (entityId: string) => {
    setError(null);
    pendingCount.current += 1;
    setIsPending(true);
    try {
      await wikiRef.current.runHeal(entityId);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      pendingCount.current -= 1;
      if (pendingCount.current === 0) setIsPending(false);
    }
  }, []);

  return { runLibrarian, runHeal, isPending, error };
}
