import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { SQLiteAdapter, WikiDiagnostic, WikiMemory } from '../src/types';
import { resolveOntologyJobDefaults, DEFAULT_ONTOLOGY_JOB_BATCH_SIZE } from '../src/utils/config/ontologyJobDefaults';

const PREFIX = 'llm_wiki_';
const MANIFEST = {
  node_types: [
    { type: 'person', description: 'a human' },
    { type: 'place', description: 'a location' },
  ],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'residence' }],
};

async function seedEntry(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; okfType?: string | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at,
        access_count, deleted_at, okf_type, ontology_checked_at)
     VALUES (?, ?, ?, 'body', '[]', 'certain', 'user_stated', 1000, 1000, 0, NULL, ?, NULL)`,
    [opts.id, opts.entityId ?? 'e1', `title ${opts.id}`, opts.okfType ?? null],
  );
}

async function mk(opts: { ontology?: Record<string, unknown>; onDiagnostic?: (d: WikiDiagnostic) => void } = {}) {
  const db = openTestDatabase();
  const generateText = vi.fn(async () => JSON.stringify({
    classifications: [{ id: 'fact_a', okf_type: 'person' }, { id: 'fact_b', okf_type: 'place' }],
  }));
  const wiki = createWiki(db, {
    llmProvider: { generateText },
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
    config: {
      maintenance: 'deferred',
      librarian: { strategy: 'ops' },
      ontology: { schedulerBatchSize: 50, ...opts.ontology },
    },
  } as any) as WikiMemory;
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  await seedEntry(db, { id: 'fact_a' });
  await seedEntry(db, { id: 'fact_b' });
  return { db, wiki, generateText };
}

describe('resolveOntologyJobDefaults', () => {
  it('defaults to 50 with no ontology config', () => {
    expect(resolveOntologyJobDefaults(undefined)).toEqual({ batchSize: DEFAULT_ONTOLOGY_JOB_BATCH_SIZE });
    expect(DEFAULT_ONTOLOGY_JOB_BATCH_SIZE).toBe(50);
  });

  it('honours a valid schedulerBatchSize', () => {
    expect(resolveOntologyJobDefaults({ schedulerBatchSize: 7 } as any)).toEqual({ batchSize: 7 });
  });

  it('falls back to the default on invalid values', () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, '10' as unknown as number, null as unknown as number]) {
      expect(resolveOntologyJobDefaults({ schedulerBatchSize: bad } as any).batchSize).toBe(50);
    }
  });
});

describe('scheduler ontology-backfill job (specs/system-one-config §8)', () => {
  it('getPendingMaintenance reports pendingOntologyBackfill only when ontology is on', async () => {
    const { wiki } = await mk();
    const pending = await wiki.getPendingMaintenance();
    expect(pending.map((p) => [p.entityId, p.pendingOntologyBackfill])).toEqual([['e1', 2]]);

    // Mode off for the entity: nothing is eligible, nothing reported.
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
    expect(await wiki.getPendingMaintenance()).toEqual([]);
  });

  it('runPendingMaintenance runs the job: facts typed, report counts set, pending clears', async () => {
    const { wiki, generateText } = await mk();
    const r = await wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'] });
    expect(r.stoppedReason).toEqual({ reason: 'complete' });
    expect(r.perEntity).toEqual([
      { entityId: 'e1', librarianPasses: 0, factsWritten: 0, healPasses: 0, reembedded: false, ontologyBackfillPasses: 1, typed: 2 },
    ]);
    expect(await wiki.getPendingMaintenance()).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(1);
    const rows = await (wiki as any).db.getAllAsync<{ id: string; okf_type: string }>(
      `SELECT id, okf_type FROM ${PREFIX}entries ORDER BY id`,
    );
    expect(rows).toEqual([{ id: 'fact_a', okf_type: 'person' }, { id: 'fact_b', okf_type: 'place' }]);
  });

  it('held lock: nothing runs, busy names the job, ontology_backfill_held diagnostic emitted', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const { wiki } = await mk({ onDiagnostic: (d) => diagnostics.push(d) });
    const { jobManager } = (wiki as any).__testAccess;
    jobManager.acquireLock('ontologyBackfill', 'e1');
    try {
      const r = await wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'] });
      expect(r.perEntity[0]).toMatchObject({ entityId: 'e1', ontologyBackfillPasses: 0, typed: 0, busy: ['ontologyBackfill'] });
    } finally {
      jobManager.releaseLock('ontologyBackfill', 'e1');
    }
    const held = diagnostics.filter((d) => d.code === 'ontology_backfill_held');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ severity: 'info', operation: 'ontologyBackfill', entityId: 'e1' });
  });

  it('schedulerBatchSize bounds the pass: one fact per pass, remainder waits for the next run', async () => {
    const { wiki, generateText } = await mk({ ontology: { schedulerBatchSize: 1 } });
    const r = await wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'] });
    expect(r.perEntity[0]).toMatchObject({ ontologyBackfillPasses: 1, typed: 1 });
    expect(generateText).toHaveBeenCalledTimes(1);
    const userPrompt = generateText.mock.calls[0][0].userPrompt as string;
    expect(userPrompt).toContain('fact_a');
    expect(userPrompt).not.toContain('fact_b');
    expect(await wiki.getPendingMaintenance()).toEqual([{ entityId: 'e1', pendingEvents: 0, pendingTokensEstimate: 0, healDue: false, reembedPending: false, pendingOntologyBackfill: 1 }]);
    // Second run picks up the remainder.
    const r2 = await wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'] });
    expect(r2.perEntity[0]).toMatchObject({ ontologyBackfillPasses: 1, typed: 1 });
    expect(await wiki.getPendingMaintenance()).toEqual([]);
  });

  it('tokenBudget too small for the ontology pass names the job', async () => {
    const { wiki } = await mk();
    const r = await wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'], tokenBudget: 1 });
    expect(r.stoppedReason).toMatchObject({ reason: 'budget_too_small', job: 'ontologyBackfill', entityId: 'e1' });
    expect((r.stoppedReason as any).requiredEstimate).toBeGreaterThan(1);
  });
});
