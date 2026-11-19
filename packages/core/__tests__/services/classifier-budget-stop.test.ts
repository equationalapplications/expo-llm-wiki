import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { createWiki } from '../../src/index';
import { WikiBudgetExhausted } from '../../src/utils/usage';
import { callClassify } from '../../src/utils/llmCall';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, SQLiteAdapter, WikiOptions } from '../../src/types';

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

async function makeWiki(
  classify: (r: ClassifyRequest) => Promise<ClassifyResponse>,
  count: number,
  onDiagnostic?: (d: any) => void,
) {
  const db = openTestDatabase();
  const wiki = createWiki(db, {
    llmProvider: { generateText: vi.fn(async () => '{}'), classify: vi.fn(classify) },
    config: { chunkConcurrency: 4 },
    ...(onDiagnostic ? { onDiagnostic } : {}),
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  for (let i = 0; i < count; i++) await seed(db, `f${i}`, 100 + i);
  return { db, wiki };
}

describe('classifier backfill budget stop', () => {
  it('waits for in-flight calls, persists settled successes, excludes unattempted from scanned', async () => {
    let call = 0;
    const diags: any[] = [];
    const { db, wiki } = await makeWiki(
      async () => {
        call += 1;
        if (call === 2) throw new WikiBudgetExhausted(100, 0);
        return ok();
      },
      12,
      (d) => diags.push(d),
    );
    const result: any = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result.budgetStop).toEqual({ requiredEstimate: 100 });
    expect(result.scanned).toBeLessThan(12);
    expect(result.typed).toBeGreaterThan(0);
    expect(result.remaining).toBeGreaterThan(0);
    const stamped = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE ontology_checked_at IS NOT NULL`,
    );
    expect(stamped.length).toBeLessThanOrEqual(result.scanned);
    expect(diags.some((d) => d.code === 'classification_invalid' && d.detail?.reason === 'classify_threw')).toBe(false);
  });
});

describe('classifier input-overflow', () => {
  it('emits context_overflow_skipped and cooldown-stamps the fact (errata E2)', async () => {
    const diags: any[] = [];
    const { db, wiki } = await makeWiki(
      async () => {
        throw new Error('prompt is too long: 100 tokens > 50 token maximum');
      },
      1,
      (d) => diags.push(d),
    );
    const r1 = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(r1.skipped).toBe(1);
    const overflow = diags.filter((d) => d.code === 'context_overflow_skipped');
    expect(overflow).toHaveLength(1);
    expect(overflow[0].detail).toEqual({ factId: 'f0' });
    const stamped = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE ontology_checked_at IS NOT NULL`,
    );
    expect(stamped.map((s) => s.id)).toEqual(['f0']);
    expect(r1.remaining).toBe(0);
    expect(r1.deferred).toBe(1);
  });
});

describe('callClassify usage diagnostics', () => {
  const request = { state: 'x'.repeat(400), questions: { q: { kind: 'binary' as const, instructions: 'y' } } };
  const ctx = { operation: 'ontologyBackfill' as const, entityId: 'e1', trigger: 'call' as const };

  it('emits llm_usage when reportLlmUsage is true', async () => {
    const diags: any[] = [];
    const options = {
      llmProvider: { classify: async () => ({ answers: {}, usage: { inputTokens: 7, outputTokens: 3 } }) },
      config: { reportLlmUsage: true },
      onDiagnostic: (d: any) => diags.push(d),
    } as unknown as WikiOptions;
    await callClassify(options, ctx, request as any);
    const usage = diags.filter((d) => d.code === 'llm_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].detail).toEqual({ inputTokens: 7, outputTokens: 3, estimated: false });
  });

  it('emits nothing when reportLlmUsage is unset', async () => {
    const diags: any[] = [];
    const options = {
      llmProvider: { classify: async () => ({ answers: {}, usage: { inputTokens: 7, outputTokens: 3 } }) },
      onDiagnostic: (d: any) => diags.push(d),
    } as unknown as WikiOptions;
    await callClassify(options, ctx, request as any);
    expect(diags.filter((d) => d.code === 'llm_usage')).toHaveLength(0);
  });
});
