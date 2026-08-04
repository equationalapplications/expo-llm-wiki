import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WikiProvider, useWiki } from '../src/WikiContext';
import { useMemoryRead } from '../src/useMemoryRead';
import { useWikiWrite } from '../src/useWikiWrite';
import { useWikiMaintenance } from '../src/useWikiMaintenance';
import { useWikiIngest } from '../src/useWikiIngest';
import { useWikiForget } from '../src/useWikiForget';
import { useWikiExport } from '../src/useWikiExport';
import { useWikiHasChanged } from '../src/useWikiHasChanged';
import { useEntityStatus } from '../src/useEntityStatus';
import { useOntologyManifest } from '../src/useOntologyManifest';
import { useSetOntologyManifest } from '../src/useSetOntologyManifest';
import { useWikiTraversal } from '../src/useWikiTraversal';
import type { ReadOptions, EntityStatus, OntologyManifest } from '@equationalapplications/core-llm-wiki';

/** Minimal mock of WikiMemory — uses the real MemoryBundle shape ({ facts, tasks, events }) */
function makeMockWiki() {
  return {
    read: vi.fn().mockResolvedValue({ facts: [], tasks: [], events: [] }),
    write: vi.fn().mockResolvedValue(undefined),
    ingestDocument: vi.fn().mockResolvedValue({ truncated: false, chunks: 1 }),
    forget: vi.fn().mockResolvedValue({ deleted: { entries: 0, tasks: 0 } }),
    exportDump: vi.fn().mockResolvedValue({ version: 1, entities: {} }),
    hasChanged: vi.fn().mockResolvedValue(true),
    runLibrarian: vi.fn().mockResolvedValue(undefined),
    runHeal: vi.fn().mockResolvedValue({
      scanned: 3, downgraded: 0, deleted: 0, newFactsCreated: 0,
      skipped: 0, remaining: 7, deferred: 3,
    }),
    runPrune: vi.fn().mockResolvedValue({ entries: 0, tasks: 0, events: 0 }),
    runReembed: vi.fn().mockResolvedValue({ embedded: 0, skipped: 0, failed: 0 }),
    getEntityStatus: vi.fn().mockReturnValue({ ingesting: false, librarian: false, heal: false }),
    subscribeEntityStatus: vi.fn((_entityId: string, cb: (s: EntityStatus) => void) => {
      cb({ ingesting: false, librarian: false, heal: false });
      return vi.fn();
    }),
    getOntologyManifest: vi.fn().mockResolvedValue(null),
    setOntologyManifest: vi.fn().mockResolvedValue(undefined),
    traverseGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  };
}

type MockWiki = ReturnType<typeof makeMockWiki>;

function wrapper(wiki: MockWiki) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <WikiProvider wiki={wiki as any}>{children}</WikiProvider>;
  };
}

// ---------------------------------------------------------------------------
// WikiProvider / useWiki
// ---------------------------------------------------------------------------

describe('WikiProvider / useWiki', () => {
  it('provides the wiki instance via useWiki', () => {
    const wiki = makeMockWiki();
    const { result } = renderHook(() => useWiki(), { wrapper: wrapper(wiki) });
    expect(result.current).toBe(wiki);
  });

  it('throws when useWiki is called outside WikiProvider', () => {
    // Suppress React's error boundary noise in test output
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useWiki())).toThrow('useWiki must be used within WikiProvider');
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// useMemoryRead
// ---------------------------------------------------------------------------

describe('useMemoryRead', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts with isPending=true and calls wiki.read on mount', async () => {
    const { result } = renderHook(
      () => useMemoryRead('user-1', 'preferences'),
      { wrapper: wrapper(wiki) }
    );

    // Initially pending
    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.read).toHaveBeenCalledWith('user-1', 'preferences', undefined);
    expect(result.current.data).toEqual({ facts: [], tasks: [], events: [] });
    expect(result.current.error).toBeNull();
  });

  it('re-fetches when entityId changes', async () => {
    const { result, rerender } = renderHook(
      ({ eid }: { eid: string }) => useMemoryRead(eid, 'q'),
      { initialProps: { eid: 'user-1' }, wrapper: wrapper(wiki) }
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.read).toHaveBeenCalledTimes(1);

    rerender({ eid: 'user-2' });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.read).toHaveBeenCalledTimes(2);
    expect(wiki.read).toHaveBeenLastCalledWith('user-2', 'q', undefined);
  });

  it('exposes error and sets error state when wiki.read rejects', async () => {
    const boom = new Error('db error');
    wiki.read.mockRejectedValue(boom);

    const { result } = renderHook(
      () => useMemoryRead('user-1', 'q'),
      { wrapper: wrapper(wiki) }
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.error).toBe(boom);
    expect(result.current.data).toBeNull();
  });

  it('refetch() triggers another read', async () => {
    const { result } = renderHook(
      () => useMemoryRead('user-1', 'q'),
      { wrapper: wrapper(wiki) }
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.read).toHaveBeenCalledTimes(1);

    act(() => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.read).toHaveBeenCalledTimes(2);
  });

  it('forwards ReadOptions to wiki.read', async () => {
    const { result } = renderHook(
      () => useMemoryRead('user-1', 'preferences', { maxResults: 5, preFilterLimit: 20 }),
      { wrapper: wrapper(wiki) }
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.read).toHaveBeenCalledWith('user-1', 'preferences', { maxResults: 5, preFilterLimit: 20 });
  });

  it('uses the latest options via ref on refetch()', async () => {
    let opts: { maxResults: number } | undefined = { maxResults: 3 };
    const { result, rerender } = renderHook(
      () => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki) }
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    // Update options and trigger a rerender so the ref is updated, then refetch
    opts = { maxResults: 7 };
    rerender();
    act(() => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    // The last call should use the updated options captured via the ref
    expect(wiki.read).toHaveBeenLastCalledWith('user-1', 'q', { maxResults: 7 });
  });

  it('does not re-fetch when only the options reference changes on re-render', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: { maxResults: number } }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { maxResults: 3 } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // Re-render with a new options object reference but the same logical values.
    // Serialized options are unchanged so no extra wiki.read() should be triggered.
    rerender({ opts: { maxResults: 3 } });
    // Drain any pending microtasks / state updates before asserting no extra call.
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when options keys are in a different insertion order but values are identical', async () => {
    type MultiOpts = { maxResults: number; hybridWeight: number };
    const { rerender } = renderHook(
      ({ opts }: { opts: MultiOpts }) => useMemoryRead('user-1', 'q', opts as ReadOptions),
      {
        wrapper: wrapper(wiki),
        initialProps: { opts: { maxResults: 3, hybridWeight: 0.5 } as MultiOpts },
      }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // Re-render with keys in a different insertion order but same logical content.
    // Sorted-key serialization must produce the same string → no extra refetch.
    rerender({ opts: { hybridWeight: 0.5, maxResults: 3 } as MultiOpts });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('re-fetches automatically when options values change', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: { maxResults: number } }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { maxResults: 3 } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // Re-render with different option values — serialized options differ so an
    // automatic refetch should fire without the caller invoking refetch() manually.
    rerender({ opts: { maxResults: 7 } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
    expect(wiki.read).toHaveBeenLastCalledWith('user-1', 'q', { maxResults: 7 });
  });

  it('re-fetches when maxResults changes from finite to NaN (read() normalizes NaN to 10, not config value)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // NaN overrides config (read() hard-codes fallback to 10 for non-finite maxResults)
    // so changing from {} to { maxResults: NaN } is a behavioral difference that must trigger a refetch.
    rerender({ opts: { maxResults: NaN } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });

  it('re-fetches when hybridWeight changes from undefined to NaN (NaN disables config-level hybrid weight)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // hybridWeight: NaN bypasses config.hybridWeight (NaN is not null/undefined so ?? doesn't fire).
    // Changing from {} to { hybridWeight: NaN } must therefore trigger a refetch.
    rerender({ opts: { hybridWeight: NaN } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });

  it('re-fetches when preFilterLimit changes from undefined to Infinity (Infinity disables config-level limit)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // preFilterLimit: Infinity disables the config-level limit (same effective result as null)
    // whereas undefined defers to config — these are different behaviors, must trigger refetch.
    rerender({ opts: { preFilterLimit: Infinity } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch when active entity tierWeight is explicitly set to the default (1.0 is same as omitted)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // Per spec: "Missing tier weights default to 1.0", so passing 1.0 explicitly
    // is behaviorally identical to omission and must not trigger a refetch.
    rerender({ opts: { tierWeights: { 'user-1': 1 } } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when tierWeights changes from undefined to {} (empty object is same as undefined)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // tierWeights: {} has no entries, so all weights default to 1.0 — same as undefined.
    rerender({ opts: { tierWeights: {} } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when tierWeights gains an entry for the active entity (behavioral change from all-default weights)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { tierWeights: {} } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // 'user-1' matches the active entityId so the weight is included in the dep key.
    rerender({ opts: { tierWeights: { 'user-1': 2 } } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch when tierWeights has non-finite values replaced by their effective 1.0 equivalent', async () => {
    // Use entityId matching the tierWeights key so the key is in the active set
    // and the sanitization path (NaN → 1.0) is actually exercised.
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { tierWeights: { 'user-1': NaN } } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // NaN → 1.0 per spec ("non-finite values default to 1.0"), so key is unchanged.
    rerender({ opts: { tierWeights: { 'user-1': 1 } } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when tierWeights has negative values replaced by their effective 0 equivalent', async () => {
    // Use entityId matching the tierWeights key so the key is in the active set
    // and the sanitization path (negative → 0) is actually exercised.
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { tierWeights: { 'user-1': -5 } } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // -5 → 0 per spec ("negative values clamp to 0"), so key is unchanged.
    rerender({ opts: { tierWeights: { 'user-1': 0 } } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch when tierWeights changes only for entities outside the active entityId set', async () => {
    // Core's sanitizeTierWeights(entityIds, tierWeights) only considers weights for
    // the requested entity IDs — weights for other entities have no behavioral effect.
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { tierWeights: { tier_wisdom: 2 } } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    // 'tier_wisdom' is not 'user-1', so adding or changing it has no effect.
    rerender({ opts: { tierWeights: { tier_wisdom: 2, unrelated_entity: 99 } } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when tierWeights changes for the active entity', async () => {
    // Use a string entityId to avoid array reference churn; the key point is that
    // 'user-1' is in the active set so its weight IS included in the dep key.
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { tierWeights: { 'user-1': 1 } } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    rerender({ opts: { tierWeights: { 'user-1': 2 } } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch when includeZeroWeightEntities changes from undefined to false', async () => {
    // In core, undefined and false are equivalent (both exclude zero-weight entities
    // from scored retrieval by default). Toggling between them must not cause a refetch.
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: {} } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    rerender({ opts: { includeZeroWeightEntities: false } });
    await act(async () => {});
    expect(wiki.read).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when includeZeroWeightEntities changes from false to true (behavioral change)', async () => {
    const { rerender } = renderHook(
      ({ opts }: { opts: ReadOptions }) => useMemoryRead('user-1', 'q', opts),
      { wrapper: wrapper(wiki), initialProps: { opts: { includeZeroWeightEntities: false } } }
    );

    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(1));

    rerender({ opts: { includeZeroWeightEntities: true } });
    await waitFor(() => expect(wiki.read).toHaveBeenCalledTimes(2));
  });
});

const sampleOntologyManifest: OntologyManifest = {
  node_types: [{ type: 'person', description: 'An individual.' }],
  edge_types: [{
    type: 'reports_to',
    source_type: 'person',
    target_type: 'person',
    description: 'Reporting hierarchy.',
  }],
};

// ---------------------------------------------------------------------------
// useOntologyManifest
// ---------------------------------------------------------------------------

describe('useOntologyManifest', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts with isPending=true and calls getOntologyManifest on mount', async () => {
    wiki.getOntologyManifest.mockResolvedValue({
      mode: 'strict',
      manifest: sampleOntologyManifest,
    });

    const { result } = renderHook(
      () => useOntologyManifest('e1'),
      { wrapper: wrapper(wiki) },
    );

    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.getOntologyManifest).toHaveBeenCalledWith('e1');
    expect(result.current.manifest).toEqual(sampleOntologyManifest);
    expect(result.current.mode).toBe('strict');
    expect(result.current.error).toBeNull();
  });

  it('maps null core response to manifest=null and mode=null', async () => {
    wiki.getOntologyManifest.mockResolvedValue(null);

    const { result } = renderHook(
      () => useOntologyManifest('e1'),
      { wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.manifest).toBeNull();
    expect(result.current.mode).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('re-fetches when entityId changes', async () => {
    const { result, rerender } = renderHook(
      ({ eid }: { eid: string }) => useOntologyManifest(eid),
      { initialProps: { eid: 'e1' }, wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.getOntologyManifest).toHaveBeenCalledTimes(1);

    rerender({ eid: 'e2' });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.getOntologyManifest).toHaveBeenCalledTimes(2);
    expect(wiki.getOntologyManifest).toHaveBeenLastCalledWith('e2');
  });

  it('sets error when getOntologyManifest rejects', async () => {
    const boom = new Error('ontology db error');
    wiki.getOntologyManifest.mockRejectedValue(boom);

    const { result } = renderHook(
      () => useOntologyManifest('e1'),
      { wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.error).toBe(boom);
    expect(result.current.manifest).toBeNull();
    expect(result.current.mode).toBeNull();
  });

  it('refetch() triggers another getOntologyManifest call', async () => {
    const { result } = renderHook(
      () => useOntologyManifest('e1'),
      { wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.getOntologyManifest).toHaveBeenCalledTimes(1);

    act(() => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.getOntologyManifest).toHaveBeenCalledTimes(2);
    expect(wiki.getOntologyManifest).toHaveBeenLastCalledWith('e1');
  });

  it('queues a fetch when entityId changes while first fetch is in flight', async () => {
    let resolveFirst!: (value: null) => void;
    wiki.getOntologyManifest
      .mockReturnValueOnce(new Promise<null>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ mode: 'emergent', manifest: sampleOntologyManifest });

    const { result, rerender } = renderHook(
      ({ eid }: { eid: string }) => useOntologyManifest(eid),
      { initialProps: { eid: 'e1' }, wrapper: wrapper(wiki) },
    );

    expect(result.current.isPending).toBe(true);

    rerender({ eid: 'e2' });

    await act(async () => { resolveFirst(null); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.getOntologyManifest).toHaveBeenCalledTimes(2);
    expect(wiki.getOntologyManifest).toHaveBeenNthCalledWith(1, 'e1');
    expect(wiki.getOntologyManifest).toHaveBeenNthCalledWith(2, 'e2');
    expect(result.current.mode).toBe('emergent');
    expect(result.current.manifest).toEqual(sampleOntologyManifest);
  });
});

// ---------------------------------------------------------------------------
// useSetOntologyManifest
// ---------------------------------------------------------------------------

describe('useSetOntologyManifest', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useSetOntologyManifest(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('calls setOntologyManifest with args and toggles isPending', async () => {
    let resolve!: () => void;
    wiki.setOntologyManifest.mockReturnValue(new Promise<void>(r => { resolve = r; }));

    const { result } = renderHook(() => useSetOntologyManifest(), { wrapper: wrapper(wiki) });

    let executePromise!: Promise<void>;
    await act(async () => {
      executePromise = result.current.execute('e1', sampleOntologyManifest, { mode: 'strict' });
    });

    expect(result.current.isPending).toBe(true);
    expect(wiki.setOntologyManifest).toHaveBeenCalledWith('e1', sampleOntologyManifest, { mode: 'strict' });

    await act(async () => {
      resolve();
      await executePromise;
    });

    expect(result.current.isPending).toBe(false);
    expect(result.current.lastResult).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('sets error and re-throws when setOntologyManifest rejects', async () => {
    const boom = new Error('set failed');
    wiki.setOntologyManifest.mockRejectedValue(boom);

    const { result } = renderHook(() => useSetOntologyManifest(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.execute('e1', sampleOntologyManifest);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
    expect(result.current.isPending).toBe(false);
  });

  it('returns a stable execute reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useSetOntologyManifest(), { wrapper: wrapper(wiki) });
    const first = result.current.execute;
    rerender();
    expect(result.current.execute).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// useWikiWrite
// ---------------------------------------------------------------------------

describe('useWikiWrite', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiWrite(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('calls wiki.write and sets isPending during execution', async () => {
    let resolve!: () => void;
    wiki.write.mockReturnValue(new Promise<void>(r => { resolve = r; }));

    const { result } = renderHook(() => useWikiWrite(), { wrapper: wrapper(wiki) });

    // Start execution inside act so initial state updates flush
    let executePromise!: Promise<void>;
    await act(async () => {
      executePromise = result.current.execute('user-1', { event_type: 'observation', summary: 'hello' } as any);
    });

    expect(result.current.isPending).toBe(true);
    expect(wiki.write).toHaveBeenCalledWith('user-1', { event_type: 'observation', summary: 'hello' });

    // Resolve the pending write and wait for state to settle
    await act(async () => {
      resolve();
      await executePromise;
    });

    expect(result.current.isPending).toBe(false);
  });

  it('sets error state and re-throws when wiki.write rejects', async () => {
    const boom = new Error('write failed');
    wiki.write.mockRejectedValue(boom);

    const { result } = renderHook(() => useWikiWrite(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.execute('user-1', { event_type: 'observation', summary: 'hello' } as any);
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
    expect(result.current.isPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useWikiMaintenance
// ---------------------------------------------------------------------------

describe('useWikiMaintenance', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('runLibrarian sets lastResult and clears isPending', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => { await result.current.runLibrarian('user-1'); });

    expect(wiki.runLibrarian).toHaveBeenCalledWith('user-1');
    expect(result.current.lastResult).toEqual({ operation: 'librarian', result: undefined });
    expect(result.current.isPending).toBe(false);
  });

  it('runHeal sets lastResult', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => { await result.current.runHeal('user-1'); });

    expect(wiki.runHeal).toHaveBeenCalledWith('user-1');
    expect(result.current.lastResult).toMatchObject({ operation: 'heal' });
  });

  it('runLibrarian forwards promptOverride to wiki.runLibrarian', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => {
      await result.current.runLibrarian('user-1', { promptOverride: 'custom lib prompt' });
    });

    expect(wiki.runLibrarian).toHaveBeenCalledWith('user-1', { promptOverride: 'custom lib prompt' });
  });

  it('runHeal forwards promptOverride to wiki.runHeal', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => {
      await result.current.runHeal('user-1', { promptOverride: 'custom heal prompt' });
    });

    expect(wiki.runHeal).toHaveBeenCalledWith('user-1', { promptOverride: 'custom heal prompt' });
  });

  it('runHeal returns the HealResult instead of discarding it', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });
    let returned: unknown;
    await act(async () => { returned = await result.current.runHeal('user-1'); });
    expect(returned).toMatchObject({ scanned: 3, remaining: 7 });
  });

  it('runHeal exposes the HealResult on lastResult', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });
    await act(async () => { await result.current.runHeal('user-1'); });
    expect(result.current.lastResult).toMatchObject({
      operation: 'heal',
      result: { scanned: 3, remaining: 7 },
    });
  });

  it('runHeal forwards batchSize to wiki.runHeal', async () => {
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });
    await act(async () => { await result.current.runHeal('user-1', { batchSize: 5 }); });
    expect(wiki.runHeal).toHaveBeenCalledWith('user-1', { batchSize: 5 });
  });

  it('runPrune returns pruned counts and sets lastResult', async () => {
    wiki.runPrune.mockResolvedValue({ entries: 3, tasks: 1, events: 2 });
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    let pruneResult!: { entries: number; tasks: number; events: number };
    await act(async () => { pruneResult = await result.current.runPrune('user-1'); });

    expect(pruneResult).toEqual({ entries: 3, tasks: 1, events: 2 });
    expect(result.current.lastResult).toEqual({ operation: 'prune', result: { entries: 3, tasks: 1, events: 2 } });
  });

  it('runReembed returns embedded/skipped counts and clears lastResult', async () => {
    // First run a prune to set a non-null lastResult
    wiki.runPrune.mockResolvedValue({ entries: 1, tasks: 0, events: 0 });
    wiki.runReembed.mockResolvedValue({ embedded: 5, skipped: 2, failed: 3 });
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => { await result.current.runPrune('user-1'); });
    expect(result.current.lastResult?.operation).toBe('prune');

    let reembedResult!: { embedded: number; skipped: number; failed: number };
    await act(async () => { reembedResult = await result.current.runReembed('user-1'); });

    expect(wiki.runReembed).toHaveBeenCalledWith('user-1', undefined);
    expect(reembedResult).toEqual({ embedded: 5, skipped: 2, failed: 3 });
    // runReembed clears lastResult at start so stale librarian/heal/prune
    // results do not remain visible while reembed is pending or after it completes.
    // It is intentionally excluded from the MaintenanceResult union to avoid a
    // source-breaking change for consumers that exhaustively switch on lastResult.operation.
    expect(result.current.lastResult).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('sets error state and re-throws when runReembed rejects', async () => {
    const boom = new Error('reembed failed');
    wiki.runReembed.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try { await result.current.runReembed('user-1'); } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
    expect(result.current.isPending).toBe(false);
  });

  it('sets error state and re-throws when runLibrarian rejects', async () => {
    const boom = new Error('maintenance failed');
    wiki.runLibrarian.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try { await result.current.runLibrarian('user-1'); } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
    expect(result.current.isPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useWikiIngest
// ---------------------------------------------------------------------------

describe('useWikiIngest', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiIngest(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('calls wiki.ingestDocument and sets lastResult', async () => {
    wiki.ingestDocument.mockResolvedValue({ truncated: false, chunks: 3 });
    const { result } = renderHook(() => useWikiIngest(), { wrapper: wrapper(wiki) });

    let ingestResult!: { truncated: boolean; chunks: number };
    await act(async () => {
      ingestResult = await result.current.execute('user-1', {
        sourceRef: 'doc1', sourceHash: 'abc', documentChunk: 'hello world',
      });
    });

    expect(ingestResult).toEqual({ truncated: false, chunks: 3 });
    expect(result.current.lastResult).toEqual({ truncated: false, chunks: 3 });
    expect(result.current.isPending).toBe(false);
  });

  it('forwards promptOverride to wiki.ingestDocument', async () => {
    wiki.ingestDocument.mockResolvedValue({ truncated: false, chunks: 3 });
    const { result } = renderHook(() => useWikiIngest(), { wrapper: wrapper(wiki) });

    await act(async () => {
      await result.current.execute('user-1', {
        sourceRef: 'doc1',
        sourceHash: 'abc',
        documentChunk: 'hello world',
        promptOverride: 'custom ingest prompt',
      });
    });

    expect(wiki.ingestDocument).toHaveBeenCalledWith('user-1', {
      sourceRef: 'doc1',
      sourceHash: 'abc',
      documentChunk: 'hello world',
      promptOverride: 'custom ingest prompt',
    });
  });

  it('sets error state and re-throws when ingestDocument rejects', async () => {
    const boom = new Error('ingest failed');
    wiki.ingestDocument.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiIngest(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.execute('user-1', { sourceRef: 'doc1', sourceHash: 'abc', documentChunk: 'text' });
      } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// useWikiForget
// ---------------------------------------------------------------------------

describe('useWikiForget', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiForget(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('calls wiki.forget and sets lastResult', async () => {
    wiki.forget.mockResolvedValue({ deleted: { entries: 2, tasks: 1 } });
    const { result } = renderHook(() => useWikiForget(), { wrapper: wrapper(wiki) });

    let forgetResult!: { deleted: { entries: number; tasks: number } };
    await act(async () => {
      forgetResult = await result.current.execute('user-1', { clearAll: true });
    });

    expect(forgetResult).toEqual({ deleted: { entries: 2, tasks: 1 } });
    expect(result.current.lastResult).toEqual({ deleted: { entries: 2, tasks: 1 } });
  });

  it('sets error state and re-throws when forget rejects', async () => {
    const boom = new Error('forget failed');
    wiki.forget.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiForget(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try { await result.current.execute('user-1', { clearAll: true }); } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// useWikiExport
// ---------------------------------------------------------------------------

describe('useWikiExport', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiExport(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('calls wiki.exportDump and sets lastResult', async () => {
    const dump = { version: 1, entities: { 'user-1': { facts: [], tasks: [], events: [] } } };
    wiki.exportDump.mockResolvedValue(dump);
    const { result } = renderHook(() => useWikiExport(), { wrapper: wrapper(wiki) });

    let exportResult: unknown;
    await act(async () => { exportResult = await result.current.execute(['user-1']); });

    expect(exportResult).toEqual(dump);
    expect(result.current.lastResult).toEqual(dump);
    expect(wiki.exportDump).toHaveBeenCalledWith(['user-1']);
  });

  it('sets error state and re-throws when exportDump rejects', async () => {
    const boom = new Error('export failed');
    wiki.exportDump.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiExport(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try { await result.current.execute(); } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// useWikiHasChanged
// ---------------------------------------------------------------------------

describe('useWikiHasChanged', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useWikiHasChanged(), { wrapper: wrapper(wiki) });
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.lastResult).toBeNull();
  });

  it('returns true and sets lastResult when content has changed', async () => {
    wiki.hasChanged.mockResolvedValue(true);
    const { result } = renderHook(() => useWikiHasChanged(), { wrapper: wrapper(wiki) });

    let changed!: boolean;
    await act(async () => {
      changed = await result.current.execute('user-1', 'doc1', 'abc123');
    });

    expect(changed).toBe(true);
    expect(result.current.lastResult).toBe(true);
    expect(wiki.hasChanged).toHaveBeenCalledWith('user-1', 'doc1', 'abc123');
  });

  it('returns false when content has not changed', async () => {
    wiki.hasChanged.mockResolvedValue(false);
    const { result } = renderHook(() => useWikiHasChanged(), { wrapper: wrapper(wiki) });

    let changed!: boolean;
    await act(async () => {
      changed = await result.current.execute('user-1', 'doc1', 'abc123');
    });

    expect(changed).toBe(false);
    expect(result.current.lastResult).toBe(false);
  });

  it('sets error state and re-throws when hasChanged rejects', async () => {
    const boom = new Error('hasChanged failed');
    wiki.hasChanged.mockRejectedValue(boom);
    const { result } = renderHook(() => useWikiHasChanged(), { wrapper: wrapper(wiki) });

    let caught: unknown;
    await act(async () => {
      try { await result.current.execute('user-1', 'doc1', 'abc123'); } catch (e) { caught = e; }
    });

    expect(caught).toBe(boom);
    expect(result.current.error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// useEntityStatus
// ---------------------------------------------------------------------------

describe('useEntityStatus', () => {
  it('returns the initial snapshot from getEntityStatus', () => {
    const wiki = makeMockWiki();
    wiki.getEntityStatus.mockReturnValue({ ingesting: true, librarian: false, heal: false });
    wiki.subscribeEntityStatus.mockImplementation((_entityId: string, cb: (s: EntityStatus) => void) => {
      cb({ ingesting: true, librarian: false, heal: false });
      return vi.fn();
    });

    const { result } = renderHook(() => useEntityStatus('e1'), { wrapper: wrapper(wiki) });

    expect(result.current).toEqual({ ingesting: true, librarian: false, heal: false });
    expect(wiki.getEntityStatus).toHaveBeenCalledWith('e1');
  });

  it('updates when the subscription callback fires a transition', () => {
    const wiki = makeMockWiki();
    const { result } = renderHook(() => useEntityStatus('e1'), { wrapper: wrapper(wiki) });

    const cb = wiki.subscribeEntityStatus.mock.calls[0][1] as (s: EntityStatus) => void;
    act(() => {
      cb({ ingesting: true, librarian: false, heal: false });
    });

    expect(result.current).toEqual({ ingesting: true, librarian: false, heal: false });
  });

  it('unsubscribes on unmount', () => {
    const wiki = makeMockWiki();
    const { unmount } = renderHook(() => useEntityStatus('e1'), { wrapper: wrapper(wiki) });

    const unsubscribe = wiki.subscribeEntityStatus.mock.results[0].value as () => void;
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resubscribes when entityId changes', () => {
    const wiki = makeMockWiki();
    const { rerender, result } = renderHook(({ entityId }) => useEntityStatus(entityId), {
      wrapper: wrapper(wiki),
      initialProps: { entityId: 'e1' },
    });

    const firstUnsubscribe = wiki.subscribeEntityStatus.mock.results[0].value as () => void;

    wiki.getEntityStatus.mockImplementation((id: string) =>
      id === 'e2'
        ? { ingesting: true, librarian: false, heal: false }
        : { ingesting: false, librarian: false, heal: false },
    );
    wiki.subscribeEntityStatus.mockImplementation((id: string, cb: (s: EntityStatus) => void) => {
      cb(wiki.getEntityStatus(id));
      return vi.fn();
    });

    rerender({ entityId: 'e2' });

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(wiki.subscribeEntityStatus).toHaveBeenCalledTimes(2);
    expect(wiki.subscribeEntityStatus.mock.calls[1][0]).toBe('e2');
    expect(result.current).toEqual({ ingesting: true, librarian: false, heal: false });
  });
});

// ---------------------------------------------------------------------------
// useWikiTraversal
// ---------------------------------------------------------------------------

describe('useWikiTraversal', () => {
  let wiki: MockWiki;

  beforeEach(() => {
    wiki = makeMockWiki();
  });

  it('starts with isPending=true and calls traverseGraph on mount', async () => {
    const sampleResult = { nodes: [{ id: 'a' }] as any, edges: [{ id: 'e1' }] as any };
    wiki.traverseGraph.mockResolvedValue(sampleResult);

    const { result } = renderHook(
      () => useWikiTraversal('e1', { sourceId: 'a' }),
      { wrapper: wrapper(wiki) },
    );

    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.traverseGraph).toHaveBeenCalledWith('e1', { sourceId: 'a' });
    expect(result.current.nodes).toEqual(sampleResult.nodes);
    expect(result.current.edges).toEqual(sampleResult.edges);
    expect(result.current.error).toBeNull();
  });

  it('re-fetches when entityId changes', async () => {
    const { result, rerender } = renderHook(
      ({ eid }: { eid: string }) => useWikiTraversal(eid, { sourceId: 'a' }),
      { initialProps: { eid: 'e1' }, wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(1);

    rerender({ eid: 'e2' });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.traverseGraph).toHaveBeenCalledTimes(2);
    expect(wiki.traverseGraph).toHaveBeenLastCalledWith('e2', { sourceId: 'a' });
  });

  it('re-fetches when options change in value but not on equivalent re-renders', async () => {
    const { result, rerender } = renderHook(
      ({ sourceId }: { sourceId: string }) => useWikiTraversal('e1', { sourceId, maxDepth: 1 }),
      { initialProps: { sourceId: 'a' }, wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(1);

    // Same sourceId, new object reference — should NOT refetch.
    rerender({ sourceId: 'a' });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(1);

    // Different sourceId — should refetch.
    rerender({ sourceId: 'b' });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when edgeTypes array changes', async () => {
    const { result, rerender } = renderHook(
      ({ edgeTypes }: { edgeTypes: string[] }) => useWikiTraversal('e1', { sourceId: 'a', edgeTypes }),
      { initialProps: { edgeTypes: ['mentions'] }, wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(1);

    rerender({ edgeTypes: ['reports_to'] });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(2);
    expect(wiki.traverseGraph).toHaveBeenLastCalledWith('e1', { sourceId: 'a', edgeTypes: ['reports_to'] });
  });

  it('sets error when traverseGraph rejects', async () => {
    const boom = new Error('traversal db error');
    wiki.traverseGraph.mockRejectedValue(boom);

    const { result } = renderHook(
      () => useWikiTraversal('e1', { sourceId: 'a' }),
      { wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.error).toBe(boom);
    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });

  it('refetch() triggers another traverseGraph call', async () => {
    const { result } = renderHook(
      () => useWikiTraversal('e1', { sourceId: 'a' }),
      { wrapper: wrapper(wiki) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(wiki.traverseGraph).toHaveBeenCalledTimes(1);

    act(() => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.traverseGraph).toHaveBeenCalledTimes(2);
  });

  it('queues a fetch when entityId changes while first fetch is in flight', async () => {
    let resolveFirst!: (value: { nodes: any[]; edges: any[] }) => void;
    wiki.traverseGraph
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ nodes: [{ id: 'z' }], edges: [] });

    const { result, rerender } = renderHook(
      ({ eid }: { eid: string }) => useWikiTraversal(eid, { sourceId: 'a' }),
      { initialProps: { eid: 'e1' }, wrapper: wrapper(wiki) },
    );

    expect(result.current.isPending).toBe(true);

    rerender({ eid: 'e2' });

    await act(async () => { resolveFirst({ nodes: [], edges: [] }); });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(wiki.traverseGraph).toHaveBeenCalledTimes(2);
    expect(wiki.traverseGraph).toHaveBeenNthCalledWith(1, 'e1', { sourceId: 'a' });
    expect(wiki.traverseGraph).toHaveBeenNthCalledWith(2, 'e2', { sourceId: 'a' });
    expect(result.current.nodes).toEqual([{ id: 'z' }]);
  });
});
