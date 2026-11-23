import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { SQLiteAdapter, OntologyManifest, WikiConfig } from '../src/types';
import { resolveContextBudget, resolveMaxPromptChars } from '../src/config/context';
import { ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS } from '../src/utils/contextCaps';

const PREFIX = 'llm_wiki_';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

async function seedEntry(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; title?: string; body?: string; updatedAt?: number;
  okfType?: string | null; checkedAt?: number | null; deletedAt?: number | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at,
        access_count, deleted_at, okf_type, ontology_checked_at)
     VALUES (?, ?, ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0, ?, ?, ?)`,
    [opts.id, opts.entityId ?? 'e1', opts.title ?? `title ${opts.id}`, opts.body ?? `body ${opts.id}`,
     opts.updatedAt ?? 1000, opts.updatedAt ?? 1000,
     opts.deletedAt ?? null, opts.okfType ?? null, opts.checkedAt ?? null],
  );
}

async function makeWiki(config: WikiConfig) {
  const db = openTestDatabase();
  const generateText = vi.fn<any>();
  const wiki = createWiki(db, { llmProvider: { generateText }, config } as any);
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  await seedEntry(db, { id: 'fact_typed', title: 'Ada', okfType: 'person' });
  return { db, wiki, generateText };
}

const llmJson = (obj: unknown) => JSON.stringify(obj);

function answerWithIdsInPrompt(ids: string[]) {
  return async ({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }) => {
    const payload = `${systemPrompt}\n${userPrompt}`;
    return llmJson({
      classifications: ids.filter((id) => payload.includes(id)).map((id) => ({ id, okf_type: 'person' })),
    });
  };
}

describe('resolveMaxPromptChars: backfill op (spec test 3)', () => {
  it('R1: legacy shapes return 40_000', () => {
    expect(resolveMaxPromptChars(resolveContextBudget(undefined), 'backfill')).toBe(40_000);
    expect(
      resolveMaxPromptChars(resolveContextBudget({ context: { budget: 'legacy' } }), 'backfill'),
    ).toBe(40_000);
    expect(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS).toBe(40_000);
  });

  it('R2: declared formula matches resolve and heal', () => {
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 32_000 } });
    // (32000 - 4000) * 0.9 * 4 = 100800
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(resolveMaxPromptChars(budget, 'resolve'));
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(resolveMaxPromptChars(budget, 'heal'));
  });

  it('R3: floors at 40_000 when the derived cap is smaller', () => {
    // (8000 - 4000) * 0.9 * 4 = 14400 < 40_000
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 8_000 } });
    expect(resolveMaxPromptChars(budget, 'backfill')).toBe(40_000);
  });
});

describe('declared backfill boundary (spec test 4)', () => {
  const cfg: WikiConfig = { context: { budget: 'declared', contextWindowTokens: 32_000 } };
  const cap = resolveMaxPromptChars(resolveContextBudget(cfg), 'backfill');

  it('B1: a pair that splits under legacy shares one call at the derived cap', async () => {
    expect(cap).toBe(100_800);
    const { db, wiki, generateText } = await makeWiki(cfg);
    const half = 'x'.repeat(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS / 2 - 60);
    await seedEntry(db, { id: 'fact_half1', body: half, updatedAt: 100 });
    await seedEntry(db, { id: 'fact_half2', body: half, updatedAt: 200 });
    generateText.mockImplementation(answerWithIdsInPrompt(['fact_half1', 'fact_half2']));
    await wiki.runOntologyBackfill('e1');
    expect(generateText.mock.calls.length).toBe(1);
    const prompts = generateText.mock.calls[0][0];
    const payload = `${prompts.systemPrompt}\n${prompts.userPrompt}`;
    expect(payload).toContain('fact_half1');
    expect(payload).toContain('fact_half2');
    expect(prompts.systemPrompt.length + prompts.userPrompt.length).toBeLessThanOrEqual(cap);
  });

  it('B2: a pair sized to the derived cap splits, each call within the cap and above the floor', async () => {
    expect(cap).toBe(100_800);
    const { db, wiki, generateText } = await makeWiki(cfg);
    const half = 'x'.repeat(cap / 2 - 60);
    await seedEntry(db, { id: 'fact_half1', body: half, updatedAt: 100 });
    await seedEntry(db, { id: 'fact_half2', body: half, updatedAt: 200 });
    generateText.mockImplementation(answerWithIdsInPrompt(['fact_half1', 'fact_half2']));
    await wiki.runOntologyBackfill('e1');
    expect(generateText.mock.calls.length).toBe(2);
    for (const [prompts] of generateText.mock.calls) {
      const payload = `${prompts.systemPrompt}\n${prompts.userPrompt}`;
      const present = ['fact_half1', 'fact_half2'].filter((id) => payload.includes(id));
      expect(present.length).toBe(1);
      const len = prompts.systemPrompt.length + prompts.userPrompt.length;
      expect(len).toBeLessThanOrEqual(cap);
      expect(len).toBeGreaterThan(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS);
    }
  });

  it('B1-control: the B1 pair splits under legacy (no context section)', async () => {
    const { db, wiki, generateText } = await makeWiki({});
    const half = 'x'.repeat(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS / 2 - 60);
    await seedEntry(db, { id: 'fact_half1', body: half, updatedAt: 100 });
    await seedEntry(db, { id: 'fact_half2', body: half, updatedAt: 200 });
    generateText.mockImplementation(answerWithIdsInPrompt(['fact_half1', 'fact_half2']));
    await wiki.runOntologyBackfill('e1');
    expect(generateText.mock.calls.length).toBe(2);
    for (const [prompts] of generateText.mock.calls) {
      const payload = `${prompts.systemPrompt}\n${prompts.userPrompt}`;
      const present = ['fact_half1', 'fact_half2'].filter((id) => payload.includes(id));
      expect(present.length).toBe(1);
      expect(prompts.systemPrompt.length + prompts.userPrompt.length)
        .toBeLessThanOrEqual(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS);
    }
  });

  it('B2-control: the B2 pair has the same two-call shape under legacy', async () => {
    // Identical shape to B2 by design: B2 is an upper-bracket pin and does not
    // discriminate the lower bound (each fact is an oversized singleton under
    // legacy). The lower bound is covered by B1 plus B1-control.
    const { db, wiki, generateText } = await makeWiki({});
    const half = 'x'.repeat(cap / 2 - 60);
    await seedEntry(db, { id: 'fact_half1', body: half, updatedAt: 100 });
    await seedEntry(db, { id: 'fact_half2', body: half, updatedAt: 200 });
    generateText.mockImplementation(answerWithIdsInPrompt(['fact_half1', 'fact_half2']));
    await wiki.runOntologyBackfill('e1');
    expect(generateText.mock.calls.length).toBe(2);
    for (const [prompts] of generateText.mock.calls) {
      const payload = `${prompts.systemPrompt}\n${prompts.userPrompt}`;
      const present = ['fact_half1', 'fact_half2'].filter((id) => payload.includes(id));
      expect(present.length).toBe(1);
      expect(prompts.systemPrompt.length + prompts.userPrompt.length)
        .toBeGreaterThan(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS);
    }
  });
});

describe('no silent fallback (spec test 5)', () => {
  it('F1: a malformed context section rejects at pass entry before any typing or stamp', async () => {
    const config: WikiConfig = {};
    const { db, wiki, generateText } = await makeWiki(config);
    await seedEntry(db, { id: 'fact_u1', updatedAt: 100 });
    await seedEntry(db, { id: 'fact_u2', updatedAt: 200 });
    // WikiMemory holds `options` by reference and construction already
    // validated, so a malformed section reaches the pass only by mutation.
    (config as any).context = { budget: 'declared' };
    await expect(wiki.runOntologyBackfill('e1')).rejects.toThrow(/contextWindowTokens/);
    expect(generateText).not.toHaveBeenCalled();
    const rows = await db.getAllAsync<{ id: string; okf_type: string | null; ontology_checked_at: number | null }>(
      `SELECT id, okf_type, ontology_checked_at FROM ${PREFIX}entries WHERE id IN ('fact_u1', 'fact_u2')`,
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.okf_type).toBeNull();
      expect(r.ontology_checked_at).toBeNull();
    }
  });
});
