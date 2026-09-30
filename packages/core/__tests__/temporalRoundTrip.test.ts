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
