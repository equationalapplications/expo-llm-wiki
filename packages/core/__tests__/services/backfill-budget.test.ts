import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { createWiki } from '../../src/index';
import type { ClassifyResponse, OntologyManifest, SQLiteAdapter } from '../../src/types';

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [],
};

async function seed(db: SQLiteAdapter, id: string, updatedAt: number) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
     VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0)`,
    [id, id, `${id} body`, updatedAt, updatedAt],
  );
}

const ok = (): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.9, probabilities: { person: 0.9 } } },
});

async function makeWiki(count: number, onDiagnostic?: (d: any) => void) {
  const db = openTestDatabase();
  const wiki = createWiki(db, {
    llmProvider: { generateText: vi.fn(async () => '{}'), classify: vi.fn(async () => ok()) },
    // Serial classification keeps the budget-stop point deterministic.
    config: { chunkConcurrency: 1, reportLlmUsage: true },
    ...(onDiagnostic ? { onDiagnostic } : {}),
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  for (let i = 0; i < count; i++) await seed(db, `f${i}`, 100 + i);
  return { db, wiki };
}

describe('runOntologyBackfill tokenBudget', () => {
  it('meters the whole classifier pass: stops with budgetStop, leaves unattempted facts eligible', async () => {
    // Probe run with no budget to read the real per-call usage.
    const probeDiags: any[] = [];
    const probe = await makeWiki(2, (d) => probeDiags.push(d));
    await probe.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    const usage = probeDiags.filter((d) => d.code === 'llm_usage');
    expect(usage).toHaveLength(2);
    const { inputTokens, outputTokens } = usage[0].detail;

    // First call fits; the second needs `inputTokens` but only inputTokens - 1 remain.
    const budget = inputTokens + outputTokens + inputTokens - 1;
    const { db, wiki } = await makeWiki(2);
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto', tokenBudget: budget });

    expect(result.budgetStop).toEqual({ requiredEstimate: inputTokens });
    expect(result.typed).toBe(1);
    expect(result.scanned).toBe(1);
    expect(result.remaining).toBe(1);
    const unstamped = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE ontology_checked_at IS NULL`,
    );
    expect(unstamped.map((r) => r.id)).toEqual(['f1']);
  });

  it('omits budgetStop when no budget is set', async () => {
    const { wiki } = await makeWiki(2);
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result.budgetStop).toBeUndefined();
    expect(result.typed).toBe(2);
  });
});

describe('runOntologyBackfill tokenBudget (generative path)', () => {
  async function makeGenerativeWiki(onDiagnostic?: (d: any) => void) {
    const db = openTestDatabase();
    const generateText = vi.fn(async (p: { userPrompt: string }) => {
      const id = /"id":\s*"(f\d)"/.exec(p.userPrompt)?.[1] ?? 'f0';
      return JSON.stringify({ classifications: [{ id, okf_type: 'person' }] });
    });
    const wiki = createWiki(db, {
      llmProvider: { generateText },
      config: { reportLlmUsage: true },
      ...(onDiagnostic ? { onDiagnostic } : {}),
    });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    // Two facts too large to share one prompt (2 x 25k chars > the 40k prompt cap), so each gets its own call.
    for (let i = 0; i < 2; i++) {
      await db.runAsync(
        `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
         VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0)`,
        [`f${i}`, `f${i}`, 'x'.repeat(25_000), 100 + i, 100 + i],
      );
    }
    return { db, wiki, generateText };
  }

  it('stops mid-pass: budgetStop set, unattempted facts not scanned and not cooldown-stamped', async () => {
    const probeDiags: any[] = [];
    const probe = await makeGenerativeWiki((d) => probeDiags.push(d));
    await probe.wiki.runOntologyBackfill('e1');
    const usage = probeDiags.filter((d) => d.code === 'llm_usage');
    expect(usage).toHaveLength(2);
    const { inputTokens, outputTokens } = usage[0].detail;

    // First call fits; the second needs `inputTokens` but only inputTokens - 1 remain.
    const { db, wiki, generateText } = await makeGenerativeWiki();
    const result = await wiki.runOntologyBackfill('e1', { tokenBudget: inputTokens + outputTokens + inputTokens - 1 });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.budgetStop).toEqual({ requiredEstimate: inputTokens });
    expect(result.scanned).toBe(1);
    expect(result.remaining).toBe(1);
    const unstamped = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE ontology_checked_at IS NULL`,
    );
    expect(unstamped.map((r) => r.id)).toEqual(['f1']);
  });
});
