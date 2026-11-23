import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import { openTestDatabase } from './helpers/sqliteAdapter';

async function source() {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
  await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('old', 'u', 'Seattle', 'b', 1, 1)`);
  const { newId } = await wiki.supersede('u', 'old', { title: 'SF', body: 'b' }, { validFrom: 500 });
  await wiki.write('u', { event_type: 'observation', summary: 's', occurred_at: 42 });
  return { wiki, newId };
}

describe('temporal round-trip', () => {
  it('exportDump → importDump preserves temporal fields and event occurred_at', async () => {
    const { wiki, newId } = await source();
    const dump = await wiki.exportDump(['u']);
    const db2 = openTestDatabase();
    const w2 = new WikiMemory(db2, { llmProvider: { generateText: async () => '{}' } });
    await w2.setup();
    await w2.importDump(dump);
    const old = await db2.getFirstAsync<any>(`SELECT valid_to, superseded_by FROM llm_wiki_entries WHERE id='old'`);
    expect(old).toEqual({ valid_to: 500, superseded_by: newId });
    expect((await w2.history('u', 'old')).map((f) => f.id)).toEqual(['old', newId]);
    const ev = await db2.getFirstAsync<any>(`SELECT occurred_at FROM llm_wiki_events`);
    expect(ev.occurred_at).toBe(42);
  });

  it('import clears temporal fields absent from the dump (replace semantics)', async () => {
    const { wiki } = await source();
    const dump = await wiki.exportDump(['u']);
    const f = dump.entities.u.facts.find((x) => x.id === 'old')!;
    delete f.valid_to; delete f.superseded_by; delete f.superseded_at;
    await wiki.importDump(dump);
    const row = await (wiki as any).db.getFirstAsync(`SELECT valid_to, superseded_by FROM llm_wiki_entries WHERE id='old'`);
    expect(row).toEqual({ valid_to: null, superseded_by: null });
  });

  it('OKF v2 export/parse carries the four keys', async () => {
    const { wiki, newId } = await source();
    const bundle = await wiki.exportDump(['u']);
    const { files } = formatOkfBundle(bundle);
    const parsed = parseOkfBundle('u', files);
    const facts = parsed.entities.u.facts;
    const old = facts.find((x) => x.id === 'old');
    expect(old).toMatchObject({ valid_to: 500, superseded_by: newId });
    expect(typeof old!.superseded_at).toBe('number');
    expect(facts.find((x) => x.id === newId)).toMatchObject({ valid_from: 500 });
  });
});

describe('prior_valid_to round-trip (specs/supersede-future-valid-to D5)', () => {
  const FUTURE = Date.now() + 30 * 86_400_000;
  const opts = { llmProvider: { generateText: async () => '{}' } };

  async function scheduledSource() {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, opts);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, created_at, updated_at) VALUES ('old', 'u', 'Seattle', 'b', 1, 1)`);
    await wiki.expire('u', 'old', { at: FUTURE });
    const { newId } = await wiki.supersede('u', 'old', { title: 'SF', body: 'b' }, { validFrom: 500 });
    return { db, wiki, newId };
  }
  const prior = async (db: any, id = 'old') =>
    (await db.getFirstAsync(`SELECT prior_valid_to FROM llm_wiki_entries WHERE id='${id}'`)).prior_valid_to;

  it('exportDump carries it; importDump into a fresh store preserves it', async () => {
    const { wiki } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    expect(dump.entities.u.facts.find((f) => f.id === 'old')!.prior_valid_to).toBe(FUTURE);
    const db2 = openTestDatabase();
    const w2 = new WikiMemory(db2, opts);
    await w2.setup();
    await w2.importDump(dump);
    expect(await prior(db2)).toBe(FUTURE);
  });

  it('an open-ended fact exports without the key', async () => {
    const { wiki, newId } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    expect('prior_valid_to' in dump.entities.u.facts.find((f) => f.id === newId)!).toBe(false);
  });

  it('a pre-v18 dump (key absent) never nulls a stored value on a superseded fact', async () => {
    const { db, wiki } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    delete (dump.entities.u.facts.find((f) => f.id === 'old') as any).prior_valid_to;
    await wiki.importDump(dump);
    expect(await prior(db)).toBe(FUTURE);
  });

  it('an explicit null in the dump clears; a present value replaces', async () => {
    const { db, wiki } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    const f = dump.entities.u.facts.find((x) => x.id === 'old')!;
    f.prior_valid_to = null;
    await wiki.importDump(dump);
    expect(await prior(db)).toBeNull();
    f.prior_valid_to = 123_456;
    await wiki.importDump(dump);
    expect(await prior(db)).toBe(123_456);
  });

  it('an un-superseded fact in the dump clears a stale stored value', async () => {
    const { db, wiki } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    const f = dump.entities.u.facts.find((x) => x.id === 'old')!;
    delete f.superseded_by; delete f.superseded_at; delete f.prior_valid_to;
    await wiki.importDump(dump);
    expect(await prior(db)).toBeNull();
  });

  it('OKF format -> parse preserves it, and import of the parsed bundle stores it', async () => {
    const { wiki } = await scheduledSource();
    const bundle = await wiki.exportDump(['u']);
    const { files } = formatOkfBundle(bundle);
    const parsed = parseOkfBundle('u', files);
    expect(parsed.entities.u.facts.find((x) => x.id === 'old')!.prior_valid_to).toBe(FUTURE);
    expect('prior_valid_to' in parsed.entities.u.facts.find((x) => x.id !== 'old')!).toBe(false);
    const db2 = openTestDatabase();
    const w2 = new WikiMemory(db2, opts);
    await w2.setup();
    await w2.importDump(parsed);
    expect(await prior(db2)).toBe(FUTURE);
  });

  it('reopen works after a dump round-trip', async () => {
    const { wiki, newId } = await scheduledSource();
    const dump = await wiki.exportDump(['u']);
    const db2 = openTestDatabase();
    const w2 = new WikiMemory(db2, opts);
    await w2.setup();
    await w2.importDump(dump);
    await w2.forget('u', { entryId: newId });
    expect(await w2.reopen('u', 'old')).toEqual({ valid_to: FUTURE });
  });
});
