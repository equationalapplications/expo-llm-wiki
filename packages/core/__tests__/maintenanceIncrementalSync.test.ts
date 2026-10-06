import { describe, it, expect, vi } from 'vitest';
import { WikiMemory, PrunePartialFailureError } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryDump, SQLiteAdapter, WikiFact } from '../src/types';

// Acceptance for #235: MaintenanceService's prune / forget / librarian / heal
// passes must update the keyword index at O(rows touched), not O(entity) —
// whatever the entity size, and whatever the internal chunk size. Mirrors the
// counting approach of incrementalSearchIndex.test.ts (#232).

const ENTITY = 'e1';
const PREFIX = 'llm_wiki_';
const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'haven', 'ivory', 'juniper'];
const NOOP_HEAL = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });

function makeFact(i: number, sourceRef: string | null = null): WikiFact {
  return {
    id: `fact_${String(i).padStart(4, '0')}`,
    entity_id: ENTITY,
    title: `note ${WORDS[i % WORDS.length]} ${i}`,
    body: `body about ${WORDS[(i * 7) % WORDS.length]} and topic${i}`,
    tags: [WORDS[(i * 3) % WORDS.length]],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: sourceRef,
    created_at: i + 1,
    updated_at: i + 1,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
  };
}

function dumpOf(facts: WikiFact[]): MemoryDump {
  return { generatedAt: 0, entities: { [ENTITY]: { facts, tasks: [], events: [], edges: [] } } } as MemoryDump;
}

async function freshWiki(
  generateText: () => Promise<string> = async () => '{"facts":[]}',
  config: Record<string, unknown> = {},
) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: { generateText }, config } as any);
  await wiki.setup();
  return { wiki, db };
}

/** Seeds a librarian_inferred row the way healBounding.test.ts does. */
async function seedFact(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; title?: string; body?: string;
  updatedAt?: number; healCheckedAt?: number | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at,
        updated_at, access_count, deleted_at, heal_checked_at)
     VALUES (?, ?, ?, ?, '[]', 'inferred', 'librarian_inferred', ?, ?, 0, NULL, ?)`,
    [
      opts.id, opts.entityId ?? ENTITY, opts.title ?? `title ${opts.id}`,
      opts.body ?? `body ${opts.id}`,
      opts.updatedAt ?? 1000, opts.updatedAt ?? 1000, opts.healCheckedAt ?? null,
    ],
  );
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

const search = async (wiki: WikiMemory, query: string) =>
  (await wiki.__testAccess.searchService.searchKeyword(query, [ENTITY], 2000)).map((r) => r.id).sort();

describe('incremental keyword index for maintenance passes (#235)', () => {
  it('forget by entryId reads only the forgotten rows, not the entity', async () => {
    const facts = Array.from({ length: 600 }, (_, i) => makeFact(i));
    facts[0] = { ...facts[0], body: 'xylophone marker zero' };
    const { wiki } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });

    const counts = countIndexReads(wiki);
    await wiki.forget(ENTITY, { entryId: 'fact_0000' });

    // The forgotten row is soft-deleted, so it reads back as absent: zero rows
    // read, zero full-entity reads, on a 600-fact entity.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(0);
    // 'xylophone' is a token unique to the forgotten fact — the index's fuzzy
    // and prefix matching (0.2 / true) has no neighbor for it.
    expect(await search(wiki, 'xylophone')).toEqual([]);
    expect((await search(wiki, 'note')).length).toBe(599);
  });

  it('forget by sourceRef indexes only the matched ids', async () => {
    const facts = [
      ...Array.from({ length: 300 }, (_, i) => makeFact(i, 'doc-1')),
      ...Array.from({ length: 300 }, (_, i) => makeFact(300 + i)),
    ];
    const { wiki } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });

    const counts = countIndexReads(wiki);
    const result = await wiki.forget(ENTITY, { sourceRef: 'doc-1' });

    expect(result.deleted.entries).toBe(300);
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(0);
    expect((await search(wiki, 'note')).length).toBe(300);
  });

  it('prune reads only the pruned rows, not the entity', async () => {
    const facts = Array.from({ length: 600 }, (_, i) => makeFact(i));
    facts[0] = { ...facts[0], body: 'xylophone marker zero' };
    facts[1] = { ...facts[1], body: 'yeoman marker one' };
    const { wiki } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });
    await wiki.forget(ENTITY, { entryId: 'fact_0000' });
    await wiki.forget(ENTITY, { entryId: 'fact_0001' });

    const counts = countIndexReads(wiki);
    await wiki.runPrune(ENTITY, { retainSoftDeletedFor: 0, retainEventsFor: 0 });

    // Pruned rows were already soft-deleted, so the incremental sync reads them
    // back as absent: zero rows read, zero full-entity reads, and the 598
    // survivors are untouched in the index.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(0);
    expect((await search(wiki, 'note')).length).toBe(598);
    expect(await search(wiki, 'xylophone')).toEqual([]);
    expect(await search(wiki, 'yeoman')).toEqual([]);
  });

  it('forget by clearAll indexes only the enumerated ids (no full rebuild)', async () => {
    const facts = Array.from({ length: 300 }, (_, i) => makeFact(i));
    const { wiki } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });

    const counts = countIndexReads(wiki);
    const result = await wiki.forget(ENTITY, { clearAll: true });

    expect(result.deleted.entries).toBe(300);
    expect(result.metadataReset).toBe(true);
    // Every live id is enumerated into the incremental sync; the entity stays
    // tracked, so the index empties without a full rebuild.
    expect(counts.fullReads).toBe(0);
    expect(await search(wiki, 'note')).toEqual([]);
  });

  it('prune partial failure still syncs the succeeded ids incrementally', async () => {
    const facts = Array.from({ length: 300 }, (_, i) => makeFact(i));
    facts[0] = { ...facts[0], body: 'xylophone marker zero' };
    facts[1] = { ...facts[1], body: 'yeoman marker one' };
    const { wiki, db } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });
    await wiki.forget(ENTITY, { entryId: 'fact_0000' });
    await wiki.forget(ENTITY, { entryId: 'fact_0001' });

    // Break the embedding cleanup hook on the SECOND pruned row: row 0's
    // notify succeeds, row 1's throws -> failure path with succeeded=[row0].
    const embedding = wiki.__testAccess.embeddingService;
    let calls = 0;
    vi.spyOn(embedding, 'notifyEmbeddingPersistedOrThrow').mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('ranker rejected');
      return undefined as never;
    });

    const counts = countIndexReads(wiki);
    await expect(
      wiki.runPrune(ENTITY, { retainSoftDeletedFor: 0, retainEventsFor: 0 }),
    ).rejects.toBeInstanceOf(PrunePartialFailureError);

    // The succeeded row is hard-deleted and its index document is gone via the
    // O(touched) sync (no full-entity read); the failed row is left
    // soft-deleted — not hard-deleted — for the next prune pass.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(0);
    expect(await search(wiki, 'xylophone')).toEqual([]);
    const remaining = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE id IN ('fact_0000', 'fact_0001')`,
    );
    expect(remaining.map((r) => r.id)).toEqual(['fact_0001']);
    expect((await search(wiki, 'note')).length).toBe(298);
  });

  it('prune scrubs index documents a raw soft-delete left behind (drift repair)', async () => {
    const facts = Array.from({ length: 300 }, (_, i) => makeFact(i));
    facts[0] = { ...facts[0], body: 'xylophone marker zero' };
    const { wiki, db } = await freshWiki();
    await wiki.importDump(dumpOf(facts), { merge: true });
    expect(await search(wiki, 'xylophone')).toEqual(['fact_0000']);

    // Simulate a pre-#233-style path: a row soft-deleted without passing ids
    // to syncEntries — its document survives in the index as drift.
    await db.runAsync(
      `UPDATE ${PREFIX}entries SET deleted_at = ? WHERE id = 'fact_0000'`,
      [Date.now()],
    );
    expect(await search(wiki, 'xylophone')).toEqual(['fact_0000']);

    // Prune's incremental sync discards each pruned id before re-reading it,
    // so the stale document is scrubbed at O(touched) — the drift-repair duty
    // the old full-entity sync() performed.
    const counts = countIndexReads(wiki);
    await wiki.runPrune(ENTITY, { retainSoftDeletedFor: 0, retainEventsFor: 0 });
    expect(counts.fullReads).toBe(0);
    expect(await search(wiki, 'xylophone')).toEqual([]);
    expect((await search(wiki, 'note')).length).toBe(299);
  });

  it('heal early return syncs only the orphan/stale pass ids', async () => {
    const { wiki, db } = await freshWiki(
      async () => NOOP_HEAL,
      { orphanAfterDays: null, staleInferredAfterDays: 0 },
    );
    await wiki.importDump(dumpOf(Array.from({ length: 200 }, (_, i) => makeFact(i))), { merge: true });
    // Stamp everything: with zero candidates heal takes the early return, but
    // the stale pass still downgrades the two seeded in-cooldown inferred rows
    // below — the early return must carry exactly those ids.
    await db.runAsync(`UPDATE ${PREFIX}entries SET heal_checked_at = ? WHERE entity_id = ?`, [Date.now(), ENTITY]);
    await seedFact(db, { id: 'f0', title: 'xenialq marker', healCheckedAt: Date.now() });
    await seedFact(db, { id: 'f1', title: 'zephyrq marker', healCheckedAt: Date.now() });

    const counts = countIndexReads(wiki);
    const result = await wiki.runHeal(ENTITY);

    expect(result.scanned).toBe(0);
    expect(result.downgraded).toBe(2);
    // Exactly the 2 downgraded (still-live) rows are read back and reindexed;
    // the 200 other live rows are not read.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(2);
    expect(await search(wiki, 'xenialq')).toEqual(['f0']);
    expect((await search(wiki, 'amber')).length).toBeGreaterThan(0);
  });

  it('a full heal pass reads only the ids its passes touched', async () => {
    const reply = JSON.stringify({
      downgraded: ['f1'],
      deleted: ['f0'],
      newFacts: [{ title: 'quokka habit', body: 'quokka', tags: [], confidence: 'certain' }],
    });
    const { wiki, db } = await freshWiki(async () => reply, { orphanAfterDays: null, staleInferredAfterDays: null });
    await wiki.importDump(dumpOf(Array.from({ length: 400 }, (_, i) => makeFact(i))), { merge: true });
    // Give the imported rows a heal_checked stamp so the only candidates are
    // the three seeded rows below (the model replies reference f0/f1).
    await db.runAsync(`UPDATE ${PREFIX}entries SET heal_checked_at = ? WHERE entity_id = ?`, [Date.now(), ENTITY]);
    await seedFact(db, { id: 'f0', title: 'zeroid marker' });
    await seedFact(db, { id: 'f1', title: 'zoroone marker' });
    await seedFact(db, { id: 'f2' });

    const counts = countIndexReads(wiki);
    const result = await wiki.runHeal(ENTITY);

    expect(result.scanned).toBe(3);
    expect(result.deleted).toBe(1);
    expect(result.downgraded).toBe(1);
    expect(result.newFactsCreated).toBe(1);
    // 3 touched ids: f0 reads back absent (deleted), f1 (downgraded) and the
    // inserted fact are re-read. None of the 403 other rows are touched.
    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(2);
    expect(await search(wiki, 'zeroid')).toEqual([]);
    expect(await search(wiki, 'zoroone')).toEqual(['f1']);
    expect(await search(wiki, 'quokka')).toHaveLength(1);
    expect((await search(wiki, 'amber')).length).toBeGreaterThan(0);
  });

  it('a librarian pass reads only the rows it inserted', async () => {
    const reply = JSON.stringify({
      facts: [{ title: 'ibex sighting', body: 'ibex', tags: [], confidence: 'certain' }],
      tasks: [],
    });
    const { wiki } = await freshWiki(async () => reply);
    await wiki.importDump(dumpOf(Array.from({ length: 400 }, (_, i) => makeFact(i))), { merge: true });

    const counts = countIndexReads(wiki);
    await wiki.runLibrarian(ENTITY);

    expect(counts.fullReads).toBe(0);
    expect(counts.rows).toBe(1);
    expect(await search(wiki, 'ibex')).toHaveLength(1);
    expect((await search(wiki, 'amber')).length).toBeGreaterThan(0);
  });
});
