import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiMemory } from '../src/WikiMemory';
import { SourceStoreService, listStoredSourcesSql } from '../src/services/SourceStoreService';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const PREFIX = 'llm_wiki_';
const E = 'ent1';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

async function setup(): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; svc: SourceStoreService }> {
  const db = openTestDatabase();
  const options = { llmProvider: { generateText: async () => '{}' } } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const svc = new SourceStoreService(db, PREFIX, options, (wiki as unknown as { jobManager: never }).jobManager);
  return { db, wiki, svc };
}

async function insertFact(db: SQLiteAdapter, id: string, entityId: string, sourceRef: string, sourceHash: string): Promise<void> {
  const now = 1000;
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type,
      source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entityId, 'T', 'B', '[]', 'certain', 'immutable_document', sourceHash, sourceRef, now, now, null, 0, null],
  );
}

describe('SourceStoreService reads', () => {
  it('getStoredSource returns the text as handed, or null', async () => {
    const { svc } = await setup();
    const text = '  leading space\r\n😀 and trailing  ';
    const stored = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text });
    expect(stored.stored).toBe(true);
    const got = await svc.getStoredSource(E, 'a.md');
    expect(got).toEqual({
      sourceRef: 'a.md',
      sourceHash: H1,
      text,
      charCount: text.length,
      storedAt: (stored as { storedAt: number }).storedAt,
    });
    expect(await svc.getStoredSource(E, 'missing.md')).toBeNull();
  });

  it('isolates entities', async () => {
    const { svc } = await setup();
    await svc.storeSource('A', { sourceRef: 'a.md', sourceHash: H1, text: 'secret' });
    expect(await svc.getStoredSource('B', 'a.md')).toBeNull();
    expect(await svc.listStoredSources('B')).toEqual([]);
    expect(await svc.listStoredSources('A')).toHaveLength(1);
  });

  it('listStoredSources lists a source stored with no ingest, passageCount 0', async () => {
    const { svc } = await setup();
    const r = await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: 'hello' });
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'hi' });
    const list = await svc.listStoredSources(E);
    expect(list.map((s) => s.sourceRef)).toEqual(['a.md', 'b.md']);
    expect(list[1]).toEqual({
      sourceRef: 'b.md',
      sourceHash: H2,
      charCount: 5,
      passageCount: 1,
      storedAt: (r as { storedAt: number }).storedAt,
    });
  });
});

describe('listStoredSources passage counts', () => {
  it('counts 0 for a document with no passages and 3 for a document with three', async () => {
    const { db, svc } = await setup();
    const docSql = `INSERT INTO ${PREFIX}source_documents
      (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await db.runAsync(docSql, ['doc-zero', E, 'a.md', H1, 'hello', H1, 5, 1000]);
    await db.runAsync(docSql, ['doc-three', E, 'b.md', H2, 'hello world!', H2, 12, 2000]);
    for (let seq = 0; seq < 3; seq++) {
      await db.runAsync(
        `INSERT INTO ${PREFIX}source_passages
          (id, entity_id, document_id, seq, start_offset, end_offset)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [`p-three-${seq}`, E, 'doc-three', seq, seq * 4, seq * 4 + 4],
      );
    }
    const list = await svc.listStoredSources(E);
    expect(list.map((s) => [s.sourceRef, s.passageCount])).toEqual([
      ['a.md', 0],
      ['b.md', 3],
    ]);
  });

  it('does not count a passage stamped with a foreign entity_id on this entity\'s document', async () => {
    // Isolation pin for source-store §10: the count filters on entity_id too
    // (via a +unary term that keeps the probe off the entity index). A row
    // that violates the writer invariant must not leak into the count.
    const { db, svc } = await setup();
    const docSql = `INSERT INTO ${PREFIX}source_documents
      (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await db.runAsync(docSql, ['doc-one', E, 'a.md', H1, 'hello', H1, 5, 1000]);
    await db.runAsync(
      `INSERT INTO ${PREFIX}source_passages
        (id, entity_id, document_id, seq, start_offset, end_offset)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ['p-own-0', E, 'doc-one', 0, 0, 4],
    );
    await db.runAsync(
      `INSERT INTO ${PREFIX}source_passages
        (id, entity_id, document_id, seq, start_offset, end_offset)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ['p-own-1', E, 'doc-one', 1, 4, 5],
    );
    // Writer-invariant violation planted through raw SQL: foreign entity_id,
    // this entity's document id.
    await db.runAsync(
      `INSERT INTO ${PREFIX}source_passages
        (id, entity_id, document_id, seq, start_offset, end_offset)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ['p-foreign', 'other-entity', 'doc-one', 2, 5, 6],
    );
    const list = await svc.listStoredSources(E);
    expect(list.map((s) => [s.sourceRef, s.passageCount])).toEqual([['a.md', 2]]);
  });
});

describe('listStoredSources query plan', () => {
  it('probes the passage count on the document index, not the entity index', async () => {
    const { db, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'hello' });
    const plan = await db.getAllAsync<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${listStoredSourcesSql(PREFIX)}`,
      [E],
    );
    const details = plan.map((r) => r.detail);
    expect(details.join('\n')).toContain('idx_source_passages_doc');
    expect(details.some((d) => d.includes('idx_source_passages_entity'))).toBe(false);
  });
});

describe('listStoredSources file-backed perf guard (5,000 docs x 3 passages)', () => {
  const DOCS = 5000;
  const dbPath = join(tmpdir(), `llm-wiki-source-store-perf-${process.pid}.db`);
  let db: SQLiteAdapter;
  let svc: SourceStoreService;

  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(dbPath + suffix, { force: true });
    }
    db = openTestDatabase(dbPath);
    const options = { llmProvider: { generateText: async () => '{}' } } as unknown as WikiOptions;
    const wiki = new WikiMemory(db, options);
    await wiki.setup();
    svc = new SourceStoreService(db, PREFIX, options, (wiki as unknown as { jobManager: never }).jobManager);
    await db.execAsync('BEGIN');
    try {
      for (let i = 0; i < DOCS; i++) {
        const docId = `perf-doc-${i}`;
        await db.runAsync(
          `INSERT INTO ${PREFIX}source_documents
            (id, entity_id, source_ref, source_hash, text, text_hash, char_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [docId, E, `doc-${String(i).padStart(5, '0')}.md`, String(i).padStart(64, '0'), 'hello world!', String(i).padStart(64, '1'), 12, 1000 + i],
        );
        for (let seq = 0; seq < 3; seq++) {
          await db.runAsync(
            `INSERT INTO ${PREFIX}source_passages
              (id, entity_id, document_id, seq, start_offset, end_offset)
              VALUES (?, ?, ?, ?, ?, ?)`,
            [`perf-p-${i}-${seq}`, E, docId, seq, seq * 4, seq * 4 + 4],
          );
        }
      }
      await db.execAsync('COMMIT');
    } catch (err) {
      try {
        await db.execAsync('ROLLBACK');
      } catch {
        // no active transaction — report the original seeding error
      }
      throw err;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.closeAsync();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(dbPath + suffix, { force: true });
    }
  });

  it('lists 5,000 stored sources in under 500 ms', async () => {
    // The EQP plan-pin test above is the authoritative regression guard.
    // This 500 ms budget is a coarse tripwire (~33x headroom over the
    // measured 15 ms), not an SLA — loaded CI runners can wobble wall time.
    const t0 = performance.now();
    const list = await svc.listStoredSources(E);
    const elapsed = performance.now() - t0;
    expect(list).toHaveLength(DOCS);
    expect(elapsed, `listStoredSources took ${elapsed.toFixed(0)} ms`).toBeLessThan(500);
  }, 120_000);
});

describe('listSourceRefs stored three-state (spec §4)', () => {
  it('exact pair → { charCount }', async () => {
    const { db, wiki, svc } = await setup();
    await insertFact(db, 'f1', E, 'a.md', H1);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'hello' });
    const refs = await wiki.listSourceRefs(E);
    expect(refs).toHaveLength(1);
    expect(refs[0].stored).toEqual({ charCount: 5 });
  });

  it('changed copy under a new hash → staleHash for the old facts', async () => {
    const { db, wiki, svc } = await setup();
    await insertFact(db, 'f1', E, 'a.md', H1);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H2, text: 'changed copy' });
    const refs = await wiki.listSourceRefs(E);
    expect(refs[0].sourceHash).toBe(H1);
    expect(refs[0].stored).toEqual({ charCount: 'changed copy'.length, staleHash: true });
  });

  it('never-stored ref → stored: null', async () => {
    const { db, wiki, svc } = await setup();
    await insertFact(db, 'f1', E, 'a.md', H1);
    await insertFact(db, 'f2', E, 'b.md', H3);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'x' });
    const refs = await wiki.listSourceRefs(E);
    expect(refs.find((r) => r.sourceRef === 'a.md')?.stored).toEqual({ charCount: 1 });
    expect(refs.find((r) => r.sourceRef === 'b.md')?.stored).toBeNull();
  });

  it("another entity's store row never links", async () => {
    const { db, wiki, svc } = await setup();
    await insertFact(db, 'f1', E, 'a.md', H1);
    await svc.storeSource('other', { sourceRef: 'a.md', sourceHash: H1, text: 'x' });
    expect((await wiki.listSourceRefs(E))[0].stored).toBeNull();
  });

  it('a ref whose store rows were removed stays listed with stored: null', async () => {
    const { db, wiki, svc } = await setup();
    await insertFact(db, 'f1', E, 'a.md', H1);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'hello' });
    expect((await wiki.listSourceRefs(E))[0].stored).toEqual({ charCount: 5 });
    // Remove the store rows only, as the spec §4 forget semantics describe
    // (facts stay). Done in SQL because forget hard-deletes the store rows
    // while the facts soft-delete separately.
    await db.runAsync(`DELETE FROM ${PREFIX}source_passages WHERE entity_id = ?`, [E]);
    await db.runAsync(`DELETE FROM ${PREFIX}source_documents WHERE entity_id = ?`, [E]);
    const refs = await wiki.listSourceRefs(E);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ sourceRef: 'a.md', factCount: 1, stored: null });
    expect(await svc.getStoredSource(E, 'a.md')).toBeNull();
  });
});
