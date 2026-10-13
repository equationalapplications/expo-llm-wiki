// packages/core/__tests__/searchUnavailableCallSites.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiDiagnostic, WikiOptions } from '../src/types';

afterEach(() => vi.restoreAllMocks());
const P = 'llm_wiki_';
const vec = async (t: string) => (/apple/i.test(t) ? [1, 0, 0] : [0, 0, 1]);

async function wikiWith(options: Partial<WikiOptions>) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Fts5IndexStrategy.prototype, 'init').mockRejectedValue(new Error('locked'));
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async () => '{"facts":[],"tasks":[]}');
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, ...(options.llmProvider ?? {}) },
    config: options.config,
    onDiagnostic: (d) => diagnostics.push(d),
    onRetrievalFallback: options.onRetrievalFallback,
  } as WikiOptions);
  await wiki.setup();
  await db.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('embedding_dimension', '3')`);
  return { db, wiki, diagnostics, generateText };
}
async function factWithVec(db: ReturnType<typeof openTestDatabase>, id: string, title: string, v: number[], sourceType = 'user_stated') {
  await db.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, embedding_blob)
     VALUES (?, 'u', ?, 'b', '[]', 'inferred', ?, 1, 1, ?)`,
    [id, title, sourceType, new Uint8Array(new Float32Array(v).buffer)]);
}

describe('keyword outage call-site map', () => {
  it('(n′) hybrid blend (:223) degrades to vector-only results', async () => {
    const { db, wiki } = await wikiWith({ llmProvider: { embed: vec } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    const r = await wiki.read('u', 'apple', { hybridWeight: 0.5 });
    expect(r.facts[0]?.id).toBe('f-apple');
  });

  it('(n) prefilter host (:189) propagates via the two-hop path and fires onRetrievalFallback', async () => {
    const onRetrievalFallback = vi.fn();
    const { db, wiki } = await wikiWith({ llmProvider: { embed: vec } as any, config: { preFilterLimit: 10 } as any, onRetrievalFallback });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    const embeddingLoad = vi.spyOn((wiki.__testAccess as any).entryRepo, 'findWithEmbeddingsByEntityIds');
    await expect(wiki.read('u', 'apple')).rejects.toMatchObject({ name: 'WikiSearchUnavailableError' });
    expect(onRetrievalFallback).toHaveBeenCalled();
    expect(embeddingLoad).not.toHaveBeenCalled(); // no full-candidate embedding load
  });

  it('keyword-only read (no embed provider) propagates (:550/:719)', async () => {
    const { wiki } = await wikiWith({});
    await expect(wiki.read('u', 'apple')).rejects.toMatchObject({ name: 'WikiSearchUnavailableError' });
  });

  it('(o) heal skips the LLM pass: one diagnostic, no generateText, no heal_checked_at stamps', async () => {
    // Disable the orphan/stale SQL passes: the epoch-timestamped fixture row would otherwise be soft-deleted before candidate selection.
    const { db, wiki, diagnostics, generateText } = await wikiWith({ config: { orphanAfterDays: null, staleInferredAfterDays: null } as any });
    await factWithVec(db, 'c1', 'inferred thing', [0, 0, 1], 'librarian_inferred');
    await wiki.runHeal('u');
    expect(generateText).not.toHaveBeenCalled();
    expect(diagnostics.filter((d) => d.code === 'heal_skipped' && d.detail?.reason === 'keyword_search_unavailable')).toHaveLength(1);
    const row = await db.getFirstAsync<{ heal_checked_at: number | null }>(`SELECT heal_checked_at FROM ${P}entries WHERE id = 'c1'`);
    expect(row!.heal_checked_at).toBeNull();
  });

  it('(e-gate i) a pass that cannot need keyword mode RUNS during an outage', async () => {
    const { db, wiki, generateText } = await wikiWith({ llmProvider: { embed: vec } as any, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).toHaveBeenCalled(); // extraction happened
  });

  it('(e-gate ii) a pass that could need keyword mode aborts before runExtract, watermark kept', async () => {
    const { db, wiki, generateText } = await wikiWith({ config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any }); // no embed provider
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).not.toHaveBeenCalled();
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u', db)).toBeNull();
  });

  it('(e-gate mid-pass) an embed failure routes a candidate into keyword mode at :143 → abort, watermark kept', async () => {
    // Embed provider present + stored vectors ⇒ the pre-check lets the pass run;
    // the candidate's embed then fails, gate.ts falls through to searchKeyword,
    // which throws WikiSearchUnavailableError and aborts the pass.
    const failingEmbed = async () => { throw new Error('embed down'); };
    const { db, wiki, generateText } = await wikiWith({ llmProvider: { embed: failingEmbed } as any, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } as any });
    await factWithVec(db, 'f-apple', 'apple fruit', [1, 0, 0]);
    await db.runAsync(`INSERT INTO ${P}events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','apple',100)`);
    generateText.mockResolvedValueOnce(JSON.stringify({ facts: [{ title: 'apple pie', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }));
    await wiki.runLibrarian('u').catch(() => {});
    expect(generateText).toHaveBeenCalledTimes(1); // extraction only; no resolve call
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u', db)).toBeNull();
    expect((await db.getAllAsync(`SELECT 1 FROM ${P}entries`)).length).toBe(1); // no new rows
  });
});
