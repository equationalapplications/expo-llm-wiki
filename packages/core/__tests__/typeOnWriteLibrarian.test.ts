import { describe, it, expect, vi } from 'vitest';
import { createWiki } from '../src/index';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, WikiDiagnostic, WikiConfig } from '../src/types';
import { runLegacyLibrarianPass } from '../src/services/librarian/legacy';

// specs/type-on-write: the librarian write door, both strategies (Test plan 6-10, 14).
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residence' }],
};
const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});
const fact = (title: string, extra: Record<string, unknown> = {}) =>
  ({ title, body: 'b', tags: [], confidence: 'certain', source_event: 'e1', ...extra });

export const STRATEGIES = ['legacy', 'ops'] as const;

interface Opts {
  strategy: 'legacy' | 'ops';
  facts: unknown[];
  classify?: (r: ClassifyRequest) => Promise<ClassifyResponse> | ClassifyResponse;
  typeOnWrite?: 'auto' | 'llm';
  config?: WikiConfig;
  mode?: 'strict' | 'emergent' | 'off';
  manifest?: OntologyManifest;
  noClassify?: boolean;
}
async function mk(o: Opts) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const prompts: string[] = [];
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => {
    prompts.push(p.systemPrompt);
    return JSON.stringify({ facts: o.facts, tasks: [] });
  });
  const classify = o.classify && !o.noClassify ? vi.fn(async (r: ClassifyRequest) => o.classify!(r)) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    config: {
      autoLibrarianThreshold: 1000,
      librarian: { strategy: o.strategy },
      ...(o.typeOnWrite ? { systemOne: { typeOnWrite: o.typeOnWrite } } : {}),
      ...(o.config ?? {}),
    },
    onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d),
  } as any);
  await wiki.setup();
  if (o.mode !== 'off') await wiki.setOntologyManifest('u', o.manifest ?? MANIFEST, { mode: o.mode ?? 'strict' });
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','Ada lives in London',100)`);
  return { db, wiki, generateText, classify, diagnostics, prompts };
}
const rows = (db: any) => db.getAllAsync(`SELECT id, title, okf_type, ontology_checked_at FROM llm_wiki_entries ORDER BY title`) as Promise<any[]>;
const edges = (db: any) => db.getAllAsync(`SELECT * FROM llm_wiki_edges`) as Promise<any[]>;

describe.each(STRATEGIES)('type on write (%s)', (strategy) => {
  it('an accepted answer at or above the floor types the row, receipts it, and keeps it out of backfill', async () => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('person', 0.5), typeOnWrite: 'auto' });
    await t.wiki.runLibrarian('u');
    const [r] = await rows(t.db);
    expect(r.okf_type).toBe('person');
    expect(r.ontology_checked_at).toBeNull();
    const a = ofCode(t.diagnostics, 'node_type_assigned');
    expect(a).toHaveLength(1);
    expect(a[0].detail).toEqual({ factId: r.id, okfType: 'person', writer: 'classifier', confidence: 0.5 });
    expect(a[0].operation).toBe('librarian');
    expect(await edges(t.db)).toHaveLength(0);
    const untyped = await (t.wiki.__testAccess as any).entryRepo.countUntypedByEntityId('u', Date.now());
    expect(untyped.eligible).toBe(0);
  });

  it('the engaged write prompt carries no ontology block and equals the off-mode prompt', async () => {
    const on = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('person'), typeOnWrite: 'auto' });
    await on.wiki.runLibrarian('u');
    expect(on.prompts[0]).not.toContain('Ontology constraints');
    const off = await mk({ strategy, facts: [fact('Ada Lovelace')], mode: 'off' });
    await off.wiki.runLibrarian('u');
    expect(on.prompts[0]).toBe(off.prompts[0]);
  });

  it.each([
    ['abstain', () => choice('none_of_these', 1), 'classification_abstained', { writer: 'classifier' }],
    ['below floor', () => choice('person', 0.5 - 1e-9), 'classification_low_confidence', { reason: 'below_threshold' }],
    ['choice_not_offered', () => choice('robot', 0.9), 'classification_invalid', { reason: 'choice_not_offered' }],
    ['kind_mismatch', () => ({ answers: { okf_type: { kind: 'binary', probability: 0.9 } } }), 'classification_invalid', { reason: 'kind_mismatch' }],
    ['malformed', () => null as any, 'classification_invalid', { reason: 'malformed' }],
    ['thrown', () => { throw new Error('boom'); }, 'classification_invalid', { reason: 'classify_threw' }],
    ['overflow', () => { throw new Error('maximum context length exceeded'); }, 'context_overflow_skipped', {}],
  ] as const)('%s: written untyped, unstamped, one receipt, eligible for backfill', async (_n, answer, code, detail) => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: answer as any, typeOnWrite: 'auto' });
    await t.wiki.runLibrarian('u');
    const [r] = await rows(t.db);
    expect(r.okf_type).toBeNull();
    expect(r.ontology_checked_at).toBeNull();
    const rec = ofCode(t.diagnostics, code as any);
    expect(rec).toHaveLength(1);
    expect(rec[0].detail).toEqual({ factId: r.id, ...detail });
    expect(ofCode(t.diagnostics, 'node_type_assigned')).toHaveLength(0);
    const untyped = await (t.wiki.__testAccess as any).entryRepo.countUntypedByEntityId('u', Date.now());
    expect(untyped.eligible).toBe(1);
  });

  it('a model-volunteered valid slug is not asked and receipts writer llm', async () => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace', { okf_type: 'person' })], classify: () => choice('place'), typeOnWrite: 'auto' });
    await t.wiki.runLibrarian('u');
    expect(t.classify).not.toHaveBeenCalled();
    const [r] = await rows(t.db);
    expect(r.okf_type).toBe('person');
    expect(ofCode(t.diagnostics, 'node_type_assigned').map((d) => d.detail)).toEqual([{ factId: r.id, okfType: 'person', writer: 'llm' }]);
  });

  it('a generative-typed fact receipts writer llm with no typeOnWrite key (default hosts)', async () => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace', { okf_type: 'person' })] });
    await t.wiki.runLibrarian('u');
    expect(ofCode(t.diagnostics, 'node_type_assigned').map((d) => d.detail.writer)).toEqual(['llm']);
  });

  it.each([
    ['no key', undefined, false],
    ["'llm'", 'llm' as const, false],
    ['no classify function', 'auto' as const, true],
  ])('compat: %s -> no classify call, today\'s appendix, no typing field', async (_n, key, noClassify) => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('person'), typeOnWrite: key, noClassify });
    await t.wiki.runLibrarian('u');
    if (t.classify) expect(t.classify).not.toHaveBeenCalled();
    expect(t.prompts[0]).toContain('Ontology constraints');
    const [r] = await rows(t.db);
    expect(r.okf_type).toBeNull();
    expect(ofCode(t.diagnostics, 'node_type_assigned')).toHaveLength(0);
  });

  it('mode off and an unrepresentable manifest disable the step', async () => {
    const off = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('person'), typeOnWrite: 'auto', mode: 'off' });
    await off.wiki.runLibrarian('u');
    expect(off.classify).not.toHaveBeenCalled();
    const big: OntologyManifest = { node_types: Array.from({ length: 255 }, (_, i) => ({ type: `t${i}`, description: 'd' })), edge_types: [] };
    const t = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('t0'), typeOnWrite: 'auto', manifest: big });
    await t.wiki.runLibrarian('u');
    expect(t.classify).not.toHaveBeenCalled();
    expect(t.prompts[0]).toContain('Ontology constraints');
  });

  it('emergent mode engages too', async () => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace')], classify: () => choice('person'), typeOnWrite: 'auto', mode: 'emergent' });
    await t.wiki.runLibrarian('u');
    expect(t.classify).toHaveBeenCalledTimes(1);
    expect((await rows(t.db))[0].okf_type).toBe('person');
    expect(t.prompts[0]).not.toContain('ontology_updates');
  });

  it('a manifest edit between the engagement check and the transaction drops the slug with node_type_dropped', async () => {
    let wikiRef: any;
    const t = await mk({
      strategy, facts: [fact('Ada Lovelace')], typeOnWrite: 'auto',
      classify: async () => {
        await wikiRef.setOntologyManifest('u', { node_types: [{ type: 'place', description: 'A place' }], edge_types: [] }, { mode: 'strict' });
        return choice('person');
      },
    });
    wikiRef = t.wiki;
    await t.wiki.runLibrarian('u');
    const [r] = await rows(t.db);
    expect(r.okf_type).toBeNull();
    const dropped = ofCode(t.diagnostics, 'node_type_dropped');
    expect(dropped.map((d) => d.detail)).toEqual([{ factId: r.id, nodeType: 'person', reason: 'not_in_manifest' }]);
    expect(ofCode(t.diagnostics, 'node_type_assigned')).toHaveLength(0);
  });

  it('a mode flip to off before the transaction stores untyped with no ontology receipt', async () => {
    let wikiRef: any;
    const t = await mk({
      strategy, facts: [fact('Ada Lovelace')], typeOnWrite: 'auto',
      classify: async () => { await wikiRef.setOntologyManifest('u', MANIFEST, { mode: 'off' }); return choice('person'); },
    });
    wikiRef = t.wiki;
    await t.wiki.runLibrarian('u');
    expect((await rows(t.db))[0].okf_type).toBeNull();
    for (const code of ['node_type_assigned', 'node_type_dropped', 'classification_abstained'] as const) {
      expect(ofCode(t.diagnostics, code)).toHaveLength(0);
    }
  });

  it('llm_usage fires per classify call under reportLlmUsage, estimated when the provider reports no counts', async () => {
    const t = await mk({ strategy, facts: [fact('Ada Lovelace'), fact('Charles Babbage')], classify: () => choice('person'), typeOnWrite: 'auto', config: { reportLlmUsage: true } as any });
    await t.wiki.runLibrarian('u');
    const usage = ofCode(t.diagnostics, 'llm_usage').filter((d) => d.operation === 'librarian');
    // 1 generative + 2 classify calls
    expect(usage).toHaveLength(3);
    expect(usage.filter((d) => d.detail.estimated === true).length).toBeGreaterThanOrEqual(2);
  });
});

describe('legacy only: dedupe-skipped facts', () => {
  it('a fact the in-tx fuzzy dedupe skips spends one call and stores nothing', async () => {
    const t = await mk({ strategy: 'legacy', facts: [fact('User lives in Seattle city'), fact('User lives in Seattle city')], classify: () => choice('person'), typeOnWrite: 'auto' });
    await t.wiki.runLibrarian('u');
    expect(t.classify).toHaveBeenCalledTimes(2);
    expect(await rows(t.db)).toHaveLength(1);
    expect(runLegacyLibrarianPass).toBeDefined();
  });
});

describe('door receipts do not contradict (type-on-write §8)', () => {
  it('a model slug that resolves in-transaction suppresses a decline receipt for the same fact', async () => {
    const { normalizeForWrite } = await import('../src/services/typing/typeOnWrite');
    const svc = { validateAndNormalizeFact: (f: any) => ({ okf_type: f.okf_type === 'person' ? 'person' : null, edges: [], match: { raw: 'person', canonical: 'person', via: 'exact' as const } }) };
    const base = { entityId: 'u', operation: 'librarian' as const, trigger: 'call' as const };
    const r = normalizeForWrite(svc as any, { title: 't', body: 'b', tags: [], confidence: 'certain', okf_type: 'person' } as any, MANIFEST, 'strict', { kind: 'abstain' }, base, 'f1');
    expect(r.receipts.map((x) => x.code)).toEqual(['node_type_assigned']);
  });
});
