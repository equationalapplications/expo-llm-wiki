import { useState, useCallback, useRef } from 'react';
import { useWiki } from './WikiContext';
import type { ChunkFailure } from '@equationalapplications/core-llm-wiki';

interface IngestParams {
  sourceRef: string;
  sourceHash: string;
  documentChunk: string;
  maxChunkLength?: number;
  promptOverride?: string;
}

/**
 * Mirrors the widened `IngestDocumentResult` contract: `ingestDocument` no
 * longer throws when a SUBSET of chunks fails — it returns successfully with
 * `failedChunks > 0` and `parseFailures` describing each failed chunk.
 * Consumers of this hook should check `failedChunks`/`parseFailures` on the
 * resolved value; `error` remains reserved for total failure
 * (`WikiIngestEmptyError`) and systemic throws.
 */
type IngestResult = {
  truncated: boolean;
  chunks: number;
  ingestedChunks: number;
  failedChunks: number;
  duplicateOf?: string;
  parseFailures?: ChunkFailure[];
};

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
