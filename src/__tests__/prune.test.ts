import { describe, it, expect, vi } from 'vitest';

type EntryRow = {
  id: string;
  entity_id: string;
  source_ref: string | null;
  source_hash: string | null;
  deleted_at: number | null;
  updated_at: number;
  title: string;
  body: string;
  tags: string;
};

type TaskRow = {
  id: string;
  entity_id: string;
  description: string;
  deleted_at: number | null;
};

type EventRow = {
  id: string;
  entity_id: string;
  event_type: string;
  summary: string;
  created_at: number;
};

function makeMockDb(opts: {
  entries?: EntryRow[];
  tasks?: TaskRow[];
  events?: EventRow[];
  hasPorter?: boolean;
} = {}) {
  let entries: EntryRow[] = opts.entries ? [...opts.entries] : [];
  let tasks: TaskRow[] = opts.tasks ? [...opts.tasks] : [];
  let events: EventRow[] = opts.events ? [...opts.events] : [];
  const { hasPorter = true } = opts;

  const pragmaAndVacuumCalls: string[] = [];

  const db = {
    pragmaAndVacuumCalls,
    getEntries: () => entries,
    getTasks: () => tasks,
    getEvents: () => events,
    async execAsync(sql: string): Promise<void> {
      pragmaAndVacuumCalls.push(sql);
    },
    async runAsync(sql: string, args: any[] = []): Promise<{ changes: number }> {
      // Hard delete entries
      if (sql.includes('DELETE FROM') && sql.includes('entries') && !sql.includes('fts') && !sql.includes('events') && !sql.includes('tasks')) {
        const entityId = args[0];
        const cutoff = args[1];
        const before = entries.length;
        entries = entries.filter(e => !(e.entity_id === entityId && e.deleted_at !== null && e.deleted_at < cutoff));
        return { changes: before - entries.length };
      }
      // Hard delete tasks
      if (sql.includes('DELETE FROM') && sql.includes('tasks')) {
        const entityId = args[0];
        const cutoff = args[1];
        const before = tasks.length;
        tasks = tasks.filter(t => !(t.entity_id === entityId && t.deleted_at !== null && t.deleted_at < cutoff));
        return { changes: before - tasks.length };
      }
      // Hard delete events
      if (sql.includes('DELETE FROM') && sql.includes('events')) {
        const entityId = args[0];
        const cutoff = args[1];
        const before = events.length;
        events = events.filter(e => !(e.entity_id === entityId && e.created_at < cutoff));
        return { changes: before - events.length };
      }
      return { changes: 0 };
    },
    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      if (sql.includes('schema_version')) return { value: '1' } as any;
      if (sql.includes('sqlite_master') && !sql.includes('fts')) return { name: 'llm_wiki_entries' } as any;
      if (sql.includes('sqlite_master') && sql.includes('fts')) {
        if (hasPorter) return { sql: `tokenize='porter unicode61'` } as any;
        return null;
      }
      // Count deleted entries
      if (sql.includes('COUNT') && sql.includes('entries') && sql.includes('deleted_at IS NOT NULL')) {
        const entityId = args[0];
        const cutoff = args[1];
        const count = entries.filter(e => e.entity_id === entityId && e.deleted_at !== null && e.deleted_at < cutoff).length;
        return { count } as any;
      }
      // Count deleted tasks
      if (sql.includes('COUNT') && sql.includes('tasks') && sql.includes('deleted_at IS NOT NULL')) {
        const entityId = args[0];
        const cutoff = args[1];
        const count = tasks.filter(t => t.entity_id === entityId && t.deleted_at !== null && t.deleted_at < cutoff).length;
        return { count } as any;
      }
      // Count old events
      if (sql.includes('COUNT') && sql.includes('events')) {
        const entityId = args[0];
        const cutoff = args[1];
        const count = events.filter(e => e.entity_id === entityId && e.created_at < cutoff).length;
        return { count } as any;
      }
      return null;
    },
    async getAllAsync<T>(_sql: string, _args: any[] = []): Promise<T[]> {
      return [];
    },
    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      await fn();
    },
  };

  return db;
}

vi.mock('expo-sqlite', () => ({ default: {} }));

import { WikiMemory } from '@eq/wiki-core';
import { WikiBusyError } from '@eq/wiki-core';
import type { WikiOptions } from '@eq/wiki-core';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const now = Date.now();
const EIGHT_DAYS_AGO = now - 8 * 86400000;
const THREE_DAYS_AGO = now - 3 * 86400000;
const THIRTY_ONE_DAYS_AGO = now - 31 * 86400000;

describe('WikiMemory.runPrune', () => {
  it('hard-deletes soft-deleted entries older than retainSoftDeletedFor threshold', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: EIGHT_DAYS_AGO, title: 'Old', body: '', tags: '[]' },
        { id: 'e2', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: THREE_DAYS_AGO, updated_at: THREE_DAYS_AGO, title: 'Recent', body: '', tags: '[]' },
        { id: 'e3', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: null, updated_at: now, title: 'Active', body: '', tags: '[]' },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: 7, retainEventsFor: null });
    const ids = db.getEntries().map(e => e.id);
    expect(ids).not.toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('e3');
  });

  it('hard-deletes soft-deleted tasks older than threshold', async () => {
    const db = makeMockDb({
      tasks: [
        { id: 't1', entity_id: 'ent', description: 'Old task', deleted_at: EIGHT_DAYS_AGO },
        { id: 't2', entity_id: 'ent', description: 'Recent task', deleted_at: THREE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: 7, retainEventsFor: null });
    const ids = db.getTasks().map(t => t.id);
    expect(ids).not.toContain('t1');
    expect(ids).toContain('t2');
  });

  it('hard-deletes events older than retainEventsFor threshold', async () => {
    const db = makeMockDb({
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: 'Old', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev2', entity_id: 'ent', event_type: 'observation', summary: 'Recent', created_at: THREE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: 30 });
    const ids = db.getEvents().map(e => e.id);
    expect(ids).not.toContain('ev1');
    expect(ids).toContain('ev2');
  });

  it('skips entry/task prune when retainSoftDeletedFor is null', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: EIGHT_DAYS_AGO, title: 'Old', body: '', tags: '[]' },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null });
    expect(db.getEntries()).toHaveLength(1); // not deleted
  });

  it('skips event prune when retainEventsFor is null', async () => {
    const db = makeMockDb({
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: 'Old', created_at: THIRTY_ONE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null });
    expect(db.getEvents()).toHaveLength(1);
  });

  it('calls VACUUM when vacuum=true', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });
    const hasVacuum = db.pragmaAndVacuumCalls.some(s => s.toUpperCase().includes('VACUUM'));
    expect(hasVacuum).toBe(true);
  });

  it('does not call VACUUM when vacuum=false (default)', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null });
    const hasVacuum = db.pragmaAndVacuumCalls.some(s => s.toUpperCase().includes('VACUUM'));
    expect(hasVacuum).toBe(false);
  });

  it('throws WikiBusyError when prune is already running', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);

    let resolveFirst!: () => void;
    const firstPruneBlock = new Promise<void>(resolve => { resolveFirst = resolve; });

    // Patch db to block the first prune
    const origExec = db.execAsync.bind(db);
    let blocked = false;
    db.execAsync = async (sql: string) => {
      if (!blocked && sql.toUpperCase().includes('VACUUM')) {
        blocked = true;
        await firstPruneBlock;
      }
      return origExec(sql);
    };

    // Start first prune (vacuum=true so it blocks on execAsync)
    const first = wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null, vacuum: true });

    // Give microtask queue time to enter the prune
    await new Promise(r => setTimeout(r, 0));

    // Second prune should throw
    await expect(wiki.runPrune('ent', { retainSoftDeletedFor: null, retainEventsFor: null })).rejects.toThrow(WikiBusyError);

    // Unblock first
    resolveFirst();
    await first;
  });

  it('returns correct counts', async () => {
    const db = makeMockDb({
      entries: [
        { id: 'e1', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: EIGHT_DAYS_AGO, title: 'A', body: '', tags: '[]' },
        { id: 'e2', entity_id: 'ent', source_ref: null, source_hash: null, deleted_at: EIGHT_DAYS_AGO, updated_at: EIGHT_DAYS_AGO, title: 'B', body: '', tags: '[]' },
      ],
      tasks: [
        { id: 't1', entity_id: 'ent', description: 'Task', deleted_at: EIGHT_DAYS_AGO },
      ],
      events: [
        { id: 'ev1', entity_id: 'ent', event_type: 'observation', summary: 'A', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev2', entity_id: 'ent', event_type: 'observation', summary: 'B', created_at: THIRTY_ONE_DAYS_AGO },
        { id: 'ev3', entity_id: 'ent', event_type: 'observation', summary: 'C', created_at: THIRTY_ONE_DAYS_AGO },
      ],
    });
    const wiki = new WikiMemory(db as any, stubOptions);
    const result = await wiki.runPrune('ent', { retainSoftDeletedFor: 7, retainEventsFor: 30 });
    expect(result.entries).toBe(2);
    expect(result.tasks).toBe(1);
    expect(result.events).toBe(3);
  });

  it('throws WikiBusyError when librarian is already running', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:ent:librarian');
    const err = await wiki.runPrune('ent').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('librarian');
  });

  it('throws WikiBusyError when heal is already running', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    (wiki as any).activeMaintenanceJobs.add('llm_wiki_:ent:heal');
    const err = await wiki.runPrune('ent').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('heal');
  });

  it('throws WikiBusyError when ingest is already running for same entity', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    (wiki as any).activeIngestJobs.add('llm_wiki_:ent:doc.md');
    const err = await wiki.runPrune('ent').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('ingest');
  });

  it('throws when retainSoftDeletedFor is negative', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.runPrune('ent', { retainSoftDeletedFor: -1 })).rejects.toThrow('retainSoftDeletedFor');
  });

  it('throws when retainSoftDeletedFor is Infinity', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.runPrune('ent', { retainSoftDeletedFor: Infinity })).rejects.toThrow('retainSoftDeletedFor');
  });

  it('throws when retainEventsFor is negative', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.runPrune('ent', { retainEventsFor: -7 })).rejects.toThrow('retainEventsFor');
  });

  it('throws when retainEventsFor is NaN', async () => {
    const db = makeMockDb({});
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.runPrune('ent', { retainEventsFor: NaN })).rejects.toThrow('retainEventsFor');
  });
});
