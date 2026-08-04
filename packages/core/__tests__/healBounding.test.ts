import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MIGRATIONS } from '../src/db/migrations';
import type { SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';

async function entryColumns(db: SQLiteAdapter): Promise<string[]> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${PREFIX}entries)`);
  return cols.map(c => c.name);
}

describe('migration v8 — heal_checked_at', () => {
  it('fresh install has the column via base schema', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    expect(await entryColumns(db)).toContain('heal_checked_at');
  });

  it('upgrade from v7 adds the column, and re-running is idempotent', async () => {
    const db = openTestDatabase();
    // Simulate a pre-v8 install: base schema without the new column.
    await db.execAsync(`
      CREATE TABLE ${PREFIX}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'librarian_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        embedding TEXT, embedding_blob BLOB, okf_type TEXT, ontology_checked_at INTEGER
      );
    `);
    const v8 = MIGRATIONS.find(m => m.version === 8)!;
    expect(v8).toBeDefined();
    await v8.run(db, PREFIX);
    expect(await entryColumns(db)).toContain('heal_checked_at');
    await v8.run(db, PREFIX); // idempotent — no throw
    expect((await entryColumns(db)).filter(c => c === 'heal_checked_at')).toHaveLength(1);
  });
});

import { createWiki } from '../src/index';
import { HEAL_BATCH_SIZE } from '../src/services/MaintenanceService';
import { vi } from 'vitest';

async function seedFact(db: SQLiteAdapter, opts: {
  id: string; entityId?: string; title?: string; body?: string;
  sourceType?: string; updatedAt?: number; healCheckedAt?: number | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at,
        updated_at, access_count, deleted_at, heal_checked_at)
     VALUES (?, ?, ?, ?, '[]', 'inferred', ?, ?, ?, 0, NULL, ?)`,
    [
      opts.id, opts.entityId ?? 'e1', opts.title ?? `title ${opts.id}`,
      opts.body ?? `body ${opts.id}`, opts.sourceType ?? 'librarian_inferred',
      opts.updatedAt ?? 1000, opts.updatedAt ?? 1000, opts.healCheckedAt ?? null,
    ],
  );
}

const noopHeal = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });

async function makeHealWiki(generateText: (p: { systemPrompt: string; userPrompt: string }) => Promise<string>) {
  const db = openTestDatabase();
  const wiki = createWiki(db, {
    llmProvider: { generateText },
    // Disable the orphan/stale SQL passes so these tests observe only the
    // bounded LLM phase.
    config: { orphanAfterDays: null, staleInferredAfterDays: null },
  } as any);
  await wiki.setup();
  return { db, wiki };
}

describe('doRunHeal — per-pass call bounding (#67)', () => {
  it('caps candidates at HEAL_BATCH_SIZE and reports the rest as remaining', async () => {
    const generateText = vi.fn(async () => noopHeal);
    const { db, wiki } = await makeHealWiki(generateText);
    for (let i = 0; i < HEAL_BATCH_SIZE + 5; i++) {
      await seedFact(db, { id: `f${String(i).padStart(2, '0')}`, updatedAt: 1000 + i });
    }

    const result = await wiki.runHeal('e1');

    expect(result.scanned).toBe(HEAL_BATCH_SIZE);
    expect(result.remaining).toBe(5);
    expect(result.deferred).toBe(HEAL_BATCH_SIZE);
  });

  it('stamps every offered candidate so pass N+1 skips them while in cooldown', async () => {
    const generateText = vi.fn(async () => noopHeal);
    const { db, wiki } = await makeHealWiki(generateText);
    for (let i = 0; i < HEAL_BATCH_SIZE + 5; i++) {
      await seedFact(db, { id: `f${String(i).padStart(2, '0')}`, updatedAt: 1000 + i });
    }

    await wiki.runHeal('e1');
    const r2 = await wiki.runHeal('e1');

    // Pass 2 sees only the 5 that pass 1 could not reach.
    expect(r2.scanned).toBe(5);
    expect(r2.remaining).toBe(0);
    const stamped = await db.getAllAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${PREFIX}entries WHERE heal_checked_at IS NOT NULL`);
    expect(stamped[0].c).toBe(HEAL_BATCH_SIZE + 5);
  });

  it('returns zeroed counts with a live remaining when nothing is eligible', async () => {
    const generateText = vi.fn(async () => noopHeal);
    const { db, wiki } = await makeHealWiki(generateText);
    await seedFact(db, { id: 'f0', healCheckedAt: Date.now() });

    const result = await wiki.runHeal('e1');

    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 0, downgraded: 0, deleted: 0, newFactsCreated: 0,
      skipped: 0, remaining: 0, deferred: 1,
    });
  });

  it('rejects an invalid batchSize', async () => {
    const { wiki } = await makeHealWiki(async () => noopHeal);
    await expect(wiki.runHeal('e1', { batchSize: 0 })).rejects.toThrow('Invalid batchSize');
  });

  it('converges under synthesis: facts heal creates do not re-enter the candidate set', async () => {
    // Every call synthesizes a distinct new fact. Without stamping created facts
    // at insert, `remaining` would be nonzero after a pass that fully covered
    // the pre-existing queue and a host `while (remaining > 0)` loop would feed
    // on heal's own output forever.
    let n = 0;
    const generateText = vi.fn(async () => JSON.stringify({
      downgraded: [], deleted: [],
      newFacts: [{
        title: `synthesized topic number ${n++}`,
        body: 'derived body',
        tags: [],
        confidence: 'inferred',
      }],
    }));
    const { db, wiki } = await makeHealWiki(generateText);
    for (let i = 0; i < 5; i++) await seedFact(db, { id: `f${i}`, updatedAt: 1000 + i });

    const result = await wiki.runHeal('e1');

    expect(result.newFactsCreated).toBeGreaterThan(0);
    expect(result.remaining).toBe(0);
    const unstamped = await db.getAllAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${PREFIX}entries
       WHERE deleted_at IS NULL AND source_type != 'immutable_document'
         AND heal_checked_at IS NULL`);
    expect(unstamped[0].c).toBe(0);
  });

  it('dedupes against librarian_inferred facts outside the candidate window', async () => {
    // Fixture is larger than batchSize by construction: with batchSize 2 and 6
    // facts, the duplicate target sits outside the window heal actually reads,
    // so this only passes if dedupe seeds from the full-breadth
    // findInferredTitlesByEntityId query rather than from healCandidates.
    const generateText = vi.fn(async () => JSON.stringify({
      downgraded: [], deleted: [],
      newFacts: [{
        title: 'unmistakable duplicate marker title',
        body: 'body',
        tags: [],
        confidence: 'inferred',
      }],
    }));
    const { db, wiki } = await makeHealWiki(generateText);
    // Oldest — inside the batchSize-2 window.
    await seedFact(db, { id: 'c0', updatedAt: 1000 });
    await seedFact(db, { id: 'c1', updatedAt: 1001 });
    // Newest — outside the window, but must still be seen by dedupe.
    await seedFact(db, {
      id: 'dup', updatedAt: 5000,
      title: 'unmistakable duplicate marker title',
      sourceType: 'librarian_inferred',
    });
    await seedFact(db, { id: 'c2', updatedAt: 5001 });

    const result = await wiki.runHeal('e1', { batchSize: 2 });

    expect(result.scanned).toBe(2);
    expect(result.newFactsCreated).toBe(0);
    const dupes = await db.getAllAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${PREFIX}entries
       WHERE title = 'unmistakable duplicate marker title' AND deleted_at IS NULL`);
    expect(dupes[0].c).toBe(1);
  });
});
