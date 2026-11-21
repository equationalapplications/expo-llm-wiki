import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { selectBatch, runExtract, OPS_MAX_EVENTS_PER_PASS } from '../src/services/librarian/ops/extract';
import { runResolve } from '../src/services/librarian/ops/resolve';
import { resolveContextBudget } from '../src/config/context';
import { OPS_MAX_EXTRACT_CHARS } from '../src/utils/contextCaps';
import type { GatedCandidate } from '../src/services/librarian/ops/gate';
import { openTestDatabase } from './helpers/sqliteAdapter';

/**
 * Declared-mode end-to-end behaviour + construction fail-fast
 * (specs/context-budget test plan 4).
 */

async function mkHarness(
  config: Record<string, unknown> | undefined,
  generateText?: (p: { systemPrompt: string; userPrompt: string }) => Promise<string>,
) {
  const db = openTestDatabase();
  const callLog: string[] = [];
  const wiki = new WikiMemory(db, {
    llmProvider: {
      generateText:
        async (p) => {
          callLog.push(p.userPrompt);
          return generateText ? await generateText(p) : '{}';
        },
    },
    config: (config ?? {}) as never,
  });
  await wiki.setup();
  const ms = wiki.__testAccess.maintenanceService as never as { librarianDeps: () => unknown };
  return { wiki, deps: ms.librarianDeps(), callLog, db };
}

async function addEvents(wiki: WikiMemory, db: ReturnType<typeof openTestDatabase>, summaries: string[]) {
  for (let i = 0; i < summaries.length; i++) {
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES (?, 'u', 'observation', ?, ?, ?)`,
      [`evt_${i}`, summaries[i], 10 + i, null],
    );
  }
}

describe('construction fail-fast (spec test 7)', () => {
  it('a declared config without contextWindowTokens throws at construction', () => {
    const db = openTestDatabase();
    expect(
      () => new WikiMemory(db, { llmProvider: { generateText: async () => '{}' }, config: { context: { budget: 'declared' } } as never }),
    ).toThrow(/contextWindowTokens/);
  });

  it('a declared config with a bad outputReserveTokens throws at construction', () => {
    const db = openTestDatabase();
    expect(
      () =>
        new WikiMemory(db, {
          llmProvider: { generateText: async () => '{}' },
          config: { context: { budget: 'declared', contextWindowTokens: 8_000, outputReserveTokens: 8_000 } } as never,
        }),
    ).toThrow(/outputReserveTokens/);
  });

  it('legacy shapes still construct', () => {
    const db = openTestDatabase();
    expect(
      () => new WikiMemory(db, { llmProvider: { generateText: async () => '{}' }, config: { context: { budget: 'legacy' } } as never }),
    ).not.toThrow();
    expect(() => new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } })).not.toThrow();
  });
});

describe('declared mode scales the extract char cap proportionally (spec test 4)', () => {
  it('window 128000 derives 60480 and admits a 60000-char batch; legacy drops at 24000', async () => {
    // 60000 total across two events: over legacy 24_000, under declared 60_480.
    const summaries = ['x'.repeat(30_000), 'y'.repeat(30_000)];
    const declaredWiki = await mkHarness({ context: { budget: 'declared', contextWindowTokens: 128_000 } });
    await addEvents(declaredWiki.wiki, declaredWiki.db, summaries);
    const declaredBudget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 128_000 } } as never);
    const selDeclared: any = await selectBatch(declaredWiki.deps, 'u', null, undefined, undefined, declaredBudget);
    expect(selDeclared.batch.map((l: any) => l.event.summary.length)).toEqual([30_000, 30_000]);

    const legacyBudget = resolveContextBudget(undefined);
    const selLegacy: any = await selectBatch(declaredWiki.deps, 'u', null, undefined, undefined, legacyBudget);
    expect(selLegacy.batch.map((l: any) => l.event.summary.length)).toEqual([30_000]);
  });

  it('a tiny window floors at the legacy 24_000 cap', async () => {
    const tinyBudget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 8_000 } } as never);
    const wiki = await mkHarness({ context: { budget: 'declared', contextWindowTokens: 8_000 } });
    await addEvents(wiki.wiki, wiki.db, ['x'.repeat(23_995), 'y'.repeat(120)]);
    const sel: any = await selectBatch(wiki.deps, 'u', null, undefined, undefined, tinyBudget);
    expect(sel.batch.map((l: any) => l.event.summary.length)).toEqual([23_995]);
    void OPS_MAX_EXTRACT_CHARS;
  });
});

describe('declared mode scales the resolve prompt cap (spec test 4)', () => {
  const body = (n: number, marker: string) => marker + ' ' + 'x'.repeat(Math.max(0, n - marker.length - 1));
  const candidate = (i: number, marker: string, bodyLen: number): GatedCandidate => ({
    candidate: {
      index: i,
      fact: { title: `Candidate ${i} ${marker}`, body: body(bodyLen, marker), tags: [], confidence: 'certain' },
      sourceLabel: null,
      sourceEventId: null,
      sourcePartIndex: null,
      pointerUnresolved: null,
      validFrom: 0,
    },
    neighbours: [{ ref: 'n1', id: 'fact_n', title: 'Existing neighbour', body: 'n'.repeat(300) }],
    decision: 'ambiguous' as never,
    vector: null,
  });

  it('window 32000 derives a 100800 resolve cap: two 19.4k items stay in one call', async () => {
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 32_000 } } as never);
    const wiki = await mkHarness(undefined, async () => JSON.stringify({ ops: [{ item: 0, op: 'ADD' }, { item: 1, op: 'ADD' }] }));
    const out = await runResolve(
      wiki.deps as never,
      { entityId: 'u', trigger: 'call' } as never,
      [candidate(0, 'MARKER_ONE', 19_400), candidate(1, 'MARKER_TWO', 19_400)],
      budget,
    );
    expect(wiki.callLog).toHaveLength(1);
    expect(wiki.callLog[0]).toContain('MARKER_ONE');
    expect(wiki.callLog[0]).toContain('MARKER_TWO');
    expect(out.ops.size).toBe(2);
  });

  it('without a budget the same items split at the legacy 40_000 cap', async () => {
    const wiki = await mkHarness(undefined, async () => JSON.stringify({ ops: [{ item: 0, op: 'ADD' }] }));
    const out = await runResolve(
      wiki.deps as never,
      { entityId: 'u', trigger: 'call' } as never,
      [candidate(0, 'MARKER_ONE', 19_400), candidate(1, 'MARKER_TWO', 19_400)],
    );
    expect(wiki.callLog).toHaveLength(2);
    expect(wiki.callLog[0]).toContain('MARKER_ONE');
    expect(wiki.callLog[0]).not.toContain('MARKER_TWO');
    expect(out.ops.size).toBe(2);
  });
});

describe('declared mode: extract pass still runs end-to-end', () => {
  it('runExtract on a declared-mode selected batch returns candidates', async () => {
    const generateText = vi.fn(async () =>
      JSON.stringify({ facts: [{ title: 'User owns a cat named Mo', body: 'b', tags: [], confidence: 'certain' }], tasks: [] }),
    );
    const wiki = await mkHarness({ context: { budget: 'declared', contextWindowTokens: 32_000 } }, generateText);
    await addEvents(wiki.wiki, wiki.db, ['job news']);
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 32_000 } } as never);
    const sel: any = await selectBatch(wiki.deps, 'u', null, undefined, undefined, budget);
    const out = await runExtract(wiki.deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.candidates.map((c) => c.fact.title)).toEqual(['User owns a cat named Mo']);
    expect(generateText).toHaveBeenCalledTimes(1);
    void OPS_MAX_EVENTS_PER_PASS;
  });
});
