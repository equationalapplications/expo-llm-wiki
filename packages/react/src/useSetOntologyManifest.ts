import { useState, useCallback, useRef } from 'react';
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

/**
 * Mutation hook for seeding or replacing an entity's ontology manifest.
 * Mirrors the `{ execute, isPending, error, lastResult }` contract of {@link useWikiWrite}.
 * Does not auto-refresh {@link useOntologyManifest} — call `refetch()` after a successful `execute()`.
 */
export function useSetOntologyManifest() {
  const wiki = useWiki();
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<void | null>(null);

  const execute = useCallback(async (
    entityId: string,
    manifest: OntologyManifest,
    options?: { mode?: OntologyMode },
  ): Promise<void> => {
    setError(null);
    setIsPending(true);
    setLastResult(null);
    try {
      await wikiRef.current.setOntologyManifest(entityId, manifest, options);
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
