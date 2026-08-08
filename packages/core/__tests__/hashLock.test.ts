import { describe, it, expect } from 'vitest';
import { JobManager } from '../src/services/JobManager';
import { WikiBusyError } from '../src/types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('JobManager.acquireHashLock', () => {
  it('serializes concurrent callers for one (entityId, sourceHash) in FIFO order', async () => {
    const jm = new JobManager('llm_wiki_');
    const order: number[] = [];
    const blockers: Array<() => void> = [];

    // Two callers acquire the same hash key. Each caller, once it holds the
    // lock, pushes its id and then blocks on its own deferred resolver so we
    // can step them deterministically: caller 1 must enter and register
    // before caller 2 is allowed to enter.
    const acquire = (id: number) => jm.acquireHashLock('e1', HASH_A).then((release) => {
      order.push(id);
      return new Promise<void>((resolve) => {
        blockers.push(() => {
          release();
          resolve();
        });
      });
    });

    const c1 = acquire(1);
    const c2 = acquire(2);

    // Flush microtasks: caller 1's lock resolves immediately (nothing
    // queued ahead of it), so it should have entered and registered.
    // Caller 2's lock is chained behind caller 1's pending release and
    // must NOT have entered yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);

    // Release caller 1 (its own deferred + the hash lock); caller 2 can
    // now acquire and register.
    blockers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    // Release caller 2 so both promises settle.
    blockers[1]();
    await c1;
    await c2;
  });

  it('does not block different hashes for the same entity', async () => {
    const jm = new JobManager('llm_wiki_');
    const order: number[] = [];

    const acquire = (hash: string, id: number) =>
      jm.acquireHashLock('e1', hash).then((release) => {
        order.push(id);
        return release();
      });

    // Interleave the calls. Different keys must run without serializing.
    await Promise.all([acquire(HASH_A, 1), acquire(HASH_B, 2), acquire(HASH_A, 3), acquire(HASH_B, 4)]);
    // FIFO per-key but no cross-key ordering — at minimum both keys advanced.
    expect(order).toContain(1);
    expect(order).toContain(2);
    expect(order.length).toBe(4);
  });

  it('isolates the lock by entityId (same hash, different entities does not block)', async () => {
    const jm = new JobManager('llm_wiki_');
    const order: string[] = [];

    const acquire = (entity: string) =>
      jm.acquireHashLock(entity, HASH_A).then((release) => {
        order.push(entity);
        release();
      });

    await Promise.all([acquire('e1'), acquire('e2'), acquire('e1'), acquire('e2')]);
    expect(order.filter((e) => e === 'e1')).toHaveLength(2);
    expect(order.filter((e) => e === 'e2')).toHaveLength(2);
  });

  it('release closure is idempotent (calling twice is a no-op)', async () => {
    const jm = new JobManager('llm_wiki_');
    const release = await jm.acquireHashLock('e1', HASH_A);
    release();
    release(); // must not throw
    // After release, a fresh acquire for the same key must succeed immediately.
    const release2 = await jm.acquireHashLock('e1', HASH_A);
    expect(typeof release2).toBe('function');
    release2();
  });
});

describe('JobManager.acquireIngestLocks', () => {
  it('acquires hash then sourceRef, releases sourceRef then hash on the combined closure', async () => {
    const jm = new JobManager('llm_wiki_');
    const order: string[] = [];
    const originalReleaseLock = jm.releaseLock.bind(jm);
    jm.releaseLock = ((op: any, eid: any, sref?: any) => {
      order.push(`release:${op}:${eid}:${sref ?? ''}`);
      return originalReleaseLock(op, eid, sref);
    }) as any;
    const origAcquireHash = jm.acquireHashLock.bind(jm);
    jm.acquireHashLock = ((eid: any, h: any) => {
      order.push(`acquireHash:${eid}`);
      return origAcquireHash(eid, h);
    }) as any;

    const release = await jm.acquireIngestLocks('e1', 'doc.md', HASH_A);
    // hash lock acquired before we returned
    expect(order).toContain('acquireHash:e1');
    // release should release sourceRef then hash
    release();
    expect(order).toEqual([
      'acquireHash:e1',
      'release:ingest:e1:doc.md',
      // hash release is internal — observable via _hashLockKey check below
    ]);
    // After release, the hash map entry for (e1, HASH_A) should be gone.
    expect((jm as any).hashLocks.has(`${'e1'}${HASH_A}`)).toBe(false);
  });

  it('propagates WikiBusyError from the sourceRef lock and releases the hash lock', async () => {
    const jm = new JobManager('llm_wiki_');
    // Pre-seed an active ingest job for the same (entity, sourceRef) so the
    // synchronous acquireLock will throw.
    jm.acquireLock('ingest', 'e1', 'doc.md');

    await expect(jm.acquireIngestLocks('e1', 'doc.md', HASH_A))
      .rejects.toBeInstanceOf(WikiBusyError);
    // Hash lock must be released despite the failure.
    expect((jm as any).hashLocks.has(`${'e1'}${HASH_A}`)).toBe(false);

    jm.releaseLock('ingest', 'e1', 'doc.md');
  });

  it('different (entity, hash) combinations ingest independently', async () => {
    const jm = new JobManager('llm_wiki_');
    const r1 = await jm.acquireIngestLocks('e1', 'a.md', HASH_A);
    const r2 = await jm.acquireIngestLocks('e1', 'b.md', HASH_B);
    const r3 = await jm.acquireIngestLocks('e2', 'a.md', HASH_A);
    r1(); r2(); r3();
    expect((jm as any).activeIngestJobs.size).toBe(0);
    expect((jm as any).hashLocks.size).toBe(0);
  });
});
