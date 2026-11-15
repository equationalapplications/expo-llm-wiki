import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { SourceStoreService } from '../src/services/SourceStoreService';
import { sha256Hex } from '../src/utils/sha256';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions, MemoryDump } from '../src/types';

const PREFIX = 'llm_wiki_';
const DOCS = `${PREFIX}source_documents`;
const PASSAGES = `${PREFIX}source_passages`;
const REGISTRY = `${PREFIX}source_ref_index`;
const E = 'ent1';
const H = (c: string): string => c.repeat(64);

async function setup(config?: unknown): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; svc: SourceStoreService }> {
  const db = openTestDatabase();
  const options = { llmProvider: { generateText: async () => '{}' }, config } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const svc = new SourceStoreService(db, PREFIX, options, (wiki as unknown as { jobManager: never }).jobManager);
  return { db, wiki, svc };
}

async function passageRows(db: SQLiteAdapter, ref: string): Promise<Array<{ seq: number; start_offset: number; end_offset: number }>> {
  return db.getAllAsync(
    `SELECT p.seq, p.start_offset, p.end_offset FROM ${PASSAGES} p JOIN ${DOCS} d ON d.id = p.document_id
     WHERE d.entity_id = ? AND d.source_ref = ? ORDER BY p.seq`, [E, ref]);
}

const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'word '.repeat(120)}`).join('\n\n');

describe('source store dump export/import (spec §8)', () => {
  it('round-trips text, listing and passage offsets', async () => {
    const a = await setup();
    await a.svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H('a'), text: LONG });
    await a.svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H('b'), text: 'tiny 😀' });
    const dump = await a.wiki.exportDump([E]);
    const stored = dump.entities[E]!.storedSources!;
    expect(stored.map((s) => s.sourceRef)).toEqual(['a.md', 'b.md']);
    expect(stored[0]!.textHash).toBe(sha256Hex(LONG));
    expect(stored[0]!.passages.length).toBeGreaterThan(1);

    const b = await setup();
    const res = await b.wiki.importDump(JSON.parse(JSON.stringify(dump)) as MemoryDump);
    expect(res).toEqual({ skippedSources: [] });
    expect((await b.svc.getStoredSource(E, 'a.md'))!.text).toBe(LONG);
    expect((await b.svc.getStoredSource(E, 'b.md'))!.text).toBe('tiny 😀');
    const strip = (l: Array<{ storedAt: number }>) => l.map(({ storedAt: _s, ...r }) => r);
    expect(strip(await b.svc.listStoredSources(E))).toEqual(strip(await a.svc.listStoredSources(E)));
    expect(await passageRows(b.db, 'a.md')).toEqual(await passageRows(a.db, 'a.md'));
  });

  it('an entity with nothing stored exports no storedSources field', async () => {
    const { wiki } = await setup();
    const dump = await wiki.exportDump([E]);
    expect('storedSources' in dump.entities[E]!).toBe(false);
  });

  it('an old dump without storedSources leaves the store untouched (merge)', async () => {
    const { wiki, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H('a'), text: 'keep me' });
    const res = await wiki.importDump({ generatedAt: 1, entities: { [E]: { facts: [], tasks: [], events: [] } } }, { merge: true });
    expect(res.skippedSources).toEqual([]);
    expect((await svc.getStoredSource(E, 'a.md'))!.text).toBe('keep me');
  });

  it('ignores the dump passages and textHash; stores re-derived values', async () => {
    const { wiki, svc, db } = await setup();
    const text = 'honest text';
    await wiki.importDump({ generatedAt: 1, entities: { [E]: { facts: [], tasks: [], events: [], storedSources: [
      { sourceRef: 'x.md', sourceHash: H('a'), text, textHash: 'bogus', charCount: 999, storedAt: 5,
        passages: [{ seq: 0, startOffset: 3, endOffset: 4 }] },
    ] } } }, { merge: true });
    const row = await db.getFirstAsync<{ text_hash: string; char_count: number }>(`SELECT text_hash, char_count FROM ${DOCS} WHERE entity_id = ?`, [E]);
    expect(row).toEqual({ text_hash: sha256Hex(text), char_count: text.length });
    expect(await passageRows(db, 'x.md')).toEqual([{ seq: 0, start_offset: 0, end_offset: text.length }]);
    expect((await svc.listStoredSources(E))[0]!.storedAt).toBe(5);
  });

  const src = (ref: string, hash: string, text: string) => ({
    sourceRef: ref, sourceHash: hash, text, textHash: sha256Hex(text), charCount: text.length, storedAt: 1, passages: [],
  });
  const dumpOf = (...sources: ReturnType<typeof src>[]): MemoryDump =>
    ({ generatedAt: 1, entities: { [E]: { facts: [], tasks: [], events: [], storedSources: sources } } });

  it('refuses a too-large source and imports the others', async () => {
    const { wiki, svc } = await setup({ sourceStore: { maxCharsPerSource: 10 } });
    const res = await wiki.importDump(dumpOf(src('big.md', H('a'), 'x'.repeat(11)), src('ok.md', H('b'), 'fine')), { merge: true });
    expect(res.skippedSources).toEqual([{ sourceRef: 'big.md', code: 'source_store_source_too_large' }]);
    expect(await svc.getStoredSource(E, 'big.md')).toBeNull();
    expect((await svc.getStoredSource(E, 'ok.md'))!.text).toBe('fine');
  });

  it('refuses mid-import when the per-entity budget is exceeded', async () => {
    const { wiki, svc } = await setup({ sourceStore: { maxTotalChars: 10 } });
    const res = await wiki.importDump(dumpOf(src('a.md', H('a'), '123456'), src('b.md', H('b'), '1234567')), { merge: true });
    expect(res.skippedSources).toEqual([{ sourceRef: 'b.md', code: 'source_store_budget_exceeded' }]);
    expect(await svc.getStoredSource(E, 'a.md')).not.toBeNull();
    expect(await svc.getStoredSource(E, 'b.md')).toBeNull();
  });

  it('refuses a duplicate hash within the dump and against source_ref_index', async () => {
    const { wiki, svc, db } = await setup();
    await db.runAsync(
      `INSERT INTO ${REGISTRY} (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      ['sri_x', E, H('c'), 'facts.md', 1]);
    const res = await wiki.importDump(dumpOf(
      src('a.md', H('a'), 'one'), src('dup.md', H('a'), 'two'), src('reg.md', H('c'), 'three'),
    ), { merge: true });
    expect(res.skippedSources).toEqual([
      { sourceRef: 'dup.md', code: 'source_store_duplicate_hash' },
      { sourceRef: 'reg.md', code: 'source_store_duplicate_hash' },
    ]);
    expect((await svc.listStoredSources(E)).map((s) => s.sourceRef)).toEqual(['a.md']);
  });

  it('refuses text that is not storable', async () => {
    const { wiki } = await setup();
    const res = await wiki.importDump(dumpOf(src('nul.md', H('a'), 'a\u0000b')), { merge: true });
    expect(res.skippedSources).toEqual([{ sourceRef: 'nul.md', code: 'source_store_text_not_storable' }]);
  });

  it('merge replaces an existing ref with the dump copy and keeps other sources', async () => {
    const { wiki, svc, db } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H('a'), text: 'old a' });
    await svc.storeSource(E, { sourceRef: 'k.md', sourceHash: H('d'), text: 'kept' });
    const res = await wiki.importDump(dumpOf(src('a.md', H('b'), 'new a')), { merge: true });
    expect(res.skippedSources).toEqual([]);
    const a = await svc.getStoredSource(E, 'a.md');
    expect(a).toMatchObject({ text: 'new a', sourceHash: H('b') });
    expect((await svc.getStoredSource(E, 'k.md'))!.text).toBe('kept');
    const n = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PASSAGES} WHERE entity_id = ?`, [E]);
    expect(n!.n).toBe(2);
  });

  it('merge:false replaces the whole store; a refused source is absent and listed', async () => {
    const { wiki, svc } = await setup({ sourceStore: { maxCharsPerSource: 10 } });
    await svc.storeSource(E, { sourceRef: 'old.md', sourceHash: H('e'), text: 'old' });
    const res = await wiki.importDump(dumpOf(src('big.md', H('a'), 'x'.repeat(11)), src('new.md', H('b'), 'new')), { merge: false });
    expect(res.skippedSources).toEqual([{ sourceRef: 'big.md', code: 'source_store_source_too_large' }]);
    expect((await svc.listStoredSources(E)).map((s) => s.sourceRef)).toEqual(['new.md']);
  });

  it('merge:false with a dump lacking storedSources wipes the store', async () => {
    const { wiki, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'old.md', sourceHash: H('e'), text: 'old' });
    await wiki.importDump({ generatedAt: 1, entities: { [E]: { facts: [], tasks: [], events: [] } } }, { merge: false });
    expect(await svc.listStoredSources(E)).toEqual([]);
  });
});
