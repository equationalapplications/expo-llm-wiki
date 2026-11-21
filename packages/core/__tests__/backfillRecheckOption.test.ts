import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { OntologyManifest, WikiDiagnostic } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'p' }],
  edge_types: [],
};

describe('runOntologyBackfill recheckCheckedBefore (Task 9)', () => {
  it('a caller-provided cutoff re-opens facts the rolling window would defer', async () => {
    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
    const wiki = createWiki(db, { llmProvider: { generateText }, onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d) } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    const fact = await wiki.remember('e1', { title: 't1', body: 'body one', tags: [] } as never);

    // First pass stamps the cooldown.
    const first = await wiki.runOntologyBackfill('e1');
    expect(first.typed).toBe(0);
    expect(first.remaining).toBe(0); // rolling window defers the just-checked fact

    // Rolling window: the fact was checked seconds ago → deferred, LLM not called again.
    const callsAfterFirst = generateText.mock.calls.length;
    const second = await wiki.runOntologyBackfill('e1');
    expect(second.remaining).toBe(0);
    expect(second.deferred).toBe(1);
    expect(generateText.mock.calls.length).toBe(callsAfterFirst);

    // Explicit cutoff at-or-after any possible check stamp re-opens it. The
    // cutoff is pinned ahead of the clock (not `Date.now()` at call time) so
    // the stamp the backfill writes cannot land after the cutoff and flake
    // the deferred assertion (CodeRabbit #441).
    const recheckCutoff = Date.now() + 60_000;
    const third = await wiki.runOntologyBackfill('e1', { recheckCheckedBefore: recheckCutoff });
    expect(third.remaining).toBe(1);
    expect(third.deferred).toBe(0);
    expect(generateText.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(fact.id).toBeDefined();
  });
});

describe('typing queue sees current facts only (Task 10)', () => {
  it('expired and future-dated untyped facts are invisible to the queue and the counts', async () => {
    const { EntryRepository } = await import('../src/repositories/EntryRepository');
    const { OutboxRepository } = await import('../src/repositories/OutboxRepository');
    const { setupDatabase } = await import('../src/db/schema');
    const PREFIX = 'llm_wiki_';
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const outbox = new OutboxRepository(db, PREFIX, false);
    const repo = new EntryRepository(db, PREFIX, outbox);
    const now = Date.now();
    const mk = (id: string, valid_from: number | null, valid_to: number | null) => repo.upsert({
      id, entity_id: 'e1', title: `t-${id}`, body: 'b', tags: [], confidence: 'certain',
      source_type: 'user_stated', source_hash: null, source_ref: null,
      created_at: now, updated_at: now, last_accessed_at: null, access_count: 0,
      deleted_at: null, okf_type: null, ...(valid_from !== null ? { valid_from } : {}),
      ...(valid_to !== null ? { valid_to } : {}),
    } as never, undefined as never);
    await mk('live', null, null);
    await mk('expired', now - 5000, now - 1000);
    await mk('future', now + 60_000, null);
    // valid_from/valid_to are set through setTemporal (upsert ignores them).
    await repo.setTemporal('expired', 'e1', { valid_from: now - 5000, valid_to: now - 1000 }, undefined as never);
    await repo.setTemporal('future', 'e1', { valid_from: now + 60_000 }, undefined as never);
    const found = await repo.findUntypedByEntityId('e1', 10, 0);
    expect(found.map((f) => f.id).sort()).toEqual(['live']);
    const counts = await repo.countUntypedByEntityId('e1', 0);
    expect(counts).toEqual({ eligible: 1, deferred: 0 });
  });
});
