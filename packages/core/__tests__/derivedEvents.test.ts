/**
 * specs/inplace-update-provenance — derived_events on librarian facts.
 * Tests are added task by task; see the spec's test plan numbering.
 */
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import type { WikiFact } from '../src/types';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { addDerivedEventsColumn } from '../src/db/migrations';
import {
  parseStoredDerivedEvents, validateDerivedEventsValue, serializeDerivedEvents, dedupeEventIds,
} from '../src/utils/derivedEvents';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

async function cols(db: any): Promise<string[]> {
  return (await db.getAllAsync(`PRAGMA table_info(${P}entries)`)).map((c: any) => c.name);
}

describe('test 1: schema v18', () => {
  it('fresh store has the column and stamps the current version (18)', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(18);
    const db = openTestDatabase();
    await new WikiMemory(db, { llmProvider: llm } as any).setup();
    expect(await cols(db)).toContain('derived_events');
    const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key='schema_version'`);
    expect(row!.value).toBe('18');
  });

  it('migrates a v17 store by ALTER and is idempotent (helper and setup)', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: llm } as any);
    await wiki.setup();
    await db.execAsync(`ALTER TABLE ${P}entries DROP COLUMN derived_events`);
    await db.runAsync(`UPDATE ${P}meta SET value='17' WHERE key='schema_version'`);
    await wiki.setup();
    expect(await cols(db)).toContain('derived_events');
    await addDerivedEventsColumn(db as any, P);
    await addDerivedEventsColumn(db as any, P);
    expect((await cols(db)).filter((c) => c === 'derived_events')).toHaveLength(1);
  });
});

describe('test 8 (helper level): derived_events parsing', () => {
  it('tolerates malformed stored values', () => {
    expect(parseStoredDerivedEvents(null)).toBeNull();
    expect(parseStoredDerivedEvents('not json')).toBeNull();
    expect(parseStoredDerivedEvents('{"a":1}')).toBeNull();
    expect(parseStoredDerivedEvents('[1,2]')).toBeNull();
    expect(parseStoredDerivedEvents('[""]')).toBeNull();
    expect(parseStoredDerivedEvents('[]')).toBeNull();
    expect(parseStoredDerivedEvents('["E1","E2","E1"]')).toEqual(['E1', 'E2']);
  });
  it('validates import values exactly', () => {
    expect(validateDerivedEventsValue(null)).toBeNull();
    expect(validateDerivedEventsValue(['a'])).toEqual(['a']);
    expect(validateDerivedEventsValue('a')).toBeUndefined();
    expect(validateDerivedEventsValue([1])).toBeUndefined();
    expect(validateDerivedEventsValue([''])).toBeUndefined();
  });
  it('serializes and dedupes', () => {
    expect(serializeDerivedEvents([])).toBeNull();
    expect(serializeDerivedEvents(['a'])).toBe('["a"]');
    expect(dedupeEventIds(['a', null, 'b', 'a', undefined, ''])).toEqual(['a', 'b']);
  });
});

function mkFact(over: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'F', entity_id: 'u', title: 't', body: 'b', tags: [], confidence: 'inferred',
    source_type: 'librarian_inferred', source_hash: null, source_ref: null,
    created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null,
    ...over,
  } as WikiFact;
}

async function repoSetup() {
  const db = openTestDatabase();
  await new WikiMemory(db, { llmProvider: llm, config: { enableOutbox: true } } as any).setup();
  const repo = new EntryRepository(db, P, new OutboxRepository(db, P, true));
  const raw = async (id: string) =>
    (await db.getFirstAsync<{ derived_events: string | null }>(`SELECT derived_events FROM ${P}entries WHERE id = ?`, [id]))!.derived_events;
  return { db, repo, raw };
}

describe('task 2: repository read/write of derived_events', () => {
  it('upsert persists the list, the mapper reads it, and a malformed stored value reads as absent', async () => {
    const { db, repo, raw } = await repoSetup();
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ derived_events: ['E2', 'E3'] }), tx));
    expect(await raw('F')).toBe('["E2","E3"]');
    expect((await repo.findByIds(['F']))[0]?.derived_events).toEqual(['E2', 'E3']);
    await db.runAsync(`UPDATE ${P}entries SET derived_events = 'not json' WHERE id = 'F'`);
    const f = (await repo.findByIds(['F']))[0];
    expect(f).toBeTruthy();
    expect('derived_events' in f!).toBe(false);
  });

  it('upsert with the key absent leaves a stored list untouched; with the key present it replaces it', async () => {
    const { db, repo, raw } = await repoSetup();
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ derived_events: ['E2'] }), tx));
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ title: 'new' }), tx));
    expect(await raw('F')).toBe('["E2"]');
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ derived_events: ['E2', 'E4'] }), tx));
    expect(await raw('F')).toBe('["E2","E4"]');
  });

  it('test 13: the outbox payload carries the list (written, and preserved when key absent)', async () => {
    const { db, repo } = await repoSetup();
    const payloads = async () =>
      (await db.getAllAsync<{ payload: string }>(`SELECT payload FROM ${P}outbox WHERE table_name='entries' ORDER BY rowid`)).map((r) => JSON.parse(r.payload));
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ derived_events: ['E2'] }), tx));
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ title: 'again' }), tx));
    const ps = await payloads();
    expect(ps[0].derived_events).toEqual(['E2']);
    expect(ps[1].derived_events).toEqual(['E2']);
  });

  it('upsertForImport: presence flag false never nulls a stored list (pre-v18 dump); true replaces it, including with null', async () => {
    const { db, repo, raw } = await repoSetup();
    await db.withTransactionAsync((tx) => repo.upsert(mkFact({ derived_events: ['E2'] }), tx));
    await db.withTransactionAsync((tx) => repo.upsertForImport(mkFact({ title: 'imp' }), tx, false, false));
    expect(await raw('F')).toBe('["E2"]');
    await db.withTransactionAsync((tx) => repo.upsertForImport(mkFact({ derived_events: ['E9'] }), tx, false, true));
    expect(await raw('F')).toBe('["E9"]');
    await db.withTransactionAsync((tx) => repo.upsertForImport(mkFact({}), tx, false, true));
    expect(await raw('F')).toBeNull();
  });
});

describe('tests 7-9: forget({ eventId }) matches derived_events', () => {
  async function make() {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: llm, config: { enableOutbox: true } } as any);
    await wiki.setup();
    const ins = (entityId: string, id: string, pointer: string | null, derived: string | null) =>
      db.runAsync(
        `INSERT INTO ${P}entries (id, entity_id, title, body, source_ref, source_pointer, derived_events, created_at, updated_at) VALUES (?, ?, 't', 'b', 'doc', ?, ?, 1, 1)`,
        [id, entityId, pointer, derived],
      );
    const live = async (id: string) =>
      (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries WHERE id = ? AND deleted_at IS NULL`, [id]))!.n;
    return { db, wiki, ins, live };
  }
  const ptr = (e: string) => JSON.stringify({ event_id: e });

  it('test 7: a fact whose list names E2 is soft-deleted whole (pointer E1), with an outbox DELETE; siblings behave as before; dryRun counts it', async () => {
    const t = await make();
    await t.ins('u', 'F', ptr('E1'), '["E2"]');
    await t.ins('u', 'sibPtr', ptr('E2'), null);
    await t.ins('u', 'sibNone', ptr('E5'), '["E6"]');
    const dry = await t.wiki.forget('u', { eventId: 'E2' }, { dryRun: true });
    expect(dry).toEqual({ deleted: { entries: 2, tasks: 0 } });
    expect(await t.live('F')).toBe(1);
    const res = await t.wiki.forget('u', { eventId: 'E2' });
    expect(res.deleted.entries).toBe(2);
    expect(await t.live('F')).toBe(0);
    expect(await t.live('sibPtr')).toBe(0);
    expect(await t.live('sibNone')).toBe(1);
    const del = await t.db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${P}outbox WHERE operation='DELETE' AND table_name='entries' AND record_id='F'`);
    expect(del!.n).toBe(1);
  });

  it('test 8: malformed derived_events (text, object, scalar, nested, mixed) neither matches nor throws, through enumerate, dryRun and delete', async () => {
    const t = await make();
    await t.ins('u', 'junk', null, 'not json at all');
    await t.ins('u', 'obj', null, '{"0":"E2","k":"E2"}');
    await t.ins('u', 'str', null, '"E2"');
    await t.ins('u', 'num', null, '[2]');
    await t.ins('u', 'nested', null, '[["E2"]]');
    await t.ins('u', 'empty', null, '');
    await t.ins('u', 'badPtrGoodList', 'garbage{', '["E2"]');
    await t.ins('u', 'goodPtrBadList', ptr('E2'), 'garbage{');
    const dry = await t.wiki.forget('u', { eventId: 'E2' }, { dryRun: true });
    expect(dry.deleted.entries).toBe(2);
    const res = await t.wiki.forget('u', { eventId: 'E2' });
    expect(res.deleted.entries).toBe(2);
    for (const id of ['junk', 'obj', 'str', 'num', 'nested', 'empty']) expect(await t.live(id)).toBe(1);
    expect(await t.live('badPtrGoodList')).toBe(0);
    expect(await t.live('goodPtrBadList')).toBe(0);
    // Idempotent over tombstones.
    expect((await t.wiki.forget('u', { eventId: 'E2' })).deleted.entries).toBe(0);
  });

  it('test 9: entity isolation: entity B\'s fact listing E2 survives forget(A, { eventId })', async () => {
    const t = await make();
    await t.ins('A', 'a', null, '["E2"]');
    await t.ins('B', 'b', null, '["E2"]');
    await t.wiki.forget('A', { eventId: 'E2' });
    expect(await t.live('a')).toBe(0);
    expect(await t.live('b')).toBe(1);
  });
});
