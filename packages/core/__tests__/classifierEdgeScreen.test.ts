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
