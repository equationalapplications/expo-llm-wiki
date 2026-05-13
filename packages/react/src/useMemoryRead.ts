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
 *      · tierWeights: {} is omitted (same effective behavior as undefined; all weights 1.0)
 *  - Keys are sorted so insertion-order differences never cause spurious refetches
 */
function normalizeReadOptionsKey(opts?: ReadOptions): string {
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

  // tierWeights: mirror core's weight sanitization (non-finite → 1.0, negative → 0)
  // and sort keys so insertion-order differences and logically-equivalent values
  // (e.g. NaN vs 1, -5 vs 0) never cause spurious refetches.
  // An empty {} is omitted entirely — behaviorally identical to undefined.
  if (opts.tierWeights !== undefined) {
    const tw = opts.tierWeights;
    const twKeys = Object.keys(tw).sort();
    if (twKeys.length) {
      const sanitized: Record<string, number> = {};
      for (const k of twKeys) {
        const w = tw[k];
        sanitized[k] = !Number.isFinite(w) ? 1.0 : Math.max(0, w);
      }
      normalized.tierWeights = JSON.stringify(sanitized, twKeys);
    }
    // Empty {} → omit (all weights default to 1.0, same as undefined)
  }

  // includeZeroWeightEntities: only include when explicitly set.
  if (opts.includeZeroWeightEntities !== undefined) {
    normalized.includeZeroWeightEntities = opts.includeZeroWeightEntities;
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

  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Serialize a normalized form of options so:
  //  - `undefined` and `{}` map to the same string (no spurious refetch)
  //  - non-finite hybridWeight (±Infinity, NaN) is coerced to its effective value before
  //    stringifying (JSON.stringify turns Infinity/NaN to `null`, losing type information)
  //  - keys are sorted so insertion-order differences don't cause spurious refetches
  const optionsStr = normalizeReadOptionsKey(options);

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
    scheduleFetch.current(entityId, query);
  }, [entityId, query, wiki, optionsStr]);

  const refetch = useCallback(() => {
    scheduleFetch.current(entityId, query);
  }, [entityId, query]);

  return { data, isPending, error, refetch };
}
