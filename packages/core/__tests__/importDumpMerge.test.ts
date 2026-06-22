import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import type { LLMProvider, WikiFact, WikiTask, WikiEvent } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

const llmProvider: LLMProvider = { generateText: async () => '{}' };

function makeFact(overrides: Partial<WikiFact>): WikiFact {
  const now = Date.now();
  return {
    id: 'f1',
    entity_id: 'user-1',
    title: 'title',
    body: 'body',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WikiTask>): WikiTask {
  const now = Date.now();
  return {
    id: 't1',
    entity_id: 'user-1',
    description: 'description',
    status: 'pending',
    priority: 0,
    created_at: now,
    updated_at: now,
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WikiEvent>): WikiEvent {
  return {
    id: 'e1',
    entity_id: 'user-1',
    event_type: 'observation',
    summary: 'summary',
    related_entry_id: null,
    created_at: Date.now(),
    ...overrides,
  };
}

async function open() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider });
  await wiki.setup();
  return { db, wiki };
}

describe('importDump LWW — facts', () => {
  it('newer incoming overwrites older local', async () => {
    const { wiki } = await open();
    const oldTs = 1000;
    await wiki.importDump({
      generatedAt: oldTs,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'old', updated_at: oldTs })], tasks: [], events: [], edges: [] } },
    });

    const newTs = 2000;
    await wiki.importDump(
      { generatedAt: newTs, entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'new', updated_at: newTs })], tasks: [], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    const f = bundle.facts.find(x => x.id === 'f1');
    expect(f?.body).toBe('new');
    expect(f?.updated_at).toBe(newTs);
  });

  it('older incoming does NOT clobber newer local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'local-new', updated_at: 5000 })], tasks: [], events: [], edges: [] } },
    });

    await wiki.importDump(
      { generatedAt: 1000, entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'remote-old', updated_at: 1000 })], tasks: [], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    const f = bundle.facts.find(x => x.id === 'f1');
    expect(f?.body).toBe('local-new');
    expect(f?.updated_at).toBe(5000);
  });

  it('novel id is inserted in merge mode', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', updated_at: 1000 })], tasks: [], events: [], edges: [] } },
    });

    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [makeFact({ id: 'f2', updated_at: 2000, body: 'novel' })], tasks: [], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.facts.find(x => x.id === 'f1')).toBeTruthy();
    expect(bundle.facts.find(x => x.id === 'f2')?.body).toBe('novel');
  });
});

describe('importDump LWW — tasks', () => {
  it('newer incoming task overwrites older local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'old', updated_at: 1000 })], events: [], edges: [] } },
    });

    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'new', updated_at: 2000 })], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')?.description).toBe('new');
  });

  it('older incoming task does NOT clobber newer local', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'local-new', updated_at: 5000 })], events: [], edges: [] } },
    });

    await wiki.importDump(
      { generatedAt: 1000, entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'remote-old', updated_at: 1000 })], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')?.description).toBe('local-new');
  });

  it('novel task id is inserted in merge mode', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', updated_at: 1000 })], events: [], edges: [] } },
    });

    await wiki.importDump(
      { generatedAt: 2000, entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't2', description: 'novel task', updated_at: 2000 })], events: [], edges: [] } } },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')).toBeTruthy();
    expect(bundle.tasks.find(t => t.id === 't2')?.description).toBe('novel task');
  });
});

describe('importDump non-merge — replace mode', () => {
  it('facts for entity fully replaced when merge is false', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 1000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'old fact', updated_at: 1000 })], tasks: [], events: [], edges: [] } },
    });

    // Non-merge import with different id — old fact should be soft-deleted
    await wiki.importDump({
      generatedAt: 2000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f2', body: 'replacement', updated_at: 2000 })], tasks: [], events: [], edges: [] } },
    });

    const bundle = await wiki.read('user-1', '');
    expect(bundle.facts.find(f => f.id === 'f1')).toBeFalsy();
    expect(bundle.facts.find(f => f.id === 'f2')?.body).toBe('replacement');
  });
});

describe('importDump LWW — invalid updated_at guard', () => {
  it('fact with NaN updated_at does NOT overwrite a valid local row', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [makeFact({ id: 'f1', body: 'local-valid', updated_at: 5000 })], tasks: [], events: [], edges: [] } },
    });

    await wiki.importDump(
      {
        generatedAt: 9999,
        entities: {
          'user-1': {
            facts: [makeFact({ id: 'f1', body: 'incoming-nan', updated_at: NaN as unknown as number })],
            tasks: [],
            events: [], edges: [],
          },
        },
      },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.facts.find(f => f.id === 'f1')?.body).toBe('local-valid');
  });

  it('task with NaN updated_at does NOT overwrite a valid local row', async () => {
    const { wiki } = await open();
    await wiki.importDump({
      generatedAt: 5000,
      entities: { 'user-1': { facts: [], tasks: [makeTask({ id: 't1', description: 'local-valid', updated_at: 5000 })], events: [], edges: [] } },
    });

    await wiki.importDump(
      {
        generatedAt: 9999,
        entities: {
          'user-1': {
            facts: [],
            tasks: [makeTask({ id: 't1', description: 'incoming-nan', updated_at: NaN as unknown as number })],
            events: [], edges: [],
          },
        },
      },
      { merge: true }
    );

    const bundle = await wiki.read('user-1', '');
    expect(bundle.tasks.find(t => t.id === 't1')?.description).toBe('local-valid');
  });

  it('new fact with NaN updated_at is inserted with updated_at=0 (not NaN)', async () => {
    const { db, wiki } = await open();
    const prefix = 'llm_wiki_';
    await wiki.importDump({
      generatedAt: 9999,
      entities: {
        'user-1': {
          facts: [makeFact({ id: 'f-nan', body: 'new-nan', updated_at: NaN as unknown as number })],
          tasks: [],
          events: [], edges: [],
        },
      },
    });

    const row = await db.getFirstAsync<{ updated_at: number }>(
      `SELECT updated_at FROM ${prefix}entries WHERE id = ?`,
      ['f-nan']
    );
    expect(row).not.toBeNull();
    expect(Number.isFinite(row!.updated_at)).toBe(true);
    expect(row!.updated_at).toBe(0);
  });

  it('new task with NaN updated_at is inserted with updated_at=0 (not NaN)', async () => {
    const { db, wiki } = await open();
    const prefix = 'llm_wiki_';
    await wiki.importDump({
      generatedAt: 9999,
      entities: {
        'user-1': {
          facts: [],
          tasks: [makeTask({ id: 't-nan', description: 'new-nan', updated_at: NaN as unknown as number })],
          events: [], edges: [],
        },
      },
    });

    const row = await db.getFirstAsync<{ updated_at: number }>(
      `SELECT updated_at FROM ${prefix}tasks WHERE id = ?`,
      ['t-nan']
    );
    expect(row).not.toBeNull();
    expect(Number.isFinite(row!.updated_at)).toBe(true);
    expect(row!.updated_at).toBe(0);
  });
});

describe('importDump LWW — events append-only', () => {
  it('duplicate event id is skipped, novel id is inserted', async () => {
    const { db, wiki } = await open();
    const prefix = 'llm_wiki_';
    const ts = Date.now();

    await wiki.importDump({
      generatedAt: ts,
      entities: { 'user-1': { facts: [], tasks: [], events: [makeEvent({ id: 'e1', summary: 'original' })], edges: [] } },
    });

    await wiki.importDump(
      {
        generatedAt: ts + 1000,
        entities: {
          'user-1': {
            facts: [],
            tasks: [],
            events: [
              makeEvent({ id: 'e1', summary: 'should be ignored' }),
              makeEvent({ id: 'e2', summary: 'novel' }),
            ],
            edges: [],
          },
        },
      },
      { merge: true }
    );

    const rows = await db.getAllAsync<{ id: string; summary: string }>(
      `SELECT id, summary FROM ${prefix}events WHERE entity_id = ? ORDER BY id`,
      ['user-1']
    );
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.id === 'e1')?.summary).toBe('original');
    expect(rows.find(r => r.id === 'e2')?.summary).toBe('novel');
  });
});
