import { useState, useEffect, useCallback, useRef } from 'react';
import type { MemoryBundle } from '@eq/wiki-core';
import { useWiki } from './WikiContext';

export function useMemoryRead(entityId: string, query: string) {
  const wiki = useWiki();
  const [data, setData] = useState<MemoryBundle | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const fetchQueue = useRef<{
    inFlight: boolean;
    pending: { entityId: string; query: string } | null;
  }>({ inFlight: false, pending: null });

  // Stable scheduler: refs keep it from going stale across renders.
  // In-flight results are never discarded — spec requires them to land before
  // starting the next fetch with latest args.
  const scheduleFetch = useRef(function schedule(eid: string, q: string) {
    const fq = fetchQueue.current;
    if (fq.inFlight) {
      fq.pending = { entityId: eid, query: q };
      return;
    }
    fq.inFlight = true;
    setIsPending(true);

    wikiRef.current.read(eid, q).then(
      (result) => { setData(result); setError(null); },
      (e: unknown) => { setError(e instanceof Error ? e : new Error(String(e))); }
    ).finally(() => {
      fq.inFlight = false;
      const next = fq.pending;
      fq.pending = null;
      if (next) {
        scheduleFetch.current(next.entityId, next.query);
      } else {
        setIsPending(false);
      }
    });
  });

  useEffect(() => {
    scheduleFetch.current(entityId, query);
  }, [entityId, query, wiki]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityId, query);
  }, [entityId, query]);

  return { data, isPending, error, refetch };
}
