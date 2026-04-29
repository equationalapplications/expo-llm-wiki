import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

interface IngestParams {
  sourceRef: string;
  sourceHash: string;
  documentChunk: string;
}

export function useWikiIngest() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async (entityId: string, params: IngestParams) => {
    setError(null);
    setIsPending(true);
    try {
      await wikiRef.current.ingestDocument(entityId, params);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsPending(false);
    }
  }, []);

  return { execute, isPending, error };
}
