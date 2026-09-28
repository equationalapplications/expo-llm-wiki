import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryDump, WikiFact } from '../src/types';

// Acceptance for #232 against real SQLite. The keyword index must cost
// O(rows touched) per write, not O(entity), so a chunked import reads each
// row back for indexing about once, whatever the chunk size.

const ENTITY = 'e1';
const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven', 'ivory', 'juniper'];

function makeFact(i: number): WikiFact {
  return {
    id: `fact_${String(i).padStart(4, '0')}`,
    entity_id: ENTITY,
    title: `note ${WORDS[i % WORDS.length]} ${i}`,
    body: `body about ${WORDS[(i * 7) % WORDS.length]} and topic${i}`,
    tags: [WORDS[(i * 3) % WORDS.length]],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: i + 1,
    updated_at: i + 1,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
  };
}

function dumpOf(facts: WikiFact[]): MemoryDump {
  return { generatedAt: 0, entities: { [ENTITY]: { facts, tasks: [], events: [], edges: [] } } };
}

async function freshWiki(generateText: () => Promise<string> = async () => '{"facts":[]}') {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText } });
  await wiki.setup();
  return { wiki, db };
}

/** Counts rows the search index reads back from SQLite, and full-entity reads. */
function countIndexReads(wiki: WikiMemory) {
  const repo = wiki.__testAccess.entryRepo;
  const counts = { rows: 0, fullReads: 0 };
  const full = repo.findMiniSearchRows.bind(repo);
  const byIds = repo.findMiniSearchRowsByIds.bind(repo);
  vi.spyOn(repo, 'findMiniSearchRows').mockImplementation(async (...args) => {
    const rows = await full(...args);
    counts.fullReads++;
    counts.rows += rows.length;
    return rows;
  });
  vi.spyOn(repo, 'findMiniSearchRowsByIds').mockImplementation(async (...args) => {
    const rows = await byIds(...args);
    counts.rows += rows.length;
    return rows;
  });
  return counts;
}

const search = (wiki: WikiMemory, query: string) =>
  wiki.__testAccess.searchService.searchKeyword(query, [ENTITY], 2000).map((r) => r.id).sort();

describe('incremental keyword index (#232)', () => {
  it('reads each imported row back about once, whatever the chunk size', async () => {
    const facts = Array.from({ length: 1000 }, (_, i) => makeFact(i));

    const { wiki: oneShot } = await freshWiki();
    await oneShot.importDump(dumpOf(facts), { merge: true });

    const { wiki: chunked } = await freshWiki();
    const counts = countIndexReads(chunked);
    for (let i = 0; i < facts.length; i += 25) {
      await chunked.importDump(dumpOf(facts.slice(i, i + 25)), { merge: true });
    }

    // The first chunk finds the entity untracked and rebuilds it (25 rows); each
    // later chunk reads only its own 25. Whole-entity rebuilds read ~20 500.
    expect(counts.rows).toBe(1000);
    expect(counts.fullReads).toBe(1);

    for (const query of ['amber', 'juniper', 'topic42', 'note cedar']) {
      const expected = search(oneShot, query);
      expect(expected.length).toBeGreaterThan(0);
      expect(search(chunked, query)).toEqual(expected);
    }
  });

  it('a merge: false import still drops the previous facts from search', async () => {
    const { wiki } = await freshWiki();
    await wiki.importDump(dumpOf([makeFact(0), makeFact(1)]), { merge: true });

    const replacement: WikiFact = { ...makeFact(2), title: 'replacement quokka', body: 'quokka' };
    await wiki.importDump(dumpOf([replacement]), { merge: false });

    expect(search(wiki, 'quokka')).toEqual(['fact_0002']);
    expect(search(wiki, 'note')).toEqual([]);
  });

  it('ingestDocument on a 1000-fact entity reads back only the rows it touched', async () => {
    let reply = JSON.stringify({ facts: [{ title: 'Walrus migration', body: 'walrus herds move north', tags: [], confidence: 'certain' }] });
    const { wiki } = await freshWiki(async () => reply);
    await wiki.importDump(dumpOf(Array.from({ length: 1000 }, (_, i) => makeFact(i))), { merge: true });
    await wiki.ingestDocument(ENTITY, { sourceRef: 'journal-1', sourceHash: 'a'.repeat(64), documentChunk: 'Walrus notes.' });
    expect(search(wiki, 'walrus')).toHaveLength(1);

    reply = JSON.stringify({ facts: [{ title: 'Narwhal sighting', body: 'narwhal tusk spotted', tags: [], confidence: 'certain' }] });
    const counts = countIndexReads(wiki);
    await wiki.ingestDocument(ENTITY, { sourceRef: 'journal-1', sourceHash: 'b'.repeat(64), documentChunk: 'Narwhal notes.' });

    // Re-ingest supersedes the walrus fact (soft-deleted, so it reads back as
    // absent) and inserts one narwhal fact. None of the 1000 rows are read.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(1);
    expect(search(wiki, 'narwhal')).toHaveLength(1);
    expect(search(wiki, 'walrus')).toEqual([]);
    expect(search(wiki, 'amber').length).toBeGreaterThan(0);
  });

  it("upsertGraph nodes become keyword-searchable on the entity's next core write", async () => {
    const { wiki, db } = await freshWiki();
    await wiki.importDump(dumpOf([makeFact(0)]), { merge: true });

    await db.withTransactionAsync((tx) =>
      wiki.upsertGraph(
        ENTITY,
        { sourceRef: 'graph.ts', sourceHash: 'c'.repeat(64), nodes: [{ id: 'node_1', type: '', title: 'pelican symbol' }], edges: [] },
        tx,
      ),
    );
    // Core never sees the host's commit, so the node isn't indexed yet.
    expect(search(wiki, 'pelican')).toEqual([]);

    await wiki.importDump(dumpOf([makeFact(1)]), { merge: true });
    expect(search(wiki, 'pelican')).toEqual(['node_1']);
  });
});
