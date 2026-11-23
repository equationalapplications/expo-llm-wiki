import { describe, it, expect, vi } from 'vitest';
import { createWiki } from '../src/index';
import { PromptService } from '../src/services/PromptService';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, WikiDiagnostic } from '../src/types';

// specs/type-on-write: ops-specific candidate set, budget, scheduler, instructions, backfill (Test plan 5, 8, 9, 13, 14).
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residence' }],
};
const embed = async (t: string) => [/seattle/i.test(t) ? 1 : 0, /san francisco/i.test(t) ? 1 : 0, /lives|moved/i.test(t) ? 1 : 0, 0.5];
const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});
const fact = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: 'b', tags: [], confidence: 'certain', source_event: 'e1', ...extra });

async function mk(o: {
  gen: Array<(p: { systemPrompt: string; userPrompt: string }) => unknown>;
  classify?: (r: ClassifyRequest) => ClassifyResponse | Promise<ClassifyResponse>;
  auto?: boolean;
  config?: Record<string, unknown>;
  seed?: { id: string; title: string; source: string };
}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  let i = 0;
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => JSON.stringify(o.gen[Math.min(i++, o.gen.length - 1)](p)));
  const classify = o.classify ? vi.fn(async (r: ClassifyRequest) => o.classify!(r)) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, embed, ...(classify ? { classify } : {}) },
    config: {
      autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' },
      ...(o.auto === false ? {} : { systemOne: { typeOnWrite: 'auto' } }),
      ...(o.config ?? {}),
    },
    onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d),
  } as any);
  await wiki.setup();
  await wiki.setOntologyManifest('u', MANIFEST, { mode: 'strict' });
  if (o.seed) {
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES (?, 'u', ?, 'b', ?, 'certain', 1, 1)`, [o.seed.id, o.seed.title, o.seed.source]);
    await wiki.runReembed();
  }
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','I moved to San Francisco',100,90)`);
  return { db, wiki, generateText, classify, diagnostics };
}
const typed = (db: any) => db.getAllAsync(`SELECT id, title, okf_type FROM llm_wiki_entries WHERE okf_type IS NOT NULL`) as Promise<any[]>;

describe('type on write: ops candidate set (§3)', () => {
  it('a resolve NOOP candidate is not asked', async () => {
    const t = await mk({
      seed: { id: 'seattle', title: 'User lives in Seattle', source: 'user_stated' },
      gen: [() => ({ facts: [fact('User lives in San Francisco now')], tasks: [] }), () => ({ ops: [{ item: 0, op: 'NOOP', target: 'n1' }] })],
      classify: () => choice('person'),
    });
    await t.wiki.runLibrarian('u');
    expect(t.classify).not.toHaveBeenCalled();
  });

  it('a classifier-settled resolve NOOP is not asked a typing question', async () => {
    const t = await mk({
      config: { systemOne: { typeOnWrite: 'auto', resolve: 'auto', minConfidence: { resolve: 0.8 } } },
      seed: { id: 'seattle', title: 'User lives in Seattle', source: 'user_stated' },
      gen: [() => ({ facts: [fact('User lives in San Francisco now')], tasks: [] })],
      classify: (r) => ('okf_type' in r.questions ? choice('person') : { answers: { n1: { kind: 'binary', probability: 0.97 } } }),
    });
    await t.wiki.runLibrarian('u');
    const typingCalls = (t.classify!.mock.calls as any[]).filter(([r]) => 'okf_type' in r.questions);
    expect(typingCalls).toHaveLength(0);
  });

  it('an ADD, a SUPERSEDE and an UPDATE-in-place are asked; the UPDATE stores nothing from the answer', async () => {
    const sup = await mk({
      seed: { id: 'seattle', title: 'User lives in Seattle', source: 'user_stated' },
      gen: [() => ({ facts: [fact('User moved to San Francisco')], tasks: [] }), () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] })],
      classify: () => choice('person'),
    });
    await sup.wiki.runLibrarian('u');
    expect(sup.classify).toHaveBeenCalledTimes(1);
    expect((await typed(sup.db)).map((r) => r.title)).toEqual(['User moved to San Francisco']);

    const upd = await mk({
      seed: { id: 'acme', title: 'User works at Acme', source: 'librarian_inferred' },
      gen: [() => ({ facts: [fact('User is a senior engineer at Acme')], tasks: [] }), () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer at Acme', body: 'P' }] })],
      classify: () => choice('person'),
    });
    await upd.wiki.runLibrarian('u');
    expect(upd.classify).toHaveBeenCalledTimes(1);
    expect(await typed(upd.db)).toHaveLength(0);
    expect(ofCode(upd.diagnostics, 'node_type_assigned')).toHaveLength(0);
    expect(ofCode(upd.diagnostics, 'librarian_rewritten')).toHaveLength(1);
  });

  it('a rejected op and a failed resolve are asked, and their rows are typed', async () => {
    const rej = await mk({
      seed: { id: 'seattle', title: 'User lives in Seattle', source: 'user_stated' },
      gen: [() => ({ facts: [fact('User moved to San Francisco')], tasks: [] }), () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n7' }] })],
      classify: () => choice('person'),
    });
    await rej.wiki.runLibrarian('u');
    expect(rej.classify).toHaveBeenCalledTimes(1);
    expect(ofCode(rej.diagnostics, 'librarian_op_rejected')).toHaveLength(1);
    expect(await typed(rej.db)).toHaveLength(1);
  });

  it('a write-typed fact carries no edges', async () => {
    const t = await mk({
      gen: [() => ({ facts: [fact('Ada Lovelace', { edges: [{ edge_type: 'lives_in', target_title: 'London' }] }), fact('London')], tasks: [] })],
      classify: (r) => choice(/London/.test(r.state) ? 'place' : 'person'),
    });
    await t.wiki.runLibrarian('u');
    expect(await typed(t.db)).toHaveLength(2);
    expect(await t.db.getAllAsync(`SELECT 1 FROM llm_wiki_edges`)).toHaveLength(0);
  });
});

describe('type on write: reserve estimate and prompts (§5)', () => {
  it('selectBatch and extractOnce build the prompt from the same write context (engaged: none)', async () => {
    const spy = vi.spyOn(PromptService.prototype, 'buildOpsExtractPrompt');
    try {
      const t = await mk({ gen: [() => ({ facts: [fact('Ada Lovelace')], tasks: [] })], classify: () => choice('person') });
      const r = await t.wiki.runPendingMaintenance({ tokenBudget: 1_000_000, jobs: ['librarian'] });
      expect(r.perEntity[0].librarianPasses).toBe(1);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // reserve estimate + the send
      for (const c of spy.mock.calls) expect(c[1]).toBeNull();
    } finally { spy.mockRestore(); }
    const spy2 = vi.spyOn(PromptService.prototype, 'buildOpsExtractPrompt');
    try {
      const t = await mk({ auto: false, gen: [() => ({ facts: [fact('Ada Lovelace')], tasks: [] })] });
      await t.wiki.runPendingMaintenance({ tokenBudget: 1_000_000, jobs: ['librarian'] });
      expect(spy2.mock.calls.length).toBeGreaterThanOrEqual(2);
      const texts = spy2.mock.calls.map((c) => c[1]?.ontologyModeInstructions);
      expect(new Set(texts).size).toBe(1);
      expect(texts[0]).toContain('Ontology constraints');
    } finally { spy2.mockRestore(); }
  });

  it('getInstructions().librarian reflects engagement; ingest and ontologyBackfill are unchanged', async () => {
    const on = await mk({ gen: [() => ({})], classify: () => choice('person') });
    const off = await mk({ auto: false, gen: [() => ({})], classify: () => choice('person') });
    const a = await on.wiki.getInstructions('u');
    const b = await off.wiki.getInstructions('u');
    expect(a.librarian).not.toContain('Ontology constraints');
    expect(b.librarian).toContain('Ontology constraints');
    expect(a.ontologyBackfill).toBe(b.ontologyBackfill);
    expect(a.ontologyBackfill).toContain('Ontology constraints');
    expect(a.ingest).toBe(b.ingest);
    expect(a.heal).toBe(b.heal);
  });
});

describe('type on write: budget and scheduler (§6, §8)', () => {
  const three = () => ({ facts: [fact('Ada Lovelace'), fact('Charles Babbage'), fact('Grace Hopper')], tasks: [] });

  it('the scheduler reports typedOnWrite beside typed; absent when the key is unset', async () => {
    const on = await mk({ gen: [three], classify: () => choice('person') });
    const r = await on.wiki.runPendingMaintenance({ jobs: ['librarian'] });
    expect(r.perEntity[0].typedOnWrite).toBe(3);
    expect(r.perEntity[0].typed).toBe(0);
    const off = await mk({ auto: false, gen: [three], classify: () => choice('person') });
    const r2 = await off.wiki.runPendingMaintenance({ jobs: ['librarian'] });
    expect('typedOnWrite' in r2.perEntity[0]).toBe(false);
  });

  it('a meter that exhausts during typing types the first facts, writes the rest untyped, keeps the watermark moving, and returns no budgetStop', { timeout: 60000 }, async () => {
    const { UsageMeter } = await import('../src/utils/usage');
    const run = async (budget?: number) => {
      const t = await mk({ gen: [three], classify: () => choice('person') });
      const meter = new UsageMeter(budget);
      const res = await (t.wiki.__testAccess as any).maintenanceService.runLibrarianPass({ entityId: 'u', trigger: 'call', meter });
      return { t, res, used: meter.used };
    };
    const full = await run();
    expect(full.res.typing.typed).toBe(3);
    let found: any;
    for (let k = 1; k < 400 && !found; k++) {
      const attempt = await run(full.used - k);
      if (attempt.res.budgetStop) break;
      if (attempt.res.typing.unattempted > 0) found = attempt;
    }
    expect(found, 'a budget window with partial typing exists').toBeDefined();
    const { t, res } = found;
    expect(res.budgetStop).toBeUndefined();
    expect(res.factsWritten).toBe(3);
    expect(res.typing.typed + res.typing.unattempted).toBe(3);
    expect(res.typing.typed).toBeGreaterThan(0);
    const all = await t.db.getAllAsync(`SELECT okf_type FROM llm_wiki_entries`);
    expect(all).toHaveLength(3);
    expect(all.filter((r: any) => r.okf_type === null)).toHaveLength(res.typing.unattempted);
    expect(await (t.wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toEqual({ at: 100, id: 'evt_1' });
  });

  it('a meter that exhausts before extraction still returns budgetStop and writes nothing', async () => {
    const t = await mk({ gen: [three], classify: () => choice('person') });
    const { UsageMeter } = await import('../src/utils/usage');
    const res = await (t.wiki.__testAccess as any).maintenanceService.runLibrarianPass({ entityId: 'u', trigger: 'call', meter: new UsageMeter(1) });
    expect(res.budgetStop).toBeDefined();
    expect(await t.db.getAllAsync(`SELECT 1 FROM llm_wiki_entries`)).toHaveLength(0);
  });
});

describe('type on write: backfill interaction (§11)', () => {
  it('a write-typed fact is not a backfill candidate; an abstained fact is', async () => {
    const t = await mk({
      gen: [() => ({ facts: [fact('Ada Lovelace'), fact('Mystery Item')], tasks: [] })],
      classify: (r) => (/Mystery/.test(r.state) ? choice('none_of_these', 1) : choice('person')),
    });
    await t.wiki.runLibrarian('u');
    const repo = (t.wiki.__testAccess as any).entryRepo;
    const untyped = await repo.findUntypedByEntityId('u', 50, Date.now());
    expect(untyped.map((f: any) => f.title)).toEqual(['Mystery Item']);
  });
});
