import { describe, it, expect } from 'vitest';
import { JobManager } from '../src/services/JobManager';
import { WikiBusyError } from '../src/types';

const E = 'entity-a';

function busyOp(fn: () => void): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof WikiBusyError) return err.operation;
    throw err;
  }
  return null;
}

describe('JobManager — store operation lock (spec §10)', () => {
  it.each(['prune', 'forget', 'librarian', 'heal', 'ontologyBackfill', 'reembed', 'import'] as const)(
    'store throws WikiBusyError while %s is active on the same entity',
    (op) => {
      const jm = new JobManager('t');
      jm.acquireLock(op, E);
      expect(() => jm.acquireLock('store', E)).toThrow(WikiBusyError);
      expect(busyOp(() => jm.acquireLock('store', E))).toBe(op);
      expect(jm.isBlocked('store', E)).toBe(true);
    },
  );

  it.each(['prune', 'forget', 'librarian', 'heal', 'ontologyBackfill', 'reembed', 'import'] as const)(
    '%s throws WikiBusyError while a store is active (reverse direction)',
    (op) => {
      const jm = new JobManager('t');
      jm.acquireLock('store', E);
      expect(() => jm.acquireLock(op, E)).toThrow(WikiBusyError);
      expect(busyOp(() => jm.acquireLock(op, E))).toBe('store');
      expect(jm.isBlocked(op, E)).toBe(true);
    },
  );

  it('ingest throws while a store is active, and store throws while ingest is active', () => {
    const jm = new JobManager('t');
    jm.acquireLock('store', E);
    expect(busyOp(() => jm.acquireLock('ingest', E, 'ref-1'))).toBe('store');
    jm.releaseLock('store', E);

    jm.acquireLock('ingest', E, 'ref-1');
    expect(busyOp(() => jm.acquireLock('store', E))).toBe('ingest');
  });

  it('global_reembed and global_import are blocked by an active store', () => {
    const jm = new JobManager('t');
    jm.acquireLock('store', E);
    expect(busyOp(() => jm.acquireLock('global_reembed', '*'))).toBe('store');
    expect(busyOp(() => jm.acquireLock('global_import', '*'))).toBe('store');
    expect(() => jm.acquireImportLocks([E])).toThrow(WikiBusyError);
  });

  it('store is blocked by a global import', () => {
    const jm = new JobManager('t');
    jm.acquireLock('global_import', '*');
    expect(() => jm.acquireLock('store', E)).toThrow(WikiBusyError);
  });

  it('two concurrent stores on the same entity: the second throws', () => {
    const jm = new JobManager('t');
    jm.acquireLock('store', E);
    expect(busyOp(() => jm.acquireLock('store', E))).toBe('store');
  });

  it('after releaseLock("store"), a second store succeeds', () => {
    const jm = new JobManager('t');
    jm.acquireLock('store', E);
    jm.releaseLock('store', E);
    expect(() => jm.acquireLock('store', E)).not.toThrow();
    expect(jm.isBlocked('prune', E)).toBe(true);
    jm.releaseLock('store', E);
    expect(jm.isBlocked('prune', E)).toBe(false);
  });

  it('stores on different entities do not conflict', () => {
    const jm = new JobManager('t');
    jm.acquireLock('store', 'entity-a');
    expect(() => jm.acquireLock('store', 'entity-b')).not.toThrow();
    expect(() => jm.acquireLock('prune', 'entity-b')).toThrow(WikiBusyError);
    expect(() => jm.acquireLock('prune', 'entity-c')).not.toThrow();
  });
});
