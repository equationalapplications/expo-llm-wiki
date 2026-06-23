import { useState, useEffect, useCallback, useRef } from 'react';
import type { GraphTraversalOptions, WikiFact, WikiEdge } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

export interface WikiTraversalState {
  nodes: WikiFact[];
  edges: WikiEdge[];
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Stable dep key for a GraphTraversalOptions object so inline object literals
 * (new reference each render) don't cause spurious refetches. Sorted-key
 * JSON.stringify, mirroring normalizeReadOptionsKey in useMemoryRead.ts.
 */
function normalizeTraversalOptionsKey(options: GraphTraversalOptions): string {
  const normalized: Record<string, unknown> = { sourceId: options.sourceId };

  if (options.maxDepth !== undefined) normalized.maxDepth = options.maxDepth;
  if (options.direction !== undefined) normalized.direction = options.direction;
  if (options.edgeTypes !== undefined) normalized.edgeTypes = [...options.edgeTypes].sort();
  if (options.maxTraversalNodes !== undefined) normalized.maxTraversalNodes = options.maxTraversalNodes;
  if (options.minTraversalConfidence !== undefined) normalized.minTraversalConfidence = options.minTraversalConfidence;
  if (options.excludeSourceTypes !== undefined) normalized.excludeSourceTypes = [...options.excludeSourceTypes].sort();

  const sortedKeys = Object.keys(normalized).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sorted[k] = normalized[k];
  }
  // Do not pass sortedKeys as a JSON.stringify replacer — array values would lose
  // their elements because replacer keys must be object property names, not indices.
  return JSON.stringify(sorted);
}

/**
 * Reactive read hook for graph traversal. Fetches on mount and whenever
 * `entityId` or a stable serialization of `options` changes.
 * Call `refetch()` after mutations that change the underlying edges (e.g. runLibrarian).
 */
export function useWikiTraversal(entityId: string, options: GraphTraversalOptions): WikiTraversalState {
  const wiki = useWiki();
  const [nodes, setNodes] = useState<WikiFact[]>([]);
  const [edges, setEdges] = useState<WikiEdge[]>([]);
  const [isPending, setIsPending] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const entityIdRef = useRef(entityId);
  entityIdRef.current = entityId;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const optionsKey = normalizeTraversalOptionsKey(options);

  const fetchQueue = useRef<{
    inFlight: boolean;
    pending: { entityId: string; options: GraphTraversalOptions } | null;
  }>({ inFlight: false, pending: null });

  // Stable scheduler: refs keep it from going stale across renders.
  // In-flight results are never discarded.
  const scheduleFetch = useRef(function schedule(eid: string, opts: GraphTraversalOptions) {
    const fq = fetchQueue.current;
    if (fq.inFlight) {
      fq.pending = { entityId: eid, options: opts };
      return;
    }
    fq.inFlight = true;
    setIsPending(true);

    wikiRef.current.traverseGraph(eid, opts).then(
      (result) => {
        setNodes(result.nodes);
        setEdges(result.edges);
        setError(null);
      },
      (e: unknown) => {
        setNodes([]);
        setEdges([]);
        setError(e instanceof Error ? e : new Error(String(e)));
      },
    ).finally(() => {
      fq.inFlight = false;
      const next = fq.pending;
      fq.pending = null;
      if (next) {
        scheduleFetch.current(next.entityId, next.options);
      } else {
        setIsPending(false);
      }
    });
  });

  useEffect(() => {
    scheduleFetch.current(entityIdRef.current, optionsRef.current);
  }, [entityId, optionsKey, wiki]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityIdRef.current, optionsRef.current);
  }, [entityId, optionsKey]);

  return { nodes, edges, isPending, error, refetch };
}
