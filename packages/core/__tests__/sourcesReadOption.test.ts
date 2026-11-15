import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { SourceStoreService } from '../src/services/SourceStoreService';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { MiniSearchIndexStrategy } from '../src/services/search/MiniSearchIndexStrategy';
import { UnavailableIndexStrategy } from '../src/services/search/UnavailableIndexStrategy';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiOptions, SourcePassage } from '../src/types';
import type { IndexStrategy } from '../src/services/search/IndexStrategy';

const P = 'llm_wiki_';
const E = 'ent1';
const hash = (c: string): string => c.repeat(64).slice(0, 64);

type Kind = 'fts5' | 'mini';

async function setup(kind: Kind) {
  const db = openTestDatabase();
  const generateText = vi.fn(async () => '{}');
  const embed = vi.fn(async () => [0]);
  const options = { llmProvider: { generateText, embed } } as unknown as WikiOptions;
  const wiki = new WikiMemory(db, options);
  await wiki.setup();
  const svc = new SourceStoreService(db, P, options, (wiki as unknown as { jobManager: never }).jobManager);
  let mini: MiniSearchIndexStrategy | undefined;
  let fts: Fts5IndexStrategy | undefined;
  let strategy: IndexStrategy;
  if (kind === 'fts5') {
    fts = new Fts5IndexStrategy(db, P, new MetadataRepository(db, P));
    await fts.init({ entriesExisted: true });
    strategy = fts;
  } else {
    mini = new MiniSearchIndexStrategy();
    strategy = mini;
  }
  (wiki as unknown as { searchService: { setIndexStrategy(s: IndexStrategy): void } }).searchService.setIndexStrategy(strategy);
  const sync = async (): Promise<void> => {
    if (fts) await fts.drainPassages();
    if (mini) await mini.reindexSourcePassages(db, P);
  };
  return { db, wiki, svc, sync, generateText, embed, strategy };
}

const read = (wiki: WikiMemory, ents: string | string[], sources: { query: string; maxPassages?: number; charBudget?: number }) =>
  wiki.read(ents, 'unrelated', { sources });

async function storedText(db: SQLiteAdapter, ent: string, ref: string): Promise<string> {
  return (await db.getFirstAsync<{ text: string }>(
    `SELECT text FROM ${P}source_documents WHERE entity_id = ? AND source_ref = ?`, [ent, ref]))!.text;
}

function checkOffsets(items: SourcePassage[], text: string): void {
  for (const it of items) expect(text.slice(it.startOffset, it.endOffset)).toBe(it.text);
}

describe.each<Kind>(['fts5', 'mini'])('read() sources option (%s)', (kind) => {
  it('makes no model call and returns the right passage', async () => {
    const { wiki, svc, sync, generateText, embed } = await setup(kind);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka habitat notes' });
    await svc.storeSource(E, { sourceRef: 'b.md', sourceHash: hash('b'), text: 'unrelated filler words' });
    await sync();
    const b = await read(wiki, E, { query: 'quokka' });
    expect(b.sources).toHaveLength(1);
    expect(b.sources![0]).toMatchObject({
      entityId: E, sourceRef: 'a.md', sourceHash: hash('a'), seq: 0,
      startOffset: 0, endOffset: 20, truncated: false, text: 'quokka habitat notes',
    });
    expect(generateText).not.toHaveBeenCalled();
    // The read's own fact-query embedding is pre-existing; passages never embed.
    expect(embed.mock.calls.every((c) => (c as unknown[])[0] === 'unrelated')).toBe(true);
  });

  it('pins UTF-16 offsets for an emoji fixture, with leading whitespace and repeated substrings', async () => {
    const { db, wiki, svc, sync } = await setup(kind);
    const text = `   😀😀 zebrafish 😀 zebrafish ${'x '.repeat(10)}`;
    await svc.storeSource(E, { sourceRef: 'e.md', sourceHash: hash('c'), text });
    await sync();
    const b = await read(wiki, E, { query: 'zebrafish', charBudget: 14 });
    const it = b.sources![0]!;
    expect(it.truncated).toBe(true);
    // Widest whitespace-bounded window containing the EARLIEST zebrafish that fits 14 units.
    expect(it.text).toBe('😀😀 zebrafish');
    expect(it.startOffset).toBe(3);
    expect(it.endOffset).toBe(it.startOffset + 14);
    expect(it.text.indexOf('zebrafish') + it.startOffset).toBe(text.indexOf('zebrafish'));
    checkOffsets(b.sources!, await storedText(db, E, 'e.md'));
  });

  it('caps maxPassages, and windows long passages with true offsets', async () => {
    const { db, wiki, svc, sync } = await setup(kind);
    for (let i = 0; i < 12; i++) {
      await svc.storeSource(E, { sourceRef: `n${i}.md`, sourceHash: hash(i.toString(16)), text: `marmot ${i}` });
    }
    await sync();
    expect((await read(wiki, E, { query: 'marmot' })).sources).toHaveLength(8);
    expect((await read(wiki, E, { query: 'marmot', maxPassages: 3 })).sources).toHaveLength(3);

    // A full-size 12,000-unit passage: whitespace-bounded window with true offsets.
    const body = 'lorem ipsum '.repeat(1000); // 12,000 units
    const text = `${body}ocelot ${body}`;
    await svc.storeSource(E, { sourceRef: 'big.md', sourceHash: hash('d'), text });
    await sync();
    const b = await read(wiki, E, { query: 'ocelot', charBudget: 50 });
    const it = b.sources!.find((s) => s.sourceRef === 'big.md')!;
    expect(it.truncated).toBe(true);
    expect(it.text).toContain('ocelot');
    expect(it.text.length).toBeGreaterThan('ocelot'.length); // widest fit, not just the match
    expect(it.text.length).toBeLessThanOrEqual(50);
    expect(it.text.length).toBeGreaterThan(40); // no further whole token fits
    const full = await storedText(db, E, 'big.md');
    expect(full.slice(it.startOffset, it.endOffset)).toBe(it.text);
    expect(/\s/.test(full[it.startOffset - 1]!)).toBe(true);
    expect(/\s/.test(full[it.endOffset]!)).toBe(true);
    expect(/^\S/.test(it.text) && /\S$/.test(it.text)).toBe(true);
  });

  it('charBudget is per entity: windows together never exceed it; blank query throws', async () => {
    const { wiki, svc, sync } = await setup(kind);
    const body = 'lorem ipsum '.repeat(100);
    for (let i = 0; i < 3; i++) {
      await svc.storeSource(E, { sourceRef: `k${i}.md`, sourceHash: hash(i.toString(16)), text: `${body}okapi ${body}` });
    }
    await sync();
    const b = await read(wiki, E, { query: 'okapi', charBudget: 100 });
    expect(b.sources!.length).toBeGreaterThanOrEqual(1);
    expect(b.sources!.reduce((n, s) => n + (s.endOffset - s.startOffset), 0)).toBeLessThanOrEqual(100);
    expect(b.sources![0]!.text).toContain('okapi');
    await expect(read(wiki, E, { query: '   ' })).rejects.toThrow(/sources\.query/);
  });

  it('hard-cuts a long-token match from the match start and never drops it', async () => {
    const { db, wiki, svc, sync } = await setup(kind);
    const token = `pangolin${'q'.repeat(200)}`;
    const text = `before ${token} after`;
    await svc.storeSource(E, { sourceRef: 't.md', sourceHash: hash('e'), text });
    await sync();
    const b = await read(wiki, E, { query: 'pangolin', charBudget: 30 });
    const it = b.sources![0]!;
    expect(it.truncated).toBe(true);
    expect(it.startOffset).toBe(7);
    expect(it.endOffset).toBe(37);
    expect(it.text).toHaveLength(30);
    checkOffsets(b.sources!, await storedText(db, E, 't.md'));
  });

  it('two entities with the same sourceRef: one group per entity, capped separately', async () => {
    const { wiki, svc, sync } = await setup(kind);
    for (const [ent, c] of [['entA', 'a'], ['entB', 'b']] as const) {
      for (let i = 0; i < 4; i++) {
        await svc.storeSource(ent, { sourceRef: `d${i}.md`, sourceHash: hash(c + i), text: `wombat ${ent} ${i}` });
      }
    }
    await sync();
    const b = await read(wiki, ['entA', 'entB'], { query: 'wombat', maxPassages: 2 });
    const group = (e: string) => b.sources!.filter((s) => s.entityId === e);
    expect(group('entA')).toHaveLength(2);
    expect(group('entB')).toHaveLength(2);
    expect(b.sources!.map((s) => s.entityId)).toEqual(['entA', 'entA', 'entB', 'entB']);
    expect(group('entA').every((s) => s.text.includes('entA'))).toBe(true);
  });

  it('absent option: no sources key and the pre-option bundle shape', async () => {
    const { wiki, svc, sync, strategy } = await setup(kind);
    await svc.storeSource(E, { sourceRef: 'a.md', sourceHash: hash('a'), text: 'quokka' });
    await sync();
    const spy = vi.spyOn(strategy as { searchPassages: never }, 'searchPassages');
    const b = await wiki.read(E, 'quokka');
    expect(Object.keys(b).sort()).toEqual(['edges', 'events', 'facts', 'tasks']);
    expect('sources' in b).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('degraded strategy', () => {
  it('UnavailableIndexStrategy yields an empty sources group without throwing', async () => {
    const { wiki } = await setup('mini');
    (wiki as unknown as { searchService: { setIndexStrategy(s: IndexStrategy): void } })
      .searchService.setIndexStrategy(new UnavailableIndexStrategy(new Error('down')));
    const b = await wiki.read(E, '', { sources: { query: 'quokka' } });
    expect(b.sources).toEqual([]);
  });
});
