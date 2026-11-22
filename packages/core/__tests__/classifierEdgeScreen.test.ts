import { describe, it, expect, vi, afterEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import { EntryRepository } from '../src/repositories/EntryRepository';
import type {
  ClassifyRequest,
  ClassifyResponse,
  OntologyManifest,
  SQLiteAdapter,
  WikiConfig,
  WikiDiagnostic,
} from '../src/types';

// Step 10 — classifier edge screen (specs/edge-suggestions-system-one).
// Tasks 7–8 of the plan: compatibility pins and edge-question map construction.

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' }],
};
const AUTO_EDGES: WikiConfig = {
  systemOne: { typing: 'auto', edges: 'auto', minConfidence: { edges: 0.7 } },
};

async function seed(db: SQLiteAdapter, id: string, title: string, updatedAt: number, okfType: string | null = null) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count, okf_type)
     VALUES (?, 'e1', ?, ?, '["t1"]', 'certain', 'user_stated', ?, ?, 0, ?)`,
    [id, title, `${title} body`, updatedAt, updatedAt, okfType],
  );
}

const typingAnswer = (state: string) => ({
  kind: 'choice' as const,
  choice: state.startsWith('Ada') ? 'person' : 'place',
  confidence: 0.9,
  probabilities: { [state.startsWith('Ada') ? 'person' : 'place']: 0.9 },
});

// Types by title and answers every edge question with a confident "no".
const classifyAll = async (r: ClassifyRequest): Promise<ClassifyResponse> => {
  const answers: ClassifyResponse['answers'] = {};
  for (const key of Object.keys(r.questions)) {
    answers[key] = key === 'okf_type' ? typingAnswer(r.state) : { kind: 'binary', probability: 0.05 };
  }
  return { answers };
};

async function makeWiki(opts: {
  config?: WikiConfig;
  classify?: boolean;
  manifest?: OntologyManifest;
  rows?: Array<[string, string, number, string | null]>;
} = {}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async (_p: string) => JSON.stringify({ classifications: [] }));
  const classify = opts.classify === false ? undefined : vi.fn(classifyAll);
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    onDiagnostic: (d) => { diagnostics.push(d); },
    ...(opts.config ? { config: opts.config } : {}),
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', opts.manifest ?? MANIFEST, { mode: 'strict' });
  for (const [id, title, at, type] of opts.rows ?? [['f_ada', 'Ada', 100, null]]) {
    await seed(db, id, title, at, type);
  }
  return { db, wiki, generateText, classify, diagnostics };
}

const edgeKeys = (r: ClassifyRequest) => Object.keys(r.questions).filter((k) => k.startsWith('edge:'));
const requestFor = (classify: ReturnType<typeof vi.fn>, prefix: string): ClassifyRequest =>
  classify.mock.calls.map((c) => c[0] as ClassifyRequest).find((r) => r.state.startsWith(prefix))!;

afterEach(() => { vi.restoreAllMocks(); });

describe('compatibility pins (I5, I6)', () => {
  it('no systemOne.edges key: classify request is exactly { okf_type }, no edges, no pool read — typing llm and legacy auto', async () => {
    const poolRead = vi.spyOn(EntryRepository.prototype, 'findShortlistRowsByEntityId');
    for (const config of [
      { ontology: { backfillClassifier: 'auto' as const } },
      { systemOne: { typing: 'auto' as const } },
      { systemOne: { typing: 'auto' as const, edges: 'llm' as const, minConfidence: { edges: 0.7 } } },
    ]) {
      const { wiki, classify, generateText } = await makeWiki({ config, rows: [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']] });
      const result = await wiki.runOntologyBackfill('e1');
      expect(generateText).not.toHaveBeenCalled();
      const reqs = classify!.mock.calls.map((c) => c[0] as ClassifyRequest);
      expect(reqs).toHaveLength(1);
      expect(Object.keys(reqs[0].questions)).toEqual(['okf_type']);
      expect(result.edgesAdded).toBe(0);
    }
    expect(poolRead).not.toHaveBeenCalled();
  });

  it('typing llm (generative): prompts are byte-identical with and without edges auto, classify never called', async () => {
    const rows: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']];
    const base = await makeWiki({ rows });
    await base.wiki.runOntologyBackfill('e1');
    const withEdges = await makeWiki({ rows, config: { systemOne: { typing: 'llm', edges: 'auto', minConfidence: { edges: 0.7 } } } });
    await withEdges.wiki.runOntologyBackfill('e1');
    expect(withEdges.classify).not.toHaveBeenCalled();
    expect(base.generateText).toHaveBeenCalled();
    expect(withEdges.generateText.mock.calls.map((c) => c[0])).toEqual(base.generateText.mock.calls.map((c) => c[0]));
  });

  it('edges auto with no classify method: generative prompts match the baseline', async () => {
    const rows: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']];
    const base = await makeWiki({ rows, classify: false });
    await base.wiki.runOntologyBackfill('e1');
    const auto = await makeWiki({ rows, classify: false, config: AUTO_EDGES });
    await auto.wiki.runOntologyBackfill('e1');
    expect(auto.generateText.mock.calls.length).toBeGreaterThan(0);
    expect(auto.generateText.mock.calls.map((c) => c[0])).toEqual(base.generateText.mock.calls.map((c) => c[0]));
  });

  it('full pass with legacy keys only matches an explicit edges llm pass (counters and diagnostics)', async () => {
    const rows: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, null]];
    const legacy = await makeWiki({ rows, config: { ontology: { backfillClassifier: 'auto' } } });
    const explicit = await makeWiki({ rows, config: { systemOne: { typing: 'auto', edges: 'llm' } } });
    const a = await legacy.wiki.runOntologyBackfill('e1');
    const b = await explicit.wiki.runOntologyBackfill('e1');
    expect(b).toEqual(a);
    expect(explicit.diagnostics.map((d) => d.code)).toEqual(legacy.diagnostics.map((d) => d.code));
  });

  it('escalation-leg prompt lists the classifier-typed facts of the same pass (in-step pool read kept)', async () => {
    // Zzz answers with low typing confidence so it escalates; Ada is typed by the classifier.
    const classify = vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => ({
      answers: Object.fromEntries(Object.keys(r.questions).map((k) => [
        k,
        k === 'okf_type'
          ? (r.state.startsWith('Ada')
            ? typingAnswer(r.state)
            : { kind: 'choice' as const, choice: 'place', confidence: 0.1, probabilities: { place: 0.1 } })
          : { kind: 'binary' as const, probability: 0.05 },
      ])),
    }));
    const db = openTestDatabase();
    const gen = vi.fn(async (_p: string) => JSON.stringify({ classifications: [] }));
    const w2 = createWiki(db, {
      llmProvider: { generateText: gen, classify },
      config: { systemOne: { ...AUTO_EDGES.systemOne, onLowConfidence: 'llm' } },
    });
    await w2.setup();
    await w2.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await seed(db, 'f_ada', 'Ada', 100);
    await seed(db, 'f_zzz', 'Zzz', 200);
    await w2.runOntologyBackfill('e1');
    expect(gen).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gen.mock.calls[0])).toContain('Ada');
  });
});

describe('edge-question map construction (task 8)', () => {
  it('zero candidates: no edge question; typing applies; no generative step', async () => {
    const { db, wiki, classify, generateText } = await makeWiki({ config: AUTO_EDGES });
    await wiki.runOntologyBackfill('e1');
    expect(edgeKeys(requestFor(classify!, 'Ada'))).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
    const row = await db.getFirstAsync<{ okf_type: string | null }>(`SELECT okf_type FROM ${PREFIX}entries WHERE id = 'f_ada'`);
    expect(row!.okf_type).toBe('person');
  });

  it('asks one edge question per (edge type, candidate) the target_type satisfies; mismatched candidates are never asked', async () => {
    const { wiki, classify } = await makeWiki({
      config: AUTO_EDGES,
      rows: [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place'], ['f_bob', 'Bob', 300, 'person']],
    });
    await wiki.runOntologyBackfill('e1');
    const req = requestFor(classify!, 'Ada');
    expect(edgeKeys(req)).toEqual(['edge:lives_in:f_ldn']);
    const q = req.questions['edge:lives_in:f_ldn'];
    expect(q.kind).toBe('binary');
    expect(q.instructions).toContain('lives_in');
    expect(q.instructions).toContain('Person lives in place');
    expect(q.instructions).toContain('London');
    expect(q.instructions).not.toContain('Ada');
  });

  it('(a) pool rows sharing a normalized title are never asked, under either row order', async () => {
    for (const order of [['f_p1', 'f_p2'], ['f_p2', 'f_p1']]) {
      const rows: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null]];
      order.forEach((id, i) => rows.push([id, i === 0 ? 'Paris' : 'paris', 200 + i, 'place']));
      rows.push(['f_ldn', 'London', 400, 'place']);
      const { wiki, classify, diagnostics } = await makeWiki({ config: AUTO_EDGES, rows });
      await wiki.runOntologyBackfill('e1');
      expect(edgeKeys(requestFor(classify!, 'Ada'))).toEqual(['edge:lives_in:f_ldn']);
      expect(diagnostics.filter((d) => d.code === 'edge_dropped')).toEqual([]);
    }
  });

  it("(b) a batch fact (including the source fact's own title) sharing a candidate's normalized title blocks that candidate", async () => {
    const { wiki, classify, diagnostics } = await makeWiki({
      config: AUTO_EDGES,
      rows: [
        ['f_ada', 'Ada', 100, null],
        ['f_ldn2', 'London', 150, null], // untyped batch fact sharing the candidate's title
        ['f_ada_pool', 'ada', 200, 'place'], // candidate sharing the source fact's own title
        ['f_ldn', 'London', 300, 'place'],
        ['f_rome', 'Rome', 400, 'place'],
      ],
    });
    await wiki.runOntologyBackfill('e1');
    expect(edgeKeys(requestFor(classify!, 'Ada'))).toEqual(['edge:lives_in:f_rome']);
    expect(diagnostics.filter((d) => d.code === 'edge_dropped')).toEqual([]);
  });

  it('an edge type containing ":" yields a working edge question (keys are never parsed)', async () => {
    const manifest: OntologyManifest = {
      node_types: MANIFEST.node_types,
      edge_types: [{ type: 'works:at', source_type: 'person', target_type: 'place', description: 'Works at' }],
    };
    const { db, wiki, classify } = await makeWiki({
      config: AUTO_EDGES,
      manifest,
      rows: [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']],
    });
    await wiki.runOntologyBackfill('e1');
    expect(edgeKeys(requestFor(classify!, 'Ada'))).toEqual(['edge:works:at:f_ldn']);
    const row = await db.getFirstAsync<{ okf_type: string | null }>(`SELECT okf_type FROM ${PREFIX}entries WHERE id = 'f_ada'`);
    expect(row!.okf_type).toBe('person');
  });

  it('one question per unique (edge type, candidate) when several definitions share a type name', async () => {
    const manifest: OntologyManifest = {
      node_types: MANIFEST.node_types,
      edge_types: [
        { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
        { type: 'lives_in', source_type: 'place', target_type: 'place', description: 'Place inside place' },
      ],
    };
    const { wiki, classify } = await makeWiki({
      config: AUTO_EDGES,
      manifest,
      rows: [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']],
    });
    await wiki.runOntologyBackfill('e1');
    expect(edgeKeys(requestFor(classify!, 'Ada'))).toEqual(['edge:lives_in:f_ldn']);
  });
});

// Tasks 9–12: band evaluation, invalid/missing answers, overflow retry, escalation gate.
const ADA_ROWS: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null], ['f_ldn', 'London', 200, 'place']];
const EDGE_KEY = 'edge:lives_in:f_ldn';
type EdgeAnswer = number | 'missing' | 'bad';

// Types Ada as a person (confidence `typingConf`) and answers the edge question per `edge`.
const classifyWith = (edge: EdgeAnswer, typingConf = 0.9) => vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => {
  const answers: ClassifyResponse['answers'] = {};
  for (const key of Object.keys(r.questions)) {
    if (key === 'okf_type') {
      answers[key] = { kind: 'choice', choice: 'person', confidence: typingConf, probabilities: { person: typingConf } };
    } else if (edge === 'missing') {
      continue;
    } else {
      answers[key] = { kind: 'binary', probability: edge === 'bad' ? 7 : edge };
    }
  }
  return { answers };
});

async function makeWikiWith(classify: ReturnType<typeof vi.fn>, config: WikiConfig, gen?: (p: string) => string) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async (p: string) => (gen ? gen(p) : JSON.stringify({ classifications: [] })));
  const wiki = createWiki(db, { llmProvider: { generateText, classify }, onDiagnostic: (d) => { diagnostics.push(d); }, config });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  for (const [id, title, at, type] of ADA_ROWS) await seed(db, id, title, at, type);
  return { db, wiki, generateText, diagnostics };
}
const typeOf = (db: SQLiteAdapter, id: string) =>
  db.getFirstAsync<{ okf_type: string | null }>(`SELECT okf_type FROM ${PREFIX}entries WHERE id = ?`, [id]);
const edgeCount = async (db: SQLiteAdapter) =>
  (await db.getAllAsync<{ id: string }>(`SELECT id FROM ${PREFIX}edges WHERE entity_id = 'e1'`)).length;
const genEdges = (_p: string) => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'London' }] }] });
// D4: `WikiDiagnosticDetail` has no `site` key (types.ts frozen, I3), so the edge site is marked by `detail.reason`.
const edgeSite = (d: WikiDiagnostic[]) => d.filter((x) => /^edge_/.test(x.detail?.reason ?? ''));
const choiceAnswer = (choice: string, confidence: number) => ({ kind: 'choice' as const, choice, confidence, probabilities: { [choice]: confidence } });

describe('band evaluation and edge conversion (task 9)', () => {
  it('item 2: typing accepted + confident yes persists the edge, writer classifier, edgesAdded nonzero', async () => {
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classifyWith(0.95), AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.edgesAdded).toBe(1);
    expect(await edgeCount(db)).toBe(1);
    expect(generateText).not.toHaveBeenCalled();
    expect(diagnostics.filter((d) => d.code === 'node_type_assigned').map((d) => (d.detail as { writer: string }).writer)).toEqual(['classifier']);
  });

  it('item 15: many confident no + one confident yes applies the yes and does not fall through', async () => {
    const db = openTestDatabase();
    const classify = vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => ({
      answers: Object.fromEntries(Object.keys(r.questions).map((k) => [
        k,
        k === 'okf_type' ? choiceAnswer('person', 0.9) : { kind: 'binary' as const, probability: k === EDGE_KEY ? 0.95 : 0.02 },
      ])),
    }));
    const generateText = vi.fn(async (_p: string) => JSON.stringify({ classifications: [] }));
    const wiki = createWiki(db, { llmProvider: { generateText, classify }, config: AUTO_EDGES });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    const rows: Array<[string, string, number, string | null]> = [...ADA_ROWS, ['f_rome', 'Rome', 300, 'place']];
    for (const [id, title, at, type] of rows) await seed(db, id, title, at, type);
    const result = await wiki.runOntologyBackfill('e1');
    expect(edgeKeys(requestFor(classify, 'Ada')).length).toBe(2);
    expect(result.edgesAdded).toBe(1);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('item 16 second half: an answer whose source_type does not match the chosen typing is discarded (no edge, no fallthrough)', async () => {
    const classify = vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => ({
      answers: Object.fromEntries(Object.keys(r.questions).map((k) => [
        k,
        k === 'okf_type' ? choiceAnswer('place', 0.9) : { kind: 'binary' as const, probability: 0.5 },
      ])),
    }));
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classify, AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect((await typeOf(db, 'f_ada'))!.okf_type).toBe('place');
    expect(result.edgesAdded).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
    expect(edgeSite(diagnostics)).toEqual([]);
  });

  it('item 18: p = 0.5 under floor 0.5 falls through; p = 0.4 under floor 0.6 is a terminal no', async () => {
    const cfg = (floor: number): WikiConfig => ({ systemOne: { typing: 'auto', edges: 'auto', minConfidence: { edges: floor } } });
    const a = await makeWikiWith(classifyWith(0.5), cfg(0.5), genEdges);
    await a.wiki.runOntologyBackfill('e1');
    expect(a.generateText).toHaveBeenCalledTimes(1);
    const b = await makeWikiWith(classifyWith(0.4), cfg(0.6), genEdges);
    await b.wiki.runOntologyBackfill('e1');
    expect(b.generateText).not.toHaveBeenCalled();
    expect(await edgeCount(b.db)).toBe(0);
    expect((await typeOf(b.db, 'f_ada'))!.okf_type).toBe('person');
  });
});

describe('invalid and missing answers, edge-site diagnostics (task 10)', () => {
  it('item 7: an out-of-range probability falls through, never applies, no classifier edge_dropped; generative drops still surface', async () => {
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classifyWith('bad'), AUTO_EDGES,
      () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Nowhere' }] }] }));
    await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(await edgeCount(db)).toBe(0);
    expect(diagnostics.filter((d) => d.code === 'edge_dropped')).toHaveLength(1);
    expect(edgeSite(diagnostics).map((d) => d.code)).toEqual(['classification_invalid']);
  });

  it('item 21: a classifier answering only okf_type keeps typing, no generative leg, no edges, one edge-site diagnostic with the missing count', async () => {
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classifyWith('missing'), AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(result.typed).toBe(1);
    expect(await edgeCount(db)).toBe(0);
    expect((await typeOf(db, 'f_ada'))!.okf_type).toBe('person');
    const site = edgeSite(diagnostics);
    expect(site).toHaveLength(1);
    expect(site[0].code).toBe('classification_invalid');
    expect(site[0].detail).toMatchObject({ factId: 'f_ada', reason: 'edge_answers_missing' });
  });

  it.todo('D4: edge-site detail carries site: "edge_screen" and asked/uncertain/invalid/missing counts (blocked: WikiDiagnosticDetail is closed, types.ts frozen)');

  it('volume pin: five uncertain answers emit ONE classification_low_confidence; a malformed answer emits ONE classification_invalid', async () => {
    const run = async (bad: boolean) => {
      const classify = vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => ({
        answers: Object.fromEntries(Object.keys(r.questions).map((k, i) => [
          k,
          k === 'okf_type' ? choiceAnswer('person', 0.9) : { kind: 'binary' as const, probability: bad && i === 1 ? 7 : 0.5 },
        ])),
      }));
      const db = openTestDatabase();
      const diagnostics: WikiDiagnostic[] = [];
      const wiki = createWiki(db, {
        llmProvider: { generateText: async () => JSON.stringify({ classifications: [] }), classify },
        onDiagnostic: (d) => { diagnostics.push(d); },
        config: AUTO_EDGES,
      });
      await wiki.setup();
      await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
      const rows: Array<[string, string, number, string | null]> = [['f_ada', 'Ada', 100, null]];
      for (let i = 1; i <= 5; i++) rows.push([`f_p${i}`, `Place${i}`, 200 + i, 'place']);
      for (const [id, title, at, type] of rows) await seed(db, id, title, at, type);
      await wiki.runOntologyBackfill('e1');
      return edgeSite(diagnostics);
    };
    const uncertain = await run(false);
    expect(uncertain.map((d) => d.code)).toEqual(['classification_low_confidence']);
    const malformed = await run(true);
    expect(malformed.map((d) => d.code)).toEqual(['classification_invalid']);
  });
});

describe('overflow retry-once (task 11)', () => {
  const overflow = () => new Error('context length exceeded: maximum context length');
  const stub = (afterRetry: () => ClassifyResponse) => vi.fn(async (r: ClassifyRequest): Promise<ClassifyResponse> => {
    if (edgeKeys(r).length > 0) throw overflow();
    return afterRetry();
  });
  const typingOnly = (): ClassifyResponse => ({ answers: { okf_type: choiceAnswer('person', 0.9) } });

  it('retry succeeds: typing applies, no edges, no fallthrough, one edge-site context_overflow_skipped', async () => {
    const classify = stub(typingOnly);
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classify, AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(classify).toHaveBeenCalledTimes(2);
    expect(Object.keys((classify.mock.calls[1][0] as ClassifyRequest).questions)).toEqual(['okf_type']);
    expect(result.typed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await edgeCount(db)).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
    const ov = diagnostics.filter((d) => d.code === 'context_overflow_skipped');
    expect(ov).toHaveLength(1);
    expect(ov[0].detail).toMatchObject({ factId: 'f_ada', reason: 'edge_screen_overflow_retry' });
    expect(diagnostics.filter((d) => d.code === 'classification_low_confidence' || d.code === 'classification_invalid')).toEqual([]);
  });

  it('retry overflows: overflow_skip as today (stamped untyped, no generative, no edge-site marker)', async () => {
    const classify = vi.fn(async (_r: ClassifyRequest): Promise<ClassifyResponse> => { throw overflow(); });
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classify, AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(classify).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(1);
    expect(generateText).not.toHaveBeenCalled();
    expect((await typeOf(db, 'f_ada'))!.okf_type).toBeNull();
    const ov = diagnostics.filter((d) => d.code === 'context_overflow_skipped');
    expect(ov).toHaveLength(1);
    expect(ov[0].detail).toEqual({ factId: 'f_ada' });
  });

  it('retry throws a non-overflow error: threw (skipped), no generative', async () => {
    const classify = stub(() => { throw new Error('boom'); });
    const { db, wiki, generateText } = await makeWikiWith(classify, AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.skipped).toBe(1);
    expect(generateText).not.toHaveBeenCalled();
    const row = await db.getFirstAsync<Record<string, unknown>>(`SELECT * FROM ${PREFIX}entries WHERE id = 'f_ada'`);
    expect(row!.okf_type).toBeNull();
    expect(Object.entries(row!).filter(([k, v]) => /checked/.test(k) && v != null)).toEqual([]);
  });

  it('retry throws WikiBudgetExhausted: unattempted and stopped', async () => {
    const { WikiBudgetExhausted } = await import('../src/utils/usage');
    const classify = stub(() => { throw new WikiBudgetExhausted(123, 0); });
    const { wiki } = await makeWikiWith(classify, AUTO_EDGES);
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.budgetStop).toBeDefined();
    expect(result.scanned).toBe(0);
  });

  it('a request without edge questions that overflows is never retried', async () => {
    const classify = vi.fn(async (_r: ClassifyRequest): Promise<ClassifyResponse> => { throw overflow(); });
    const { wiki } = await makeWikiWith(classify, { systemOne: { typing: 'auto' } });
    await wiki.runOntologyBackfill('e1');
    expect(classify).toHaveBeenCalledTimes(1);
  });
});

describe('escalation gate plumbing (task 12)', () => {
  it('item 3: an uncertain answer sends the fact un-stamped to the generative step; edgesAdded sums', async () => {
    const { db, wiki, generateText } = await makeWikiWith(classifyWith(0.5), AUTO_EDGES, genEdges);
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.edgesAdded).toBe(1);
    expect(result.typed).toBe(1);
    expect(await edgeCount(db)).toBe(1);
  });

  it('item 6: under onLowConfidence llm a low-confidence fact reaches generative wholesale, classifier edge answers discarded', async () => {
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classifyWith(0.95, 0.1), { systemOne: { ...AUTO_EDGES.systemOne, onLowConfidence: 'llm' } },
      () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person', edges: [] }] }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.edgesAdded).toBe(0);
    expect(await edgeCount(db)).toBe(0);
    expect(edgeSite(diagnostics)).toEqual([]);
  });

  it('item 11: a fallthrough adds nothing to failedValidation beyond the generative leg (merged === generative)', async () => {
    const unknownId = () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person', edges: [] }, { id: 'f_unknown', okf_type: 'person' }] });
    const { wiki } = await makeWikiWith(classifyWith(0.5), AUTO_EDGES, unknownId);
    const merged = await wiki.runOntologyBackfill('e1');
    expect(merged.failedValidation).toBe(1);
  });

  it('item 12: default onLowConfidence leave — fallthrough reaches generative, is not counted as an abstain, and is not stamped by the classifier step', async () => {
    const { db, wiki, generateText } = await makeWikiWith(classifyWith(0.5), AUTO_EDGES, genEdges);
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.abstained).toBe(0);
    expect((await typeOf(db, 'f_ada'))!.okf_type).toBe('person'); // re-decided by the generative step
  });

  it('item 13: ontology turned off mid-classifier — a fallthrough-only pass defers without calling generative', async () => {
    const db = openTestDatabase();
    const holder: { wiki?: ReturnType<typeof createWiki> } = {};
    const inner = classifyWith(0.5);
    const classify = vi.fn(async (r: ClassifyRequest) => {
      const res = await inner(r);
      await holder.wiki!.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
      return res;
    });
    const generateText = vi.fn(async (_p: string) => JSON.stringify({ classifications: [] }));
    const wiki = createWiki(db, { llmProvider: { generateText, classify }, config: AUTO_EDGES });
    holder.wiki = wiki;
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    for (const [id, title, at, type] of ADA_ROWS) await seed(db, id, title, at, type);
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(result.edgesAdded).toBe(0);
    expect(result.remaining).toBe(0);
    expect(await edgeCount(db)).toBe(0);
  });

  it('item 14 (re-pointed per D1): low-confidence + uncertain edge answers under llm joins escalated once; one generative decision; no edge-site diagnostic', async () => {
    const { wiki, generateText, diagnostics } = await makeWikiWith(classifyWith(0.5, 0.1), { systemOne: { ...AUTO_EDGES.systemOne, onLowConfidence: 'llm' } });
    await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(edgeSite(diagnostics)).toEqual([]);
  });

  it('item 19: under leave, a low-confidence fact with an uncertain edge answer is stamped and left — no generative, no edges, no edge-site diagnostic', async () => {
    const { db, wiki, generateText, diagnostics } = await makeWikiWith(classifyWith(0.5, 0.1), AUTO_EDGES);
    await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(await edgeCount(db)).toBe(0);
    expect((await typeOf(db, 'f_ada'))!.okf_type).toBeNull();
    expect(edgeSite(diagnostics)).toEqual([]);
  });
});
