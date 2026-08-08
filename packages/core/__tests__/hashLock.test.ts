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
    let releaseA: (() => void) | null = null;

    // Hold HASH_A with a deferred release so we can observe HASH_B entering
    // while HASH_A is still held. If acquireHashLock were globally
    // serialized, HASH_B would be queued behind HASH_A's release and only
    // enter after we resolve releaseA — failing this assertion.
    let aReleased: () => void;
    const holdAPromise = new Promise<void>((resolve) => { aReleased = resolve; });
    const holdA = jm.acquireHashLock('e1', HASH_A).then((release) => {
      order.push(1);
      releaseA = release;
      return holdAPromise;
    });
    // Flush microtasks so HASH_A has actually entered before HASH_B starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);

    const acquireB = jm.acquireHashLock('e1', HASH_B).then((release) => {
      order.push(2);
      return release();
    });
    // Flush microtasks: HASH_B must enter while HASH_A is still held.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    // Now release HASH_A — both holdA and acquireB should settle.
    releaseA!();
    aReleased!();
    await Promise.all([holdA, acquireB]);
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

  it('distinct (entityId, sourceHash) pairs that collide under raw concatenation still produce distinct lock keys', async () => {
    const jm = new JobManager('llm_wiki_');
    // Pairs that collide under `${entityId}${sourceHash}`:
    //   ("ab", "c"*63) and ("a", "b" + "c"*63)
    // both produce the 65-char string "ab" + "c"*63.
    const hashC63 = 'c'.repeat(63);
    const hashB64 = 'b' + 'c'.repeat(63);
    expect(hashC63).toHaveLength(63);
    expect(hashB64).toHaveLength(64);
    // Pre-condition: the raw concatenations really do collide (otherwise the
    // regression test below would be vacuous).
    expect(`ab${hashC63}`).toBe(`a${hashB64}`);

    const key1 = (jm as any)._hashLockKey('ab', hashC63);
    const key2 = (jm as any)._hashLockKey('a', hashB64);
    expect(key1).not.toBe(key2);

    // And behaviorally: holding one lock must not block acquiring the other.
    const order: number[] = [];
    let releaseA: (() => void) | null = null;
    let releaseHolderA: () => void = () => {};
    const holdAPromise = new Promise<void>((resolve) => { releaseHolderA = resolve; });
    const holdA = jm.acquireHashLock('ab', hashC63).then((release) => {
      order.push(1);
      releaseA = release;
      return holdAPromise;
    });
    await Promise.resolve();
    await Promise.resolve();

    const acquireB = jm.acquireHashLock('a', hashB64).then((release) => {
      order.push(2);
      release();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    releaseA!();
    releaseHolderA();
    await Promise.all([holdA, acquireB]);
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
    expect((jm as any).hashLocks.has(`${'e1'}\0${HASH_A}`)).toBe(false);
  });

  it('propagates WikiBusyError from the sourceRef lock and releases the hash lock', async () => {
    const jm = new JobManager('llm_wiki_');
    // Pre-seed an active ingest job for the same (entity, sourceRef) so the
    // synchronous acquireLock will throw.
    jm.acquireLock('ingest', 'e1', 'doc.md');

    await expect(jm.acquireIngestLocks('e1', 'doc.md', HASH_A))
      .rejects.toBeInstanceOf(WikiBusyError);
    // Hash lock must be released despite the failure.
    expect((jm as any).hashLocks.has(`${'e1'}\0${HASH_A}`)).toBe(false);

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
