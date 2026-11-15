import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { SourceStoreService } from '../src/services/SourceStoreService';
import { sha256Hex } from '../src/utils/sha256';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiBusyError } from '../src/types';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const PREFIX = 'llm_wiki_';
const DOCS = `${PREFIX}source_documents`;
const PASSAGES = `${PREFIX}source_passages`;
const REGISTRY = `${PREFIX}source_ref_index`;
const E = 'ent1';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

async function setup(config?: unknown): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; svc: SourceStoreService }> {
  const db = openTestDatabase();
  const options = { llmProvider: { generateText: async () => '{}' }, config } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  // Share the wiki's JobManager so locks and forget() see one another.
  const svc = new SourceStoreService(db, PREFIX, options, (wiki as unknown as { jobManager: never }).jobManager);
  return { db, wiki, svc };
}

async function docCount(db: SQLiteAdapter, where = '1=1'): Promise<number> {
  const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${DOCS} WHERE ${where}`);
  return r?.n ?? 0;
}

function code(res: { stored: boolean; diagnostics?: { code: string }[] }): string | undefined {
  return res.diagnostics?.[0]?.code;
}

describe('SourceStoreService.storeSource', () => {
  it('stores a source with the engine text_hash and char_count', async () => {
    const { db, svc } = await setup();
    const text = 'hello 😀 world';
    const res = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text });
    expect(res).toMatchObject({ stored: true, sourceRef: 'a.md', sourceHash: H1, charCount: text.length, passageCount: 1 });
    const row = await db.getFirstAsync<{ text: string; text_hash: string; char_count: number }>(
      `SELECT text, text_hash, char_count FROM ${DOCS} WHERE entity_id = ?`, [E]);
    expect(row).toEqual({ text, text_hash: sha256Hex(text), char_count: text.length });
  });

  it('throws on a wrong-shaped sourceHash', async () => {
    const { svc } = await setup();
    await expect(svc.storeSource(E, { sourceRef: 'a.md', sourceHash: 'nope', text: 'x' })).rejects.toThrow(/Invalid sourceHash/);
  });

  it('refuses a lone surrogate and an embedded NUL, storing nothing', async () => {
    const { db, svc } = await setup();
    const r1 = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'bad \uD800 here' });
    expect(r1.stored).toBe(false);
    expect(code(r1)).toBe('source_store_text_not_storable');
    expect(await docCount(db)).toBe(0);
    const r2 = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'nul\u0000byte' });
    expect(code(r2)).toBe('source_store_text_not_storable');
    expect(await docCount(db)).toBe(0);
    // A well-formed surrogate pair is fine.
    expect((await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: '😀' })).stored).toBe(true);
  });

  it('is a no-op for the same pair and same text', async () => {
    const { db, svc } = await setup();
    const a = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'same' });
    const b = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'same' });
    expect(b).toEqual(a);
    expect(await docCount(db)).toBe(1);
  });

  it('refuses different text under the same declared pair', async () => {
    const { db, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'one' });
    const res = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'two' });
    expect(code(res)).toBe('source_store_hash_mismatch');
    const row = await db.getFirstAsync<{ text: string }>(`SELECT text FROM ${DOCS}`);
    expect(row?.text).toBe('one');
  });

  it('refuses a second ref holding a hash the store already holds', async () => {
    const { db, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'one' });
    const res = await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H1, text: 'two' });
    expect(code(res)).toBe('source_store_duplicate_hash');
    expect(await docCount(db)).toBe(1);
  });

  it('refuses a hash held by a LIVE source_ref_index row under another ref', async () => {
    const { db, svc } = await setup();
    await db.runAsync(
      `INSERT INTO ${REGISTRY} (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      ['sri_x', E, H1, 'facts.md', 1]);
    const res = await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H1, text: 'two' });
    expect(code(res)).toBe('source_store_duplicate_hash');
    expect(await docCount(db)).toBe(0);
  });

  it('a forgotten source registry tombstone blocks nothing', async () => {
    const { db, wiki, svc } = await setup();
    await db.runAsync(
      `INSERT INTO ${REGISTRY} (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      ['sri_x', E, H1, 'facts.md', 1]);
    await wiki.forget(E, { sourceRef: 'facts.md' });
    const tomb = await db.getFirstAsync<{ deleted_at: number | null }>(`SELECT deleted_at FROM ${REGISTRY} WHERE id = 'sri_x'`);
    expect(tomb?.deleted_at).not.toBeNull();
    const res = await svc.storeSource(E, { sourceRef: 'new.md', sourceHash: H1, text: 'fresh' });
    expect(res.stored).toBe(true);
  });

  it('refuses a source over maxCharsPerSource', async () => {
    const { db, svc } = await setup({ sourceStore: { maxCharsPerSource: 10 } });
    expect((await svc.storeSource(E, { sourceRef: 'ok.md', sourceHash: H1, text: '1234567890' })).stored).toBe(true);
    const res = await svc.storeSource(E, { sourceRef: 'big.md', sourceHash: H2, text: '12345678901' });
    expect(code(res)).toBe('source_store_source_too_large');
    expect(await docCount(db)).toBe(1);
  });

  it('refuses a store that pushes the entity over maxTotalChars; other entities are unaffected', async () => {
    const { db, svc } = await setup({ sourceStore: { maxTotalChars: 10 } });
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: '123456' });
    const res = await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: '12345' });
    expect(code(res)).toBe('source_store_budget_exceeded');
    expect(await docCount(db)).toBe(1);
    expect((await svc.storeSource('other', { sourceRef: 'b.md', sourceHash: H2, text: '12345' })).stored).toBe(true);
  });

  it('a changed copy replaces the text: one row for the ref, old text gone', async () => {
    const { db, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'old text' });
    const res = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H2, text: 'new text' });
    expect(res.stored).toBe(true);
    const rows = await db.getAllAsync<{ text: string; source_hash: string }>(`SELECT text, source_hash FROM ${DOCS}`);
    expect(rows).toEqual([{ text: 'new text', source_hash: H2 }]);
    // Old passages are gone; only the new copy's single passage remains.
    const passages = await db.getAllAsync<{ end_offset: number }>(
      `SELECT p.end_offset FROM ${PASSAGES} p JOIN ${DOCS} d ON d.id = p.document_id`);
    expect(passages).toEqual([{ end_offset: 8 }]);
    expect((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PASSAGES}`))?.n).toBe(1);
  });

  it('serializes concurrent stores: the budget check cannot be passed twice', async () => {
    // Deterministic serialization: both calls are started together; the first
    // holds the store lock, so the second throws WikiBusyError (§10) rather
    // than racing the budget check. After the first commits, a retry of the
    // loser re-reads the total inside its transaction and is refused.
    const { db, svc } = await setup({ sourceStore: { maxTotalChars: 10 } });
    const first = svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: '1234567890' });
    await expect(svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: '12345' })).rejects.toBeInstanceOf(WikiBusyError);
    expect((await first).stored).toBe(true);
    const retry = await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: '12345' });
    expect(code(retry)).toBe('source_store_budget_exceeded');
    expect(await docCount(db)).toBe(1);
  });

  it('forget deletes the source store rows for that ref only; clearAll deletes all', async () => {
    const { db, wiki, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: 'aaa' });
    await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: 'bbb' });
    await svc.storeSource('other', { sourceRef: 'a.md', sourceHash: H1, text: 'aaa' });
    expect((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PASSAGES}`))?.n).toBe(3);
    await wiki.forget(E, { sourceRef: 'a.md' });
    expect(await docCount(db, `entity_id = '${E}' AND source_ref = 'a.md'`)).toBe(0);
    expect(await docCount(db, `entity_id = '${E}' AND source_ref = 'b.md'`)).toBe(1);
    expect(await docCount(db, `entity_id = 'other'`)).toBe(1);
    // a.md's passage is gone; b.md's and the other entity's remain.
    expect((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PASSAGES}`))?.n).toBe(2);

    await wiki.forget(E, { sourceHash: H2 });
    expect(await docCount(db, `entity_id = '${E}'`)).toBe(0);

    await svc.storeSource(E, { sourceRef: 'c.md', sourceHash: H3, text: 'ccc' });
    await wiki.forget(E, { clearAll: true });
    expect(await docCount(db, `entity_id = '${E}'`)).toBe(0);
    expect(await docCount(db, `entity_id = 'other'`)).toBe(1);
  });
});
