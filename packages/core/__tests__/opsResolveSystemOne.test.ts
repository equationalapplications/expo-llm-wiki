import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { UsageMeter } from '../src/utils/usage';
import { runOpsLibrarianPass } from '../src/services/librarian/ops/index';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { ClassifyRequest, ClassifyResponse, WikiDiagnostic } from '../src/types';

// Pass-level tests for resolution-from-System-One (spec §4-§6).

const embed = async (t: string) => [/seattle/i.test(t) ? 1 : 0, /san francisco/i.test(t) ? 1 : 0, /lives|moved/i.test(t) ? 1 : 0, 0.5];
const binary = (p: number): ClassifyResponse => ({ answers: { n1: { kind: 'binary', probability: p } } });
const AUTO = { systemOne: { resolve: 'auto' as const, minConfidence: { resolve: 0.8 } } };
const FACT = (title: string) => ({ title, body: 'b', tags: [], confidence: 'certain', source_event: 'e1' });

interface Opts {
  responses: Array<(p: { systemPrompt: string; userPrompt: string }) => unknown>;
  classify?: (req: ClassifyRequest) => Promise<ClassifyResponse> | ClassifyResponse;
  config?: Record<string, unknown>;
  noEmbed?: boolean;
}

function mk(o: Opts) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  let i = 0;
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => JSON.stringify(o.responses[i++](p)));
  const classify = o.classify ? vi.fn(async (r: ClassifyRequest) => o.classify!(r)) : undefined;
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, ...(o.noEmbed ? {} : { embed }), ...(classify ? { classify } : {}) },
    config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' }, ...(o.config ?? {}) },
    onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d),
  } as any);
  return { db, wiki, generateText, classify, diagnostics };
}

async function seed(db: ReturnType<typeof openTestDatabase>, wiki: WikiMemory, reembed = true) {
  await wiki.setup();
  await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
    VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
  if (reembed) await wiki.runReembed();
  else await (wiki.__testAccess.maintenanceService as any).librarianDeps().searchService.syncEntries('u', ['seattle']);
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','I moved to San Francisco',100,90)`);
}

const rowCount = async (db: ReturnType<typeof openTestDatabase>) =>
  (await db.getAllAsync(`SELECT 1 FROM llm_wiki_entries`)).length;
const watermark = (wiki: WikiMemory) => (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u');
const classifierReceipts = (d: WikiDiagnostic[]) =>
  ofCode(d, 'fact_deduplicated').filter((x: any) => x.detail?.reason === 'classifier');

describe('ops pass with the System-One resolve screen', () => {
  it('screen → apply: a confident YES drops the candidate; no row written; neighbour unchanged; one receipt', async () => {
    const { db, wiki, generateText, classify, diagnostics } = mk({
      config: AUTO,
      responses: [() => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] })],
      classify: () => binary(0.97),
    });
    await seed(db, wiki);
    await wiki.runLibrarian('u');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1); // extract only; resolve LLM skipped
    expect(await rowCount(db)).toBe(1);
    const seattle = await db.getFirstAsync<any>(`SELECT valid_to, superseded_by, title, body FROM llm_wiki_entries WHERE id='seattle'`);
    expect(seattle).toEqual({ valid_to: null, superseded_by: null, title: 'User lives in Seattle', body: 'b' });
    expect(await watermark(wiki)).toEqual({ at: 100, id: 'evt_1' });
    const receipts = classifierReceipts(diagnostics) as any[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0].detail).toEqual({ itemIndex: 0, reason: 'classifier' });
    expect(ofCode(diagnostics, 'fact_deduplicated')).toHaveLength(1);
  });

  it('emits only codes from a fixed list (zero new diagnostic codes)', async () => {
    const { db, wiki, diagnostics } = mk({
      config: AUTO,
      responses: [() => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] })],
      classify: () => binary(0.97),
    });
    await seed(db, wiki);
    await wiki.runLibrarian('u');
    const allowed = new Set(['fact_deduplicated', 'librarian_gate', 'librarian_gate_decision', 'llm_usage']);
    const emitted = [...new Set(diagnostics.map((d) => d.code))];
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(allowed, `unexpected code ${code}`).toContain(code);
    expect(emitted).toContain('fact_deduplicated');
  });

  it('the pass result carries only its pre-existing keys', async () => {
    const { db, wiki, classify } = mk({
      config: AUTO,
      responses: [() => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] })],
      classify: () => binary(0.97),
    });
    await seed(db, wiki);
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();
    const res = await runOpsLibrarianPass(deps, { entityId: 'u', trigger: 'call' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(Object.keys(res).sort()).toEqual(['factsWritten', 'processedThrough']);
  });

  it('keyword mode: the screen engages (ruling Q4)', async () => {
    const { db, wiki, classify, generateText, diagnostics } = mk({
      config: AUTO,
      noEmbed: true,
      responses: [() => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] })],
      classify: () => binary(0.97),
    });
    await seed(db, wiki, false);
    await wiki.runLibrarian('u');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(await rowCount(db)).toBe(1);
    expect(classifierReceipts(diagnostics)).toHaveLength(1);
  });

  it.each([
    ['NO', () => binary(0.02)],
    ['uncertain', () => binary(0.5)],
    ['malformed', () => ({ answers: {} }) as ClassifyResponse],
  ])('%s answer falls through to the generative resolve and apply handles its op', async (_label, classify) => {
    const { db, wiki, generateText, diagnostics } = mk({
      config: AUTO,
      responses: [
        () => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] }),
        () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }),
      ],
      classify,
    });
    await seed(db, wiki);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(2);
    const old = await db.getFirstAsync<any>(`SELECT valid_to, superseded_by FROM llm_wiki_entries WHERE id='seattle'`);
    expect(old.valid_to).toBe(90);
    expect(old.superseded_by).toEqual(expect.any(String));
    expect(classifierReceipts(diagnostics)).toHaveLength(0);
  });

  it('classifier absent or throwing: one warning, whole batch falls through, pass applies and advances the watermark', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const responses = [
        () => ({ facts: [FACT('User lives in San Francisco now')], tasks: [] }),
        () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }),
      ];
      const absent = mk({ config: AUTO, responses });
      await seed(absent.db, absent.wiki);
      await absent.wiki.runLibrarian('u');
      const throwing = mk({
        config: AUTO,
        responses,
        classify: () => {
          throw new Error('classifier down');
        },
      });
      await seed(throwing.db, throwing.wiki);
      await throwing.wiki.runLibrarian('u');
      for (const t of [absent, throwing]) {
        expect(t.generateText).toHaveBeenCalledTimes(2);
        const old = await t.db.getFirstAsync<any>(`SELECT valid_to FROM llm_wiki_entries WHERE id='seattle'`);
        expect(old.valid_to).toBe(90);
        expect(await watermark(t.wiki)).toEqual({ at: 100, id: 'evt_1' });
        expect(classifierReceipts(t.diagnostics)).toHaveLength(0);
      }
      const warns = warn.mock.calls.filter((c) => String(c[0]).includes('systemOne.resolve'));
      expect(warns).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a budget stop in the generative leg discards the classifier receipts', async () => {
    let classified = false;
    class GateMeter extends UsageMeter {
      override fits(estimate: number): boolean {
        return classified ? false : super.fits(estimate);
      }
    }
    const { db, wiki, diagnostics, classify } = mk({
      config: AUTO,
      responses: [
        () => ({ facts: [FACT('User lives in San Francisco now'), FACT('User moved to San Francisco recently')], tasks: [] }),
        () => ({ ops: [] }),
      ],
      classify: (req) => {
        // Close the meter only after the LAST classify call, so the screen
        // completes and the generative leg is what hits the budget.
        if (!req.state.startsWith('User lives')) classified = true;
        return binary(req.state.startsWith('User lives') ? 0.97 : 0.02);
      },
    });
    await seed(db, wiki);
    const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();
    const res = await runOpsLibrarianPass(deps, { entityId: 'u', trigger: 'call', meter: new GateMeter() });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(res.budgetStop).toBeDefined();
    expect(res.processedThrough).toBeNull();
    expect(classifierReceipts(diagnostics)).toHaveLength(0);
    expect(await rowCount(db)).toBe(1);
  });
});
