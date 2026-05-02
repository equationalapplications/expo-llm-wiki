import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { WikiProvider, useWiki } from '../src/WikiContext';
import { useMemoryRead } from '../src/useMemoryRead';
import { useWikiWrite } from '../src/useWikiWrite';

/** Minimal mock of WikiMemory */
function makeMockWiki() {
  return {
    read: vi.fn().mockResolvedValue({ entries: [], tasks: [], events: [] }),
    write: vi.fn().mockResolvedValue(undefined),
    ingestDocument: vi.fn().mockResolvedValue({ truncated: false, chunks: 1 }),
    forget: vi.fn().mockResolvedValue(undefined),
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

    expect(wiki.read).toHaveBeenCalledWith('user-1', 'preferences');
    expect(result.current.data).toEqual({ entries: [], tasks: [], events: [] });
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
    expect(wiki.read).toHaveBeenLastCalledWith('user-2', 'q');
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
