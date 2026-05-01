import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

export type MaintenanceResult =
  | { operation: 'librarian' | 'heal'; result: void }
  | { operation: 'prune'; result: { entries: number; tasks: number; events: number } };

export function useWikiMaintenance() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<MaintenanceResult | null>(null);
  // Counter so any overlapping maintenance operation keeps isPending=true until all complete
  const pendingCount = useRef(0);

  const runLibrarian = useCallback(async (entityId: string): Promise<void> => {
    setError(null);
    pendingCount.current += 1;
    setIsPending(true);
    setLastResult(null);
    try {
      await wikiRef.current.runLibrarian(entityId);
      setLastResult({ operation: 'librarian', result: undefined });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      pendingCount.current -= 1;
      if (pendingCount.current === 0) setIsPending(false);
    }
  }, []);

  const runHeal = useCallback(async (entityId: string): Promise<void> => {
    setError(null);
    pendingCount.current += 1;
    setIsPending(true);
    setLastResult(null);
    try {
      await wikiRef.current.runHeal(entityId);
      setLastResult({ operation: 'heal', result: undefined });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      pendingCount.current -= 1;
      if (pendingCount.current === 0) setIsPending(false);
    }
  }, []);

  const runPrune = useCallback(
    async (
      entityId: string,
      options?: {
        retainSoftDeletedFor?: number | null;
        retainEventsFor?: number | null;
        vacuum?: boolean;
      }
    ): Promise<{ entries: number; tasks: number; events: number }> => {
      setError(null);
      pendingCount.current += 1;
      setIsPending(true);
      setLastResult(null);
      try {
        const result = await wikiRef.current.runPrune(entityId, options);
        setLastResult({ operation: 'prune', result });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        pendingCount.current -= 1;
        if (pendingCount.current === 0) setIsPending(false);
      }
    },
    []
  );

  return { runLibrarian, runHeal, runPrune, lastResult, isPending, error };
}
