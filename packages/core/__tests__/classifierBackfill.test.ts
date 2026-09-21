import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { ClassifyRequest, ClassifyResponse, OntologyConfig, OntologyManifest, SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' }],
};

async function seed(db: SQLiteAdapter, id: string, title: string, updatedAt: number) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
     VALUES (?, 'e1', ?, ?, '["t1"]', 'certain', 'user_stated', ?, ?, 0)`,
    [id, title, `${title} body`, updatedAt, updatedAt],
  );
}

async function row(db: SQLiteAdapter, id: string) {
  return db.getFirstAsync<{ okf_type: string | null; ontology_checked_at: number | null }>(
    `SELECT okf_type, ontology_checked_at FROM ${PREFIX}entries WHERE id = ?`, [id]);
}

const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});

async function makeWiki(opts: {
  classify?: (r: ClassifyRequest) => Promise<ClassifyResponse>;
  ontology?: Partial<OntologyConfig>;
  manifest?: OntologyManifest;
} = {}) {
  const db = openTestDatabase();
  const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
  const classify = opts.classify ? vi.fn(opts.classify) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    ...(opts.ontology ? { config: { ontology: opts.ontology } } : {}),
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', opts.manifest ?? MANIFEST, { mode: 'strict' });
  await seed(db, 'f_ada', 'Ada', 100);
  await seed(db, 'f_ldn', 'London', 200);
  return { db, wiki, generateText, classify };
}

const byTitle = async (r: ClassifyRequest) => choice(r.state.startsWith('Ada') ? 'person' : 'place');

describe('runOntologyBackfill classifier mode', () => {
  it('REQ-COMPAT-01.5: a provider with classify still uses the LLM path by default', async () => {
    const { wiki, generateText, classify } = await makeWiki({ classify: byTitle });
    await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("classifier: 'auto' types each fact with one choice question over the manifest slugs", async () => {
    const { db, wiki, generateText, classify } = await makeWiki({ classify: byTitle });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(generateText).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledTimes(2);
    const req = classify!.mock.calls[0][0] as ClassifyRequest;
    expect(Object.keys(req.questions)).toEqual(['okf_type']);
    expect(req.questions.okf_type).toMatchObject({ kind: 'choice', options: ['person', 'place'] });
    expect(req.state).toBe('Ada\n\nAda body\n\nTags: t1');
    expect(result).toEqual({ scanned: 2, typed: 2, failedValidation: 0, edgesAdded: 0, skipped: 0, remaining: 0, deferred: 0 });
    expect((await row(db, 'f_ada'))!.okf_type).toBe('person');
    expect((await row(db, 'f_ldn'))!.okf_type).toBe('place');
  });

  it('config default ontology.backfillClassifier applies; call option llm overrides it', async () => {
    const a = await makeWiki({ classify: byTitle, ontology: { backfillClassifier: 'auto' } });
    await a.wiki.runOntologyBackfill('e1');
    expect(a.classify).toHaveBeenCalled();
    const b = await makeWiki({ classify: byTitle, ontology: { backfillClassifier: 'auto' } });
    await b.wiki.runOntologyBackfill('e1', { classifier: 'llm' });
    expect(b.classify).not.toHaveBeenCalled();
    expect(b.generateText).toHaveBeenCalled();
  });

  it('low confidence → omission: untyped, cooldown-stamped, not failedValidation', async () => {
    const { db, wiki } = await makeWiki({ classify: async () => choice('person', 0.2) });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 0, failedValidation: 0, skipped: 0, remaining: 0, deferred: 2 });
    expect((await row(db, 'f_ada'))!.okf_type).toBeNull();
    expect((await row(db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
  });

  it('respects classifyMinConfidence', async () => {
    const { wiki } = await makeWiki({ classify: async () => choice('person', 0.2), ontology: { classifyMinConfidence: 0.1 } });
    expect((await wiki.runOntologyBackfill('e1', { classifier: 'auto' })).typed).toBe(2);
  });

  it('off-manifest choice and NaN probability → failedValidation, stamped', async () => {
    let n = 0;
    const { db, wiki } = await makeWiki({
      classify: async () => (n++ === 0
        ? choice('planet')
        : { answers: { okf_type: { kind: 'choice', choice: 'place', confidence: Number.NaN, probabilities: {} } } }),
    });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 0, failedValidation: 2, skipped: 0 });
    expect((await row(db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
  });

  it('thrown classify → skipped, not stamped, siblings still applied', async () => {
    const { db, wiki } = await makeWiki({
      classify: async (r) => { if (r.state.startsWith('Ada')) throw new Error('down'); return choice('place'); },
    });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 1, skipped: 1, failedValidation: 0 });
    expect((await row(db, 'f_ada'))!.ontology_checked_at).toBeNull();
    expect((await row(db, 'f_ldn'))!.okf_type).toBe('place');
  });

  it('falls back to the LLM path for more than 255 node types', async () => {
    const big: OntologyManifest = {
      node_types: Array.from({ length: 256 }, (_, i) => ({ type: `t${i}`, description: 'x' })),
      edge_types: [],
    };
    const { wiki, generateText, classify } = await makeWiki({ classify: byTitle, manifest: big });
    await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(classify).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled();
  });

  it("falls back to the LLM path when 'auto' is requested but classify is absent", async () => {
    const { wiki, generateText } = await makeWiki();
    await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(generateText).toHaveBeenCalled();
  });
});

describe('classifier backfill — edge cases', () => {
  it('aborts without writes when ontology is disabled while classify is in flight', async () => {
    let wikiRef: typeof wiki | undefined;
    const { db, wiki } = await makeWiki({
      classify: async () => {
        await wikiRef!.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
        return choice('person');
      },
    });
    wikiRef = wiki;
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 0, typed: 0, failedValidation: 0, remaining: 0, skipped: 0, deferred: 0 });
    expect((await row(db, 'f_ada'))!.okf_type).toBeNull();
    expect((await row(db, 'f_ada'))!.ontology_checked_at).toBeNull();
  });

  it('honors chunkConcurrency as the classify concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const db = openTestDatabase();
    const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
    const wiki = createWiki(db, {
      llmProvider: {
        generateText,
        classify: async () => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return choice('person');
        },
      },
      config: { chunkConcurrency: 2, ontology: { backfillClassifier: 'auto' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    for (let i = 0; i < 6; i++) await seed(db, `f${i}`, `Fact ${i}`, i);
    await wiki.runOntologyBackfill('e1');
    expect(peak).toBe(2);
  });
});