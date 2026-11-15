import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { SourceStoreService } from '../src/services/SourceStoreService';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { cutPassages, MAX_PASSAGE_UNITS } from '../src/utils/passageCutter';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions } from '../src/types';

const P = 'llm_wiki_';
const E = 'ent1';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

function tiles(text: string, spans: { start: number; end: number }[]): void {
  let pos = 0;
  for (const s of spans) {
    expect(s.start).toBe(pos); // contiguous, no overlap, no gap
    expect(s.end).toBeGreaterThan(s.start);
    pos = s.end;
  }
  expect(pos).toBe(text.length);
}

describe('cutPassages', () => {
  it('returns nothing for empty text and one span for short text', () => {
    expect(cutPassages('')).toEqual([]);
    expect(cutPassages('  hi  ')).toEqual([{ start: 0, end: 6 }]);
  });

  it('caps passages at 12,000 UTF-16 units and tiles the text', () => {
    const text = 'x'.repeat(30_000);
    const spans = cutPassages(text);
    expect(spans).toHaveLength(3);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(MAX_PASSAGE_UNITS);
    tiles(text, spans);
  });

  it('prefers whitespace boundaries, ending a passage after the whitespace', () => {
    const text = `${'word '.repeat(5000)}tail`;
    const spans = cutPassages(text);
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans.slice(0, -1)) expect(/\s/.test(text[s.end - 1]!)).toBe(true);
    tiles(text, spans);
  });

  it('never splits a surrogate pair, even on a hard cut', () => {
    // Odd-length prefix puts a pair across the 12,000 boundary.
    const text = `a${'😀'.repeat(13_000)}`;
    const spans = cutPassages(text);
    for (const s of spans) {
      const first = text.charCodeAt(s.start);
      expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false);
      const last = text.charCodeAt(s.end - 1);
      expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
      expect(text.slice(s.start, s.end)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    tiles(text, spans);
  });

  it('does not trim and slices the handed text back exactly', () => {
    const chunk = '   lead  repeat repeat repeat\n\n';
    const text = chunk.repeat(1500);
    const spans = cutPassages(text);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);
    expect(text.slice(spans[0]!.start, spans[0]!.end).startsWith('   lead')).toBe(true);
  });
});

async function setup(): Promise<{ db: SQLiteAdapter; wiki: WikiMemory; svc: SourceStoreService }> {
  const db = openTestDatabase();
  const options = { llmProvider: { generateText: async () => '{}' } } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const svc = new SourceStoreService(db, P, options, (wiki as unknown as { jobManager: never }).jobManager);
  return { db, wiki, svc };
}

async function fts(db: SQLiteAdapter): Promise<Fts5IndexStrategy> {
  const s = new Fts5IndexStrategy(db, P, new MetadataRepository(db, P));
  await s.init({ entriesExisted: true });
  return s;
}

const count = async (db: SQLiteAdapter, table: string): Promise<number> =>
  (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}${table}`))!.n;

const LONG = `${'alpha beta gamma '.repeat(1500)}zebrafish ${'delta epsilon '.repeat(1500)}`;

describe('source passage index', () => {
  it('storing a source inserts offset rows (no text) and the FTS5 drain makes them queryable', async () => {
    const { db, svc } = await setup();
    const strategy = await fts(db);
    const res = await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: LONG });
    expect(res.stored && res.passageCount).toBeGreaterThan(1);
    const rows = await db.getAllAsync<{ start_offset: number; end_offset: number }>(
      `SELECT start_offset, end_offset FROM ${P}source_passages ORDER BY seq`);
    expect(rows).toHaveLength((res as { passageCount: number }).passageCount);
    expect(await count(db, 'source_passages_fts_map')).toBe(0); // not yet drained
    expect(await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);

    await strategy.drainPassages();
    expect(await count(db, 'source_passages_fts_map')).toBe(rows.length);
    const hits = await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(await strategy.searchPassages('zebrafish', { entityIds: ['other'], limit: 10 })).toEqual([]);
    expect(await count(db, 'source_passages_fts_pending')).toBe(0);
  });

  it('the MiniSearch fallback indexes the same passages', async () => {
    const { db, svc } = await setup();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: LONG });
    const mini = new MiniSearchIndexStrategy();
    await mini.reindexSourcePassages(db, P);
    const hits = await mini.searchPassages('zebrafish', { entityIds: [E], limit: 10 });
    expect(hits).toHaveLength(1);
    expect(await mini.searchPassages('zebrafish', { entityIds: ['other'], limit: 10 })).toEqual([]);
  });

  it('both strategies cover the same passages on one fixture', async () => {
    const { db, svc } = await setup();
    const strategy = await fts(db);
    const text = `${'common '.repeat(4000)}😀 ${'common '.repeat(4000)}`;
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text });
    await strategy.drainPassages();
    const mini = new MiniSearchIndexStrategy();
    await mini.reindexSourcePassages(db, P);
    const q = { entityIds: [E], limit: 1000 };
    const a = (await strategy.searchPassages('common', q)).map((r) => r.id).sort();
    const b = (await mini.searchPassages('common', q)).map((r) => r.id).sort();
    const stored = (await db.getAllAsync<{ id: string }>(`SELECT id FROM ${P}source_passages`)).map((r) => r.id).sort();
    expect(a).toEqual(stored);
    expect(b).toEqual(stored);
  });

  it('forget drops deleted passages after sync, and a stalled drain never surfaces them', async () => {
    const { db, wiki, svc } = await setup();
    const strategy = await fts(db);
    const mini = new MiniSearchIndexStrategy();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: LONG });
    await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: H2, text: 'quokka habitat notes' });
    await strategy.drainPassages();
    await mini.reindexSourcePassages(db, P, E);
    expect(await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toHaveLength(1);

    await wiki.forget(E, { sourceRef: 'a.md' });

    // Drain stalled: the FTS row is still there, but the query never returns it.
    expect(await count(db, 'source_passages_fts_map')).toBeGreaterThan(0);
    expect(await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);
    expect(await strategy.searchPassages('quokka', { entityIds: [E], limit: 10 })).toHaveLength(1);

    await strategy.drainPassages();
    expect(await count(db, 'source_passages_fts_pending')).toBe(0);
    expect(await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);

    await mini.reindexSourcePassages(db, P, E);
    expect(await mini.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);
    expect(await mini.searchPassages('quokka', { entityIds: [E], limit: 10 })).toHaveLength(1);
  });

  it('clearAll leaves no passage in either index after sync', async () => {
    const { db, wiki, svc } = await setup();
    const strategy = await fts(db);
    const mini = new MiniSearchIndexStrategy();
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: H1, text: LONG });
    await strategy.drainPassages();
    await mini.reindexSourcePassages(db, P);
    await wiki.forget(E, { clearAll: true });
    expect(await strategy.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);
    await strategy.drainPassages();
    expect(await count(db, 'source_passages_fts_map')).toBe(0);
    await mini.reindexSourcePassages(db, P, E);
    expect(await mini.searchPassages('zebrafish', { entityIds: [E], limit: 10 })).toEqual([]);
  });
});
