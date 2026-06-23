import { useState, useEffect, useCallback, useRef } from 'react';
import type { OntologyManifest, OntologyMode } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

/**
 * Reactive state returned by {@link useOntologyManifest}.
 */
export interface OntologyManifestState {
  /** Resolved manifest, or `null` when `getOntologyManifest` returns `null`. */
  manifest: OntologyManifest | null;
  /** Resolved mode, or `null` when no manifest row/seed applies. */
  mode: OntologyMode | null;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Reactive read hook for an entity's ontology manifest and mode.
 * Fetches on mount and whenever `entityId` or `wiki` changes.
 * Call `refetch()` after mutations (e.g. {@link useSetOntologyManifest}) to refresh.
 */
export function useOntologyManifest(entityId: string): OntologyManifestState {
  const wiki = useWiki();
  const [manifest, setManifest] = useState<OntologyManifest | null>(null);
  const [mode, setMode] = useState<OntologyMode | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const entityIdRef = useRef(entityId);
  entityIdRef.current = entityId;

  const fetchQueue = useRef<{
    inFlight: boolean;
    pending: string | null;
  }>({ inFlight: false, pending: null });

  const scheduleFetch = useRef(function schedule(eid: string) {
    const fq = fetchQueue.current;
    if (fq.inFlight) {
      fq.pending = eid;
      return;
    }
    fq.inFlight = true;
    setIsPending(true);

    wikiRef.current.getOntologyManifest(eid).then(
      (result) => {
        if (result) {
          setManifest(result.manifest);
          setMode(result.mode);
        } else {
          setManifest(null);
          setMode(null);
        }
        setError(null);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e : new Error(String(e)));
      },
    ).finally(() => {
      fq.inFlight = false;
      const next = fq.pending;
      fq.pending = null;
      if (next) {
        scheduleFetch.current(next);
      } else {
        setIsPending(false);
      }
    });
  });

  useEffect(() => {
    scheduleFetch.current(entityIdRef.current);
  }, [entityId, wiki]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityIdRef.current);
  }, [entityId]);

  return { manifest, mode, isPending, error, refetch };
}
