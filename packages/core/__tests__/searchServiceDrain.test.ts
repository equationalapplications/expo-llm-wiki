import { describe, it, expect, vi } from 'vitest';
import { SearchService } from '../src/services/SearchService';
import type { IndexStrategy } from '../src/services/search/IndexStrategy';
import type { EntryRepository } from '../src/repositories/EntryRepository';

function setup(drainImpl: () => Promise<void> = async () => {}) {
  const repo = { findMiniSearchRows: vi.fn(), findMiniSearchRowsByIds: vi.fn() } as unknown as EntryRepository;
  const strategy: IndexStrategy = {
    replace: vi.fn(), replaceEntity: vi.fn(), replaceAll: vi.fn(), search: vi.fn(async () => []),
    drain: vi.fn(drainImpl),
  };
  const svc = new SearchService(repo, { replace: vi.fn(), replaceEntity: vi.fn(), replaceAll: vi.fn(), search: vi.fn() } as any);
  svc.setIndexStrategy(strategy);
  return { svc, strategy, repo };
}

describe('SearchService in drain mode', () => {
  it('routes every sync path to one drain, never reading rows', async () => {
    const { svc, strategy, repo } = setup();
    svc.markStale('e1');
    await svc.sync();
    await svc.sync('e1');
    await svc.syncEntries('e1', []);
    await svc.syncEntries('e1', ['a', 'b']);
    await svc.syncStale();
    expect(strategy.drain).toHaveBeenCalledTimes(5);
    expect(repo.findMiniSearchRows).not.toHaveBeenCalled();
    expect(repo.findMiniSearchRowsByIds).not.toHaveBeenCalled();
    expect(strategy.replace).not.toHaveBeenCalled();
    expect(strategy.replaceEntity).not.toHaveBeenCalled();
  });

  it('serializes drains on the chain and never rejects', async () => {
    const order: string[] = [];
    let n = 0;
    const { svc } = setup(async () => {
      const k = ++n;
      order.push(`start${k}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end${k}`);
      if (k === 1) throw new Error('boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await Promise.all([svc.sync(), svc.syncEntries('e1', ['x'])]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('evicts the vector cache for the entity on each drain turn', async () => {
    const { svc } = setup();
    const evict = vi.spyOn(svc, 'evictCache');
    await svc.syncEntries('e1', ['a']);
    expect(evict).toHaveBeenCalledWith('e1');
  });
});
