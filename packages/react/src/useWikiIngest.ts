import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';

interface IngestParams {
  sourceRef: string;
  sourceHash: string;
  documentChunk: string;
  maxChunkLength?: number;
  promptOverride?: string;
}

type IngestResult = { truncated: boolean; chunks: number };

export function useWikiIngest() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<IngestResult | null>(null);

  const execute = useCallback(async (entityId: string, params: IngestParams): Promise<IngestResult> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      const result = await wikiRef.current.ingestDocument(entityId, params);
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
