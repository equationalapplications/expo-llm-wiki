import { useState, useEffect, useCallback, useRef } from 'react';
import type { MemoryBundle, ReadOptions } from '@equationalapplications/core-llm-wiki';
import { useWiki } from './WikiContext';

/**
 * Normalize a ReadOptions object to a canonical string suitable for use as a
 * React effect dependency key. Normalization ensures:
 *  - `undefined` and `{}` produce the same empty string (no spurious refetch)
 *  - Non-serializable numbers are coerced to their effective values before
 *    stringifying, matching how WikiMemory.read() resolves them:
 *      · maxResults: NaN/±Infinity → 10 (read()'s hardcoded fallback, overrides config)
 *      · preFilterLimit: NaN/±Infinity → null (disables config-level limit, same as null)
 *      · hybridWeight: NaN → null (explicitly disables config-level weight; distinct from
 *        undefined which defers to config); ±Infinity → clamped to 0/1
 *      · tierWeights values: non-finite → 1.0, negative → 0 (mirrors core sanitization)
 *      · tierWeights keys: projected onto the active entityId set (mirrors core's
 *        sanitizeTierWeights which ignores weights for entities not in the request)
 *      · tierWeights: {} or fully-filtered result is omitted (same as undefined)
 *      · includeZeroWeightEntities: false/undefined are equivalent (both skip zero-weight
 *        entities); only true is keyed, matching core's default behavior
 *  - Keys are sorted so insertion-order differences never cause spurious refetches
 */
function normalizeReadOptionsKey(entityId: string | string[], opts?: ReadOptions): string {
  if (!opts) return '';
  const normalized: Record<string, unknown> = {};

  // maxResults: undefined or null → omit (defer to config/default via ??);
  // non-finite (NaN/±Infinity) → 10 (read()'s hardcoded fallback, bypasses config);
  // finite → clamp to non-negative integer.
  if (opts.maxResults !== undefined && opts.maxResults !== null) {
    normalized.maxResults = Number.isFinite(opts.maxResults)
      ? Math.max(0, Math.trunc(opts.maxResults))
      : 10;
  }

  // preFilterLimit: undefined → omit (defer to config);
  // null or non-finite → null (disables config-level limit);
  // finite → clamp to non-negative integer.
  if (opts.preFilterLimit !== undefined) {
    if (opts.preFilterLimit === null || !Number.isFinite(opts.preFilterLimit)) {
      normalized.preFilterLimit = null;
    } else {
      normalized.preFilterLimit = Math.max(0, Math.trunc(opts.preFilterLimit));
    }
  }

  // hybridWeight: undefined or null → omit (defer to config via ??);
  // NaN → null (explicitly disables config hybrid weight; distinct from omitting);
  // ±Infinity and out-of-range finite → clamp to [0, 1].
  if (opts.hybridWeight !== undefined && opts.hybridWeight !== null) {
    normalized.hybridWeight = Number.isNaN(opts.hybridWeight)
      ? null
      : Math.max(0, Math.min(1, opts.hybridWeight));
  }

  // tierWeights: project onto the active entity set (core's sanitizeTierWeights only
  // considers weights for the requested entityIds, so unrelated keys have no behavioral
  // effect and should not contribute to the dep key). Sanitize values (non-finite → 1.0,
  // negative → 0) and sort keys to avoid spurious refetches from insertion-order or
  // logically-equivalent value differences. Omit entirely when the projected result is
  // empty (all weights default to 1.0 — same as undefined).
  if (opts.tierWeights !== undefined) {
    const activeIds = new Set(Array.isArray(entityId) ? entityId : [entityId]);
    const tw = opts.tierWeights;
    const twKeys = Object.keys(tw).filter(k => activeIds.has(k)).sort();
    if (twKeys.length) {
      const sanitized: Record<string, number> = {};
      for (const k of twKeys) {
        const w = tw[k];
        sanitized[k] = !Number.isFinite(w) ? 1.0 : Math.max(0, w);
      }
      normalized.tierWeights = JSON.stringify(sanitized, twKeys);
    }
  }

  // includeZeroWeightEntities: false and undefined are equivalent in core (both exclude
  // zero-weight entities from scored retrieval). Only key when true so toggling
  // undefined → false does not cause a spurious refetch.
  if (opts.includeZeroWeightEntities === true) {
    normalized.includeZeroWeightEntities = true;
  }

  const sortedKeys = Object.keys(normalized).sort();
  return sortedKeys.length ? JSON.stringify(normalized, sortedKeys) : '';
}

export function useMemoryRead(entityId: string | string[], query: string, options?: ReadOptions) {
  const wiki = useWiki();
  const [data, setData] = useState<MemoryBundle | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;

  const entityIdRef = useRef(entityId);
  entityIdRef.current = entityId;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Stable dep key for entityId: sort+dedup so inline array literals (new reference
  // each render) don't cause spurious refetches. The same set of entity IDs always
  // produces the same key regardless of reference identity or insertion order.
  const entityIdKey = Array.isArray(entityId)
    ? [...new Set(entityId)].sort().join('\0')
    : entityId;

  // Serialize a normalized form of options so:
  //  - `undefined` and `{}` map to the same string (no spurious refetch)
  //  - non-finite hybridWeight (±Infinity, NaN) is coerced to its effective value before
  //    stringifying (JSON.stringify turns Infinity/NaN to `null`, losing type information)
  //  - keys are sorted so insertion-order differences don't cause spurious refetches
  const optionsStr = normalizeReadOptionsKey(entityId, options);

  const fetchQueue = useRef<{
    inFlight: boolean;
    pending: { entityId: string | string[]; query: string } | null;
  }>({ inFlight: false, pending: null });

  // Stable scheduler: refs keep it from going stale across renders.
  // In-flight results are never discarded — spec requires them to land before
  // starting the next fetch with latest args.
  const scheduleFetch = useRef(function schedule(eid: string | string[], q: string) {
    const fq = fetchQueue.current;
    if (fq.inFlight) {
      fq.pending = { entityId: eid, query: q };
      return;
    }
    fq.inFlight = true;
    setIsPending(true);

    wikiRef.current.read(eid, q, optionsRef.current).then(
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
    scheduleFetch.current(entityIdRef.current, query);
  }, [entityIdKey, query, wiki, optionsStr]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityIdRef.current, query);
  }, [entityIdKey, query]);

  return { data, isPending, error, refetch };
}
