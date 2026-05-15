/**
 * Integration tests for the Atomic Outbox pattern (spec section 5).
 *
 * These tests verify three guarantees:
 *  1. Outbox totality: every entry written during ingestDocument has a corresponding outbox row.
 *  2. Transaction integrity: entry + outbox writes are atomic; a mid-transaction failure leaves both tables clean.
 *  3. read() shape regression: MemoryBundle returned by read() has the expected structure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../../src/WikiMemory';
import { EntryRepository } from '../../src/repositories/EntryRepository';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { MIGRATIONS } from '../../src/db/migrations';
import type { SQLiteAdapter, WikiFact } from '../../src/types';

const PREFIX = 'llm_wiki_';
const FAKE_SOURCE_HASH = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupWithOutbox(db: SQLiteAdapter, prefix: string): Promise<void> {
  await setupDatabase(db, prefix);
  // Run migration v4 to create the outbox table (same pattern as OutboxRepository.test.ts).
  const migration = MIGRATIONS.find(m => m.version === 4);
  if (migration) {
    await migration.run(db, prefix);
  }
}

function makeMockLlmProvider(facts: Array<{ title: string; body: string; tags: string[]; confidence: string }>) {
  return {
    generateText: async (_: { systemPrompt: string; userPrompt: string }): Promise<string> => {
      return JSON.stringify({ facts, tasks: [] });
    },
  };
}

async function makeWiki(
  db: SQLiteAdapter,
  facts: Array<{ title: string; body: string; tags: string[]; confidence: string }>,
): Promise<WikiMemory> {
  const wiki = new WikiMemory(db, {
    llmProvider: makeMockLlmProvider(facts),
    config: { tablePrefix: PREFIX },
  });
  await wiki.setup();
  return wiki;
}

function makeFact(overrides?: Partial<WikiFact>): WikiFact {
  return {
    id: 'fact_' + Math.random().toString(36).slice(2),
    entity_id: 'entity1',
    title: 'Test Fact',
    body: 'Body here',
    tags: ['tag1'],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    last_accessed_at: null,
    deleted_at: null,
    access_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Outbox totality
// ---------------------------------------------------------------------------

describe('Outbox totality: entry count === outbox count after ingestDocument', () => {
  let db: ReturnType<typeof openTestDatabase>;

  beforeEach(async () => {
    db = openTestDatabase();
    // WikiMemory.setup() runs all pending migrations including v4 (outbox).
    // No separate setupWithOutbox needed here — setup() handles it.
  });

  it('produces exactly N outbox rows for N facts ingested', async () => {
    const facts = [
      { title: 'Fact 1', body: 'Body 1', tags: ['tag1'], confidence: 'certain' as const },
      { title: 'Fact 2', body: 'Body 2', tags: ['tag2'], confidence: 'inferred' as const },
      { title: 'Fact 3', body: 'Body 3', tags: [], confidence: 'tentative' as const },
    ];

    const wiki = await makeWiki(db, facts);
    await wiki.ingestDocument('entity_totality', {
      sourceRef: 'doc://totality-test',
      sourceHash: FAKE_SOURCE_HASH,
      documentChunk: 'Some content that triggers fact extraction.',
    });

    const entryRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE entity_id = ? AND deleted_at IS NULL`,
      ['entity_totality'],
    );
    const outboxRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}outbox`,
    );

    expect(entryRows.length).toBe(facts.length);
    expect(outboxRows.length).toBe(facts.length);
    expect(outboxRows.length).toBe(entryRows.length);
  });

  it('produces 0 outbox rows when LLM returns no facts', async () => {
    const wiki = await makeWiki(db, []);
    await wiki.ingestDocument('entity_empty', {
      sourceRef: 'doc://empty-test',
      sourceHash: FAKE_SOURCE_HASH,
      documentChunk: 'Content that yields no facts.',
    });

    const entryRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE entity_id = ? AND deleted_at IS NULL`,
      ['entity_empty'],
    );
    const outboxRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}outbox`,
    );

    expect(entryRows.length).toBe(0);
    expect(outboxRows.length).toBe(0);
  });

  it('stages delete outbox events for replaced source facts on repeated ingestDocument()', async () => {
    const firstFacts = [
      { title: 'First Fact', body: 'Body 1', tags: ['tag1'], confidence: 'certain' as const },
    ];
    const secondFacts = [
      { title: 'Second Fact A', body: 'Body A', tags: ['tagA'], confidence: 'certain' as const },
      { title: 'Second Fact B', body: 'Body B', tags: ['tagB'], confidence: 'certain' as const },
    ];

    const wiki = await makeWiki(db, firstFacts);
    await wiki.ingestDocument('entity_replace', {
      sourceRef: 'doc://replace-test',
      sourceHash: FAKE_SOURCE_HASH,
      documentChunk: 'First content chunk',
    });

    // Reconfigure the LLM to return a new fact set for the same sourceRef.
    (wiki as any).options.llmProvider = makeMockLlmProvider(secondFacts);

    await wiki.ingestDocument('entity_replace', {
      sourceRef: 'doc://replace-test',
      sourceHash: FAKE_SOURCE_HASH,
      documentChunk: 'Second content chunk',
    });

    const entryRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE entity_id = ? AND deleted_at IS NULL`,
      ['entity_replace'],
    );
    const outboxRows = await db.getAllAsync<any>(
      `SELECT * FROM ${PREFIX}outbox ORDER BY id ASC`,
    );

    expect(entryRows.length).toBe(2);
    expect(outboxRows.length).toBe(4);
    expect(outboxRows.some(row => row.operation === 'DELETE')).toBe(true);
    expect(outboxRows.filter(row => row.operation === 'UPSERT').length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Transaction integrity — entry write + outbox push are atomic
// ---------------------------------------------------------------------------

describe('Transaction integrity: entry and outbox writes are atomic', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let entryRepo: EntryRepository;
  let outboxRepo: OutboxRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupWithOutbox(db, PREFIX);
    outboxRepo = new OutboxRepository(db, PREFIX);
    entryRepo = new EntryRepository(db, PREFIX, outboxRepo);
  });

  it('rollback after entryRepo.upsert() leaves both entries and outbox empty', async () => {
    const fact = makeFact({ id: 'fact_atomic_test', entity_id: 'entity_atomic' });

    await expect(
      db.withTransactionAsync(async () => {
        await entryRepo.upsert(fact, db);
        // Verify row is visible inside the transaction before rollback.
        const inTxEntries = await db.getAllAsync<{ id: string }>(
          `SELECT id FROM ${PREFIX}entries WHERE id = ?`,
          [fact.id],
        );
        expect(inTxEntries.length).toBe(1);
        const inTxOutbox = await db.getAllAsync<{ id: string }>(
          `SELECT id FROM ${PREFIX}outbox`,
        );
        expect(inTxOutbox.length).toBe(1);
        // Force rollback.
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    // After rollback, both tables must be empty.
    const entriesAfter = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE id = ?`,
      [fact.id],
    );
    expect(entriesAfter.length).toBe(0);

    const outboxAfter = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}outbox`,
    );
    expect(outboxAfter.length).toBe(0);
  });

  it('successful transaction commits both entry and outbox row together', async () => {
    const fact = makeFact({ id: 'fact_commit_test', entity_id: 'entity_commit' });

    await db.withTransactionAsync(async () => {
      await entryRepo.upsert(fact, db);
    });

    const entriesAfter = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM ${PREFIX}entries WHERE id = ?`,
      [fact.id],
    );
    expect(entriesAfter.length).toBe(1);

    const outboxAfter = await db.getAllAsync<any>(
      `SELECT * FROM ${PREFIX}outbox`,
    );
    expect(outboxAfter.length).toBe(1);
    expect(outboxAfter[0].record_id).toBe(fact.id);
    expect(outboxAfter[0].table_name).toBe('entries');
    expect(outboxAfter[0].entity_id).toBe(fact.entity_id);
  });
});

// ---------------------------------------------------------------------------
// Test 3: read() returns correct MemoryBundle shapes after refactor
// ---------------------------------------------------------------------------

describe('read() returns correct MemoryBundle shape (regression)', () => {
  let db: ReturnType<typeof openTestDatabase>;

  beforeEach(async () => {
    db = openTestDatabase();
  });

  it('result has facts, tasks, events arrays and facts have required fields', async () => {
    const facts = [
      { title: 'Regression Fact 1', body: 'Body for regression test', tags: ['regression'], confidence: 'certain' as const },
      { title: 'Regression Fact 2', body: 'Second regression body', tags: [], confidence: 'inferred' as const },
    ];

    const wiki = await makeWiki(db, facts);
    await wiki.ingestDocument('entity_read_shape', {
      sourceRef: 'doc://shape-test',
      sourceHash: FAKE_SOURCE_HASH,
      documentChunk: 'Content to extract facts from for shape regression test.',
    });

    const result = await wiki.read('entity_read_shape', 'test query');

    // Verify MemoryBundle shape.
    expect(Array.isArray(result.facts)).toBe(true);
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);

    // Verify at least one fact appears (read() uses MiniSearch scoring so not all facts
    // are guaranteed to match an arbitrary query, but at least one should rank).
    expect(result.facts.length).toBeGreaterThanOrEqual(1);

    // Verify each fact has the required fields.
    for (const fact of result.facts) {
      expect(typeof fact.id).toBe('string');
      expect(typeof fact.entity_id).toBe('string');
      expect(typeof fact.title).toBe('string');
      expect(typeof fact.body).toBe('string');
      expect(['certain', 'inferred', 'tentative']).toContain(fact.confidence);
    }
  });

  it('read() on empty entity returns empty arrays without throwing', async () => {
    const wiki = await makeWiki(db, []);

    const result = await wiki.read('entity_empty_read', 'any query');

    expect(result.facts).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.events).toEqual([]);
  });
});
