import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWiki } from '../src/index';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode, HASH_A, HASH_B } from './helpers/diagnosticsHarness';
import { WikiIngestEmptyError } from '../src/types';
import { ONTOLOGY_ABSTAIN_SENTINEL } from '../src/utils/ontology';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, WikiConfig, WikiDiagnostic } from '../src/types';

// specs/ingest-time-typing: the engaged ingest door (Test plan 3-13).
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residence' }],
};
const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});
const F = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: `${title} body`, tags: [], confidence: 'certain', ...extra });
const ON = { systemOne: { typeOnIngest: 'auto' } } as WikiConfig;

interface Opts {
  chunks?: Record<string, unknown[]>; // keyed by marker text present in the chunk
  facts?: unknown[];
  classify?: (r: ClassifyRequest) => Promise<ClassifyResponse> | ClassifyResponse;
  noClassify?: boolean;
  config?: WikiConfig;
  mode?: 'strict' | 'emergent' | 'off';
  manifest?: OntologyManifest;
  extraGen?: (p: { systemPrompt: string; userPrompt: string }) => unknown;
}
async function mk(o: Opts = {}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const prompts: string[] = [];
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => {
    prompts.push(p.systemPrompt);
    if (o.extraGen) { const r = o.extraGen(p); if (r !== undefined) return JSON.stringify(r); }
    if (o.chunks) {
      for (const [marker, facts] of Object.entries(o.chunks)) if (p.userPrompt.includes(marker)) return JSON.stringify({ facts });
      return 'not json';
    }
    return JSON.stringify({ facts: o.facts ?? [] });
  });
  const classify = o.classify && !o.noClassify ? vi.fn(async (r: ClassifyRequest) => o.classify!(r)) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    config: { autoLibrarianThreshold: 1000, ...(o.config ?? ON) },
    onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d),
  } as any);
  await wiki.setup();
  if (o.mode !== 'off') await wiki.setOntologyManifest('u', o.manifest ?? MANIFEST, { mode: o.mode ?? 'strict' });
  return { db, wiki, generateText, classify, diagnostics, prompts };
}
type T = Awaited<ReturnType<typeof mk>>;
const rows = (db: any) => db.getAllAsync(`SELECT id, title, okf_type, ontology_checked_at, source_hash FROM llm_wiki_entries WHERE deleted_at IS NULL ORDER BY title`) as Promise<any[]>;
const edgeRows = (db: any) => db.getAllAsync(`SELECT * FROM llm_wiki_edges`) as Promise<any[]>;
const ingest = (t: T, doc = 'content here', hash = HASH_A, extra: Record<string, unknown> = {}) =>
  t.wiki.ingestDocument('u', { sourceRef: 'doc.md', sourceHash: hash, documentChunk: doc, ...extra });
const TWO = 'ALPHA chunk text here.\n\nBROKEN chunk text here.';
const SMALL = { maxChunkLength: 30, chunkOverlap: 0 };
const withCfg = (c: WikiConfig): WikiConfig => ({ ...ON, ...c, systemOne: { ...(ON.systemOne as object), ...((c as any).systemOne ?? {}) } } as WikiConfig);

afterEach(() => vi.restoreAllMocks());

describe('engagement and prompt (Test plan 3, 4)', () => {
  it('engaged: every chunk prompt equals the mode-off prompt, and getInstructions().ingest matches', async () => {
    const on = await mk({ facts: [F('Ada')], classify: () => choice('person') });
    await ingest(on);
    const off = await mk({ facts: [F('Ada')], mode: 'off', classify: () => choice('person') });
    await ingest(off);
    expect(on.prompts).toEqual(off.prompts);
    expect(on.prompts[0]).not.toContain('person');
    const instr = await on.wiki.getInstructions('u');
    const offInstr = await off.wiki.getInstructions('u');
    expect(instr.ingest).toBe(offInstr.ingest);
    // librarian and backfill unchanged by typeOnIngest
    const llm = await mk({ facts: [], config: {}, classify: () => choice('person') });
    const llmInstr = await llm.wiki.getInstructions('u');
    expect(instr.librarian).toBe(llmInstr.librarian);
    expect(instr.ontologyBackfill).toBe(llmInstr.ontologyBackfill);
    expect(llmInstr.ingest).toContain('person');
  });
  it('a placeholder override has its ontology placeholders stripped', async () => {
    const t = await mk({ facts: [F('Ada')], classify: () => choice('person') });
    await ingest(t, 'x', HASH_A, { promptOverride: 'Mine {{ontologyManifest}}|{{ontologyModeInstructions}}|' });
    expect(t.prompts[0]).not.toContain('{{ontology');
    expect(t.prompts[0]).not.toContain('person');
  });
  it.each([
    ['no key', { config: {} as WikiConfig, classify: true, mode: 'strict' }],
    ['llm key', { config: { systemOne: { typeOnIngest: 'llm' } } as WikiConfig, classify: true, mode: 'strict' }],
    ['no classify', { config: ON, classify: false, mode: 'strict' }],
    ['mode off', { config: ON, classify: true, mode: 'off' }],
    ['unrepresentable manifest', { config: ON, classify: true, mode: 'strict', manifest: { node_types: [], edge_types: [] } }],
  ] as const)('%s: not engaged (no classify call, no typing receipt, no typing on result)', async (_n, c) => {
    const t = await mk({ facts: [F('Ada')], config: c.config, mode: c.mode as any, noClassify: !c.classify, classify: () => choice('person'), manifest: (c as any).manifest });
    const r = await ingest(t);
    expect(t.classify?.mock.calls.length ?? 0).toBe(0);
    expect(r.typing).toBeUndefined();
    expect(ofCode(t.diagnostics, 'node_type_assigned').filter((d) => d.detail.writer === 'classifier')).toEqual([]);
    expect(t.diagnostics.filter((d) => d.code.startsWith('classification_'))).toEqual([]);
  });
});

describe('accepted type, full path (Test plan 5)', () => {
  it('stores the type, receipts it, counts it, writes no outgoing edge, keeps it out of backfill', async () => {
    const t = await mk({
      facts: [F('Ada'), F('Paris', { okf_type: 'place' }), F('Bob', { okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Paris' }] })],
      classify: () => choice('person', 0.7),
    });
    const r = await ingest(t);
    const rs = await rows(t.db);
    const by = Object.fromEntries(rs.map((x) => [x.title, x]));
    expect(by.Ada.okf_type).toBe('person');
    expect(by.Ada.ontology_checked_at).toBeNull();
    const assigned = ofCode(t.diagnostics, 'node_type_assigned');
    const ada = assigned.find((d) => d.detail.factId === by.Ada.id)!;
    expect(ada.detail).toEqual({ factId: by.Ada.id, okfType: 'person', writer: 'classifier', confidence: 0.7, sourceRef: 'doc.md' });
    expect(ada.operation).toBe('ingest');
    expect(ada.trigger).toBe('call');
    // model-volunteered valid slugs are not asked and receipt writer llm
    expect(t.classify!.mock.calls).toHaveLength(1);
    expect(assigned.filter((d) => d.detail.writer === 'llm')).toHaveLength(2);
    expect(r.typing).toEqual({ asked: 1, typed: 1, abstained: 0, lowConfidence: 0, invalid: 0, skipped: 0 });
    const es = await edgeRows(t.db);
    expect(es.filter((e) => e.source_id === by.Ada.id)).toEqual([]);
    expect(es.filter((e) => e.source_id === by.Bob.id)).toHaveLength(1);
    expect((await (t.wiki.__testAccess as any).entryRepo.countUntypedByEntityId('u', Date.now())).eligible).toBe(0);
  });
  it('a classifier-typed fact can be an edge target within the same ingest', async () => {
    const t = await mk({
      facts: [F('Paris'), F('Bob', { okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Paris' }] })],
      classify: () => choice('place'),
    });
    await ingest(t);
    const by = Object.fromEntries((await rows(t.db)).map((x) => [x.title, x]));
    expect(by.Paris.okf_type).toBe('place');
    expect(await edgeRows(t.db)).toEqual([expect.objectContaining({ source_id: by.Bob.id, target_id: by.Paris.id })]);
  });
});

describe('accepted type, partial path (Test plan 6)', () => {
  it('types siblings with source_hash null, receipts carry sourceRef, a dedupe-skipped winner spends one call and stores nothing', async () => {
    const t = await mk({ config: withCfg(SMALL), chunks: { ALPHA: [F('Ada'), F('Eve')] }, classify: () => choice('person') });
    const r1 = await ingest(t, TWO);
    expect(r1.failedChunks).toBe(1);
    const rs = await rows(t.db);
    expect(rs.map((x) => [x.title, x.okf_type, x.source_hash])).toEqual([['Ada', 'person', null], ['Eve', 'person', null]]);
    expect(ofCode(t.diagnostics, 'node_type_assigned').map((d) => d.detail.sourceRef)).toEqual(['doc.md', 'doc.md']);
    expect(r1.typing?.typed).toBe(2);
    // Retry: same winners already live for the sourceRef.
    t.diagnostics.length = 0;
    const calls = t.classify!.mock.calls.length;
    const r2 = await ingest(t, TWO);
    expect(t.classify!.mock.calls.length - calls).toBe(2);
    expect(ofCode(t.diagnostics, 'fact_deduplicated')).toHaveLength(2);
    expect(r2.typing?.typed).toBe(0);
    expect(await rows(t.db)).toHaveLength(2);
  });
});

describe('every non-accept outcome (Test plan 7)', () => {
  const cases: Array<[string, (r: ClassifyRequest) => ClassifyResponse | Promise<ClassifyResponse>, string, Record<string, unknown>]> = [
    ['abstain', () => choice(ONTOLOGY_ABSTAIN_SENTINEL, 0.99), 'classification_abstained', { writer: 'classifier' }],
    ['below floor', () => choice('person', 0.4), 'classification_low_confidence', { reason: 'below_threshold' }],
    ['not offered', () => choice('robot'), 'classification_invalid', { reason: 'choice_not_offered' }],
    ['kind mismatch', () => ({ answers: { okf_type: { kind: 'boolean', value: true, confidence: 1 } } } as any), 'classification_invalid', { reason: 'kind_mismatch' }],
    ['malformed', () => ({} as any), 'classification_invalid', {}],
    ['thrown', () => { throw new Error('boom'); }, 'classification_invalid', { reason: 'classify_threw' }],
    ['overflow', () => { throw new Error('maximum context length exceeded'); }, 'context_overflow_skipped', {}],
  ];
  it.each(cases)('%s writes untyped and unstamped with the section 9 receipt', async (_n, classify, code, detail) => {
    const t = await mk({ facts: [F('Ada')], classify });
    const r = await ingest(t);
    const [row] = await rows(t.db);
    expect(row.okf_type).toBeNull();
    expect(row.ontology_checked_at).toBeNull();
    const got = ofCode(t.diagnostics, code as any);
    expect(got).toHaveLength(1);
    expect(got[0].detail).toEqual({ factId: row.id, sourceRef: 'doc.md', ...detail, ...(code === 'classification_invalid' && !('reason' in detail) ? { reason: expect.any(String) } : {}) });
    expect(ofCode(t.diagnostics, 'node_type_assigned')).toEqual([]);
    expect((await (t.wiki.__testAccess as any).entryRepo.countUntypedByEntityId('u', Date.now())).eligible).toBe(1);
    expect(r.typing!.typed).toBe(0);
  });
  it('the floor itself is accepted; just below is not', async () => {
    const at = await mk({ facts: [F('Ada')], classify: () => choice('person', 0.5) });
    await ingest(at);
    expect((await rows(at.db))[0].okf_type).toBe('person');
    const below = await mk({ facts: [F('Ada')], classify: () => choice('person', 0.5 - 1e-9) });
    await ingest(below);
    expect((await rows(below.db))[0].okf_type).toBeNull();
  });
});

describe('candidate set, ordering, concurrency (Test plan 8)', () => {
  it('cross-chunk dedupe losers and volunteered valid slugs are never asked', async () => {
    const t = await mk({
      config: withCfg(SMALL),
      chunks: { ALPHA: [F('Ada'), F('Paris', { okf_type: 'place' })], SECOND: [F('Ada'), F('Bob')] },
      classify: () => choice('person'),
    });
    const r = await ingest(t, 'ALPHA chunk text here.\n\nSECOND chunk text here.');
    // winners: Ada, Paris(volunteered), Bob -> asked Ada and Bob
    expect(t.classify!.mock.calls).toHaveLength(2);
    expect(r.typing!.asked).toBe(2);
  });
  it('total failure throws with zero classify calls; zero winners -> zero calls and zero counters', async () => {
    const t = await mk({ extraGen: () => 'nope' as any, classify: () => choice('person') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ingest(t)).rejects.toBeInstanceOf(WikiIngestEmptyError);
    expect(t.classify).toHaveBeenCalledTimes(0);
    const z = await mk({ facts: [], classify: () => choice('person') });
    const r = await ingest(z);
    expect(z.classify).toHaveBeenCalledTimes(0);
    expect(r.typing).toEqual({ asked: 0, typed: 0, abstained: 0, lowConfidence: 0, invalid: 0, skipped: 0 });
  });
  it('classify fan-out honors params.chunkConcurrency over config', async () => {
    let inflight = 0; let max = 0;
    const t = await mk({
      config: withCfg({ chunkConcurrency: 1 } as WikiConfig),
      facts: [F('A'), F('B'), F('C'), F('D'), F('E'), F('F')],
      classify: async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return choice('person'); },
    });
    await ingest(t, 'x', HASH_A, { chunkConcurrency: 3 });
    expect(max).toBe(3);
  });
});

describe('in-transaction re-validation (Test plan 9)', () => {
  it('a manifest edit that removes the accepted slug stores untyped with node_type_dropped', async () => {
    const t = await mk({
      facts: [F('Ada')],
      classify: async () => {
        await t2.wiki.setOntologyManifest('u', { node_types: [{ type: 'place', description: 'p' }], edge_types: [] }, { mode: 'strict' });
        return choice('person');
      },
    });
    const t2 = t;
    await ingest(t);
    const [row] = await rows(t.db);
    expect(row.okf_type).toBeNull();
    expect(ofCode(t.diagnostics, 'node_type_dropped').map((d) => d.detail)).toEqual([
      { factId: row.id, nodeType: 'person', reason: 'not_in_manifest', sourceRef: 'doc.md' },
    ]);
    expect(ofCode(t.diagnostics, 'node_type_assigned')).toEqual([]);
  });
  it('a mode flip to off stores untyped with no ontology receipt', async () => {
    const t = await mk({
      facts: [F('Ada')],
      classify: async () => { await t.wiki.setOntologyManifest('u', MANIFEST, { mode: 'off' }); return choice('person'); },
    });
    await ingest(t);
    expect((await rows(t.db))[0].okf_type).toBeNull();
    expect(t.diagnostics.filter((d) => ['node_type_assigned', 'node_type_dropped', 'node_type_folded', 'classification_abstained'].includes(d.code))).toEqual([]);
  });
  it('emergent: a merge that makes a raw slug resolve keeps the model slug and discards the classifier answer', async () => {
    const t = await mk({
      mode: 'emergent',
      facts: [F('R2', { okf_type: 'robot' })],
      extraGen: () => ({ facts: [F('R2', { okf_type: 'robot' })], ontology_updates: { node_types: [{ type: 'robot', description: 'A robot' }] } }),
      classify: () => choice('person'),
    });
    await ingest(t);
    const [row] = await rows(t.db);
    expect(row.okf_type).toBe('robot');
    expect(ofCode(t.diagnostics, 'node_type_assigned').map((d) => d.detail.writer)).toEqual(['llm']);
  });
});

describe('ingest_zero_facts under engagement (Test plan 10)', () => {
  it('fires on a full re-ingest that tombstones prior facts and extracts nothing', async () => {
    let empty = false;
    const t = await mk({ extraGen: () => (empty ? { facts: [] } : { facts: [F('Ada')] }), classify: () => choice('person') });
    await ingest(t, 'one', HASH_A);
    t.diagnostics.length = 0;
    empty = true;
    await ingest(t, 'two', HASH_B);
    expect(ofCode(t.diagnostics, 'ingest_zero_facts')).toHaveLength(1);
  });
  it('does not fire when the mode is off', async () => {
    let empty = false;
    const t = await mk({ mode: 'off', extraGen: () => (empty ? { facts: [] } : { facts: [F('Ada')] }), classify: () => choice('person') });
    await ingest(t, 'one', HASH_A);
    empty = true;
    await ingest(t, 'two', HASH_B);
    expect(ofCode(t.diagnostics, 'ingest_zero_facts')).toEqual([]);
  });
});

describe('metering (Test plan 11)', () => {
  it('no meter and no fits calls; llm_usage fires per classify call, estimated, operation ingest; unattempted 0', async () => {
    const t = await mk({
      config: withCfg({ reportLlmUsage: true } as WikiConfig),
      facts: [F('Ada'), F('Bob')],
      classify: () => choice('person'),
    });
    const fits = vi.fn();
    (t.wiki as any).options.llmProvider.fits = fits;
    const r = await ingest(t);
    expect(fits).not.toHaveBeenCalled();
    const usage = ofCode(t.diagnostics, 'llm_usage').filter((d) => d.operation === 'ingest');
    expect(usage).toHaveLength(3); // 1 chunk + 2 classify
    expect(usage.filter((d) => d.detail.estimated === true).length).toBeGreaterThanOrEqual(2);
    expect(r.typing).not.toHaveProperty('unattempted');
  });
});

describe('duplicate-hash race (Test plan 12)', () => {
  it('emits no typing receipt, has already reported llm_usage, and returns no typing', async () => {
    const t = await mk({ config: withCfg({ reportLlmUsage: true } as WikiConfig), facts: [F('Ada')], classify: () => choice('person') });
    const repo = (t.wiki as any).sourceRefIndexRepo;
    const original = repo.findActiveByEntityAndHash.bind(repo);
    // Call 1 is the 'skip' pre-check; the collision lands right after it (a writer that
    // commits between the check and our write). The typing stage's own look is 'ingest'-mode only.
    let calls = 0;
    repo.findActiveByEntityAndHash = async (entityId: string, hash: string, tx?: unknown) => {
      calls++;
      if (calls === 1) {
        await t.db.runAsync(
          `INSERT INTO llm_wiki_source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES ('sri_x', ?, ?, 'canonical.md', 0, NULL)`,
          [entityId, hash],
        );
        return null;
      }
      return original(entityId, hash, tx);
    };
    const r = await t.wiki.ingestDocument('u', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'x' }, { onDuplicateHash: 'skip' });
    expect(r.duplicateOf).toBe('canonical.md');
    expect(r.typing).toBeUndefined();
    expect(t.classify).toHaveBeenCalledTimes(1);
    expect(ofCode(t.diagnostics, 'llm_usage').filter((d) => d.operation === 'ingest')).toHaveLength(2);
    expect(t.diagnostics.filter((d) => d.detail?.factId !== undefined)).toEqual([]);
  });
});

describe('backfill interaction (Test plan 13)', () => {
  it('a classifier-typed fact is not a backfill candidate; a declined one is', async () => {
    const t = await mk({ facts: [F('Ada'), F('Bob')], classify: (r) => ((r as any).state?.title === 'Ada' || JSON.stringify(r).includes('Ada') ? choice('person') : choice(ONTOLOGY_ABSTAIN_SENTINEL)) });
    await ingest(t);
    const by = Object.fromEntries((await rows(t.db)).map((x) => [x.title, x]));
    expect(by.Ada.okf_type).toBe('person');
    expect(by.Bob.okf_type).toBeNull();
    const untyped = await (t.wiki.__testAccess as any).entryRepo.findUntypedByEntityId('u', 10, Date.now());
    expect(untyped.map((x: any) => x.title)).toEqual(['Bob']);
  });
});

describe('engaged emergent, cross-chunk (round-2 fold)', () => {
  it('a slug a later chunk proposes beats the classifier type, and no manifest-violating edge is stored', async () => {
    const t = await mk({
      mode: 'emergent',
      config: withCfg(SMALL),
      extraGen: ({ userPrompt }) => userPrompt.includes('SECOND')
        ? { facts: [], ontology_updates: { node_types: [{ type: 'robot', description: 'A robot' }] } }
        : { facts: [F('R2', { okf_type: 'robot' }), F('Bob', { okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'R2' }] })] },
      classify: () => choice('place'),
    });
    await ingest(t, 'FIRST chunk text here.\n\nSECOND chunk text here.');
    const by = Object.fromEntries((await rows(t.db)).map((x) => [x.title, x]));
    expect(by.R2.okf_type).toBe('robot');
    expect(await edgeRows(t.db)).toEqual([]);
    expect(ofCode(t.diagnostics, 'edge_dropped').length).toBeGreaterThan(0);
    expect(ofCode(t.diagnostics, 'node_type_assigned').find((d) => d.detail.factId === by.R2.id)?.detail.writer).toBe('llm');
  });
});

describe('duplicate hash held by another sourceRef (round-2 fold)', () => {
  it('spends no classify call when another live sourceRef already holds the hash', async () => {
    const t = await mk({ facts: [F('Ada')], classify: () => choice('person') });
    await t.wiki.ingestDocument('u', { sourceRef: 'canonical.md', sourceHash: HASH_A, documentChunk: 'x' });
    const before = t.classify!.mock.calls.length;
    await expect(t.wiki.ingestDocument('u', { sourceRef: 'other.md', sourceHash: HASH_A, documentChunk: 'x' })).rejects.toThrow(/Duplicate source hash/);
    expect(t.classify!.mock.calls.length).toBe(before);
  });
});

describe('both keys on one host (round-2 fold)', () => {
  it('typeOnWrite and typeOnIngest both auto: ingest and librarian each type through classify', async () => {
    const t = await mk({
      config: { systemOne: { typeOnIngest: 'auto', typeOnWrite: 'auto' } } as WikiConfig,
      facts: [F('Ada')], classify: () => choice('person'),
    });
    const r = await ingest(t);
    expect(r.typing!.typed).toBe(1);
    const instr = await t.wiki.getInstructions('u');
    expect(instr.ingest).not.toContain('"node_types"');
    expect(instr.librarian).not.toContain('"node_types"');
  });
});
