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
import type { ReadOptions } from '@equationalapplications/core-llm-wiki';

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
    runHeal: vi.fn().mockResolvedValue(undefined),
    runPrune: vi.fn().mockResolvedValue({ entries: 0, tasks: 0, events: 0 }),
    runReembed: vi.fn().mockResolvedValue({ embedded: 0, skipped: 0 }),
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
    expect(result.current.lastResult).toEqual({ operation: 'heal', result: undefined });
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
    wiki.runReembed.mockResolvedValue({ embedded: 5, skipped: 2 });
    const { result } = renderHook(() => useWikiMaintenance(), { wrapper: wrapper(wiki) });

    await act(async () => { await result.current.runPrune('user-1'); });
    expect(result.current.lastResult?.operation).toBe('prune');

    let reembedResult!: { embedded: number; skipped: number };
    await act(async () => { reembedResult = await result.current.runReembed('user-1'); });

    expect(wiki.runReembed).toHaveBeenCalledWith('user-1');
    expect(reembedResult).toEqual({ embedded: 5, skipped: 2 });
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
