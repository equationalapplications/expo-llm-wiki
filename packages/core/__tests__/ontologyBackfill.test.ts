import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';
import { MIGRATIONS } from '../src/db/migrations';
import { createWiki, WikiMemory } from '../src/index';
import type { SQLiteAdapter, WikiFact, OntologyManifest } from '../src/types';
import { WikiBusyError } from '../src/types';
import {
  ONTOLOGY_BACKFILL_BATCH_SIZE,
  ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS,
  ONTOLOGY_BACKFILL_RECHECK_MS,
} from '../src/services/MaintenanceService';

const PREFIX = 'llm_wiki_';

async function entryColumns(db: SQLiteAdapter): Promise<string[]> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${PREFIX}entries)`);
  return cols.map(c => c.name);
}

describe('migration v7 — ontology_checked_at', () => {
  it('fresh install has the column via base schema', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    expect(await entryColumns(db)).toContain('ontology_checked_at');
  });

  it('upgrade from v6 adds the column, and re-running is idempotent', async () => {
    const db = openTestDatabase();
    // Simulate a pre-v7 install: base schema without the new column.
    await db.execAsync(`
      CREATE TABLE ${PREFIX}entries (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL DEFAULT 'inferred',
        source_type TEXT NOT NULL DEFAULT 'librarian_inferred', source_hash TEXT, source_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
        embedding TEXT, embedding_blob BLOB, okf_type TEXT
      );
    `);
    const v7 = MIGRATIONS.find(m => m.version === 7)!;
    expect(v7).toBeDefined();
    await v7.run(db, PREFIX);
    expect(await entryColumns(db)).toContain('ontology_checked_at');
    await v7.run(db, PREFIX); // idempotent — no throw
    expect((await entryColumns(db)).filter(c => c === 'ontology_checked_at')).toHaveLength(1);
  });
});

import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';

function makeRepo(db: SQLiteAdapter): EntryRepository {
  return new EntryRepository(db, PREFIX, new OutboxRepository(db, PREFIX, false));
}

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

describe('EntryRepository — backfill methods', () => {
  it('findUntypedByEntityId: untyped, live, past cooldown, oldest first, limited', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'f_old', updatedAt: 100 });
    await seedEntry(db, { id: 'f_new', updatedAt: 200 });
    await seedEntry(db, { id: 'f_typed', updatedAt: 50, okfType: 'person' });
    await seedEntry(db, { id: 'f_deleted', updatedAt: 60, deletedAt: 999 });
    await seedEntry(db, { id: 'f_cooling', updatedAt: 70, checkedAt: 5000 });
    await seedEntry(db, { id: 'f_recheck_due', updatedAt: 80, checkedAt: 400 });
    await seedEntry(db, { id: 'f_other_entity', entityId: 'e2', updatedAt: 10 });

    const rows = await repo.findUntypedByEntityId('e1', 10, 400);
    expect(rows.map(r => r.id)).toEqual(['f_recheck_due', 'f_old', 'f_new']);

    const limited = await repo.findUntypedByEntityId('e1', 2, 400);
    expect(limited.map(r => r.id)).toEqual(['f_recheck_due', 'f_old']);
  });

  it('countUntypedByEntityId splits eligible vs deferred', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'a' });
    await seedEntry(db, { id: 'b', checkedAt: 5000 });
    await seedEntry(db, { id: 'c', checkedAt: 100 });
    await seedEntry(db, { id: 'd', okfType: 'person' });
    expect(await repo.countUntypedByEntityId('e1', 400)).toEqual({ eligible: 2, deferred: 1 });
  });

  it('updateOkfType only writes when okf_type IS NULL; returns changes', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'u1' });
    await seedEntry(db, { id: 'u2', okfType: 'place' });
    await db.withTransactionAsync(async (tx) => {
      expect((await repo.updateOkfType('u1', 'e1', 'person', tx)).changes).toBe(1);
      expect((await repo.updateOkfType('u2', 'e1', 'person', tx)).changes).toBe(0);
      expect((await repo.updateOkfType('u1', 'wrong-entity', 'place', tx)).changes).toBe(0);
    });
    const row = await db.getFirstAsync<{ okf_type: string }>(
      `SELECT okf_type FROM ${PREFIX}entries WHERE id = 'u2'`);
    expect(row!.okf_type).toBe('place');
  });

  it('markOntologyChecked stamps cooldown and never touches updated_at', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 'm1', updatedAt: 111 });
    await seedEntry(db, { id: 'm2', updatedAt: 222 });
    await db.withTransactionAsync(tx => repo.markOntologyChecked(['m1', 'm2'], 'e1', 9999, tx));
    const rows = await db.getAllAsync<{ id: string; updated_at: number; ontology_checked_at: number }>(
      `SELECT id, updated_at, ontology_checked_at FROM ${PREFIX}entries ORDER BY id`);
    expect(rows).toEqual([
      { id: 'm1', updated_at: 111, ontology_checked_at: 9999 },
      { id: 'm2', updated_at: 222, ontology_checked_at: 9999 },
    ]);
  });

  it('findTitleIndexByEntityId returns id/title/okf_type for all live facts', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const repo = makeRepo(db);
    await seedEntry(db, { id: 't1', title: 'Alpha', okfType: 'person' });
    await seedEntry(db, { id: 't2', title: 'Beta' });
    await seedEntry(db, { id: 't3', title: 'Gone', deletedAt: 5 });
    const rows = await repo.findTitleIndexByEntityId('e1');
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 't1', title: 'Alpha', okf_type: 'person' },
      { id: 't2', title: 'Beta', okf_type: null },
    ]);
  });
});

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

async function makeWiki(mode: 'strict' | 'emergent' | 'off' = 'strict') {
  const db = openTestDatabase();
  const generateText = vi.fn<any>();
  const wiki = createWiki(db, { llmProvider: { generateText } } as any);
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode });
  return { db, wiki, generateText };
}

const llmJson = (obj: unknown) => JSON.stringify(obj);

async function edgeCount(db: SQLiteAdapter): Promise<number> {
  const r = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${PREFIX}edges`);
  return r!.c;
}

async function getFactRow(db: SQLiteAdapter, id: string) {
  return db.getFirstAsync<{ okf_type: string | null; updated_at: number; ontology_checked_at: number | null }>(
    `SELECT okf_type, updated_at, ontology_checked_at FROM ${PREFIX}entries WHERE id = ?`, [id]);
}

describe('runOntologyBackfill', () => {
  // Spec test 1
  it('types untyped facts, creates edges, reports counts', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_p', title: 'Ada', updatedAt: 100 });
    await seedEntry(db, { id: 'fact_c', title: 'London', updatedAt: 200 });
    generateText.mockResolvedValue(llmJson({
      classifications: [
        { id: 'fact_c', okf_type: 'place' },
        { id: 'fact_p', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'London' }] },
      ],
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result).toEqual({ scanned: 2, typed: 2, failedValidation: 0, edgesAdded: 1, remaining: 0, deferred: 0 });
    expect((await getFactRow(db, 'fact_p'))!.okf_type).toBe('person');
    expect((await getFactRow(db, 'fact_c'))!.okf_type).toBe('place');
    expect(await edgeCount(db)).toBe(1);
  });

  // Spec test 2a
  it('early exit: ontology mode off — no LLM call, remaining 0', async () => {
    const { db, wiki, generateText } = await makeWiki('off');
    await seedEntry(db, { id: 'fact_x' });
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0, remaining: 0, deferred: 0 });
  });

  // Spec test 2b
  it('early exit: zero untyped facts — no LLM call', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_t', okfType: 'person' });
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0, remaining: 0, deferred: 0 });
  });

  // Spec test 3
  it('additive: never overwrites okf_type, never deletes or rewrites facts', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_a', title: 'A', body: 'body A' });
    await seedEntry(db, { id: 'fact_pre', title: 'P', okfType: 'place' }); // already typed — model responds anyway
    generateText.mockResolvedValue(llmJson({
      classifications: [
        { id: 'fact_a', okf_type: 'person' },
        { id: 'fact_pre', okf_type: 'person' }, // unknown id (not in batch) → failedValidation
      ],
    }));
    const before = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${PREFIX}entries`);
    const result = await wiki.runOntologyBackfill('e1');
    const after = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${PREFIX}entries`);
    expect(after!.c).toBe(before!.c);
    expect((await getFactRow(db, 'fact_pre'))!.okf_type).toBe('place'); // untouched
    expect(result.typed).toBe(1);
    expect(result.failedValidation).toBe(1);
    const row = await db.getFirstAsync<{ body: string }>(`SELECT body FROM ${PREFIX}entries WHERE id = 'fact_a'`);
    expect(row!.body).toBe('body A'); // never rewritten
  });

  // Spec test 4
  it('emergent: merges ontology_updates before validating classifications', async () => {
    const { db, wiki, generateText } = await makeWiki('emergent');
    await seedEntry(db, { id: 'fact_n', title: 'N' });
    generateText.mockResolvedValue(llmJson({
      classifications: [{ id: 'fact_n', okf_type: 'project' }],
      ontology_updates: { node_types: [{ type: 'project', description: 'A project' }] },
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.typed).toBe(1);
    expect((await getFactRow(db, 'fact_n'))!.okf_type).toBe('project');
    const manifest = await wiki.getOntologyManifest('e1');
    expect(manifest!.manifest.node_types.some(n => n.type === 'project')).toBe(true);
  });

  // Spec test 5
  it('strict: non-manifest type rejected, cooldown-stamped, lands in deferred', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_bad' });
    generateText.mockResolvedValue(llmJson({
      classifications: [{ id: 'fact_bad', okf_type: 'spaceship' }],
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result).toMatchObject({ scanned: 1, typed: 0, failedValidation: 1, remaining: 0, deferred: 1 });
    const row = await getFactRow(db, 'fact_bad');
    expect(row!.okf_type).toBeNull();
    expect(row!.ontology_checked_at).not.toBeNull();
  });

  // Spec test 6
  it('batch cap: 30 untyped → one call with 25 oldest, remaining 5', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    for (let i = 0; i < 30; i++) {
      await seedEntry(db, { id: `fact_${String(i).padStart(2, '0')}`, updatedAt: 1000 + i });
    }
    generateText.mockImplementation(async ({ userPrompt }: { userPrompt: string }) => {
      const ids = [...userPrompt.matchAll(/fact_\d\d/g)].map(m => m[0]);
      return llmJson({ classifications: [...new Set(ids)].map(id => ({ id, okf_type: 'person' })) });
    });
    const result = await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 25, typed: 25, remaining: 5 });
    // oldest-first: fact_25..fact_29 (newest) are the ones left untyped
    expect((await getFactRow(db, 'fact_29'))!.okf_type).toBeNull();
    expect((await getFactRow(db, 'fact_00'))!.okf_type).toBe('person');
  });

  // Spec test 7
  it('payload guard: truncates below batchSize; single oversized fact still sent alone', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    const big = 'x'.repeat(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS - 100);
    await seedEntry(db, { id: 'fact_big1', body: big, updatedAt: 100 });
    await seedEntry(db, { id: 'fact_big2', body: big, updatedAt: 200 });
    generateText.mockResolvedValue(llmJson({ classifications: [{ id: 'fact_big1', okf_type: 'person' }] }));
    const r1 = await wiki.runOntologyBackfill('e1');
    expect(r1.scanned).toBe(1); // second fact would blow the char budget
    expect(r1.remaining).toBe(1);
    // second run: the remaining oversized fact is sent alone, never starved
    generateText.mockResolvedValue(llmJson({ classifications: [{ id: 'fact_big2', okf_type: 'person' }] }));
    const r2 = await wiki.runOntologyBackfill('e1');
    expect(r2.scanned).toBe(1);
    expect(r2.typed).toBe(1);
  });

  // Spec test 8
  it('intra-batch edges resolve after all types applied', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_who', title: 'Grace', updatedAt: 100 });
    await seedEntry(db, { id: 'fact_where', title: 'Paris', updatedAt: 200 });
    generateText.mockResolvedValue(llmJson({
      classifications: [
        // edge source listed BEFORE the target is typed — two-phase ordering must handle it
        { id: 'fact_who', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Paris' }] },
        { id: 'fact_where', okf_type: 'place' },
      ],
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.edgesAdded).toBe(1);
    const edge = await db.getFirstAsync<{ source_id: string; target_id: string; edge_type: string }>(
      `SELECT source_id, target_id, edge_type FROM ${PREFIX}edges`);
    expect(edge).toEqual({ source_id: 'fact_who', target_id: 'fact_where', edge_type: 'lives_in' });
  });

  // Spec test 9
  it('full title index breadth: edge to already-typed fact outside recent-100 window', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_target', title: 'Old Town', okfType: 'place', updatedAt: 10 });
    await seedEntry(db, { id: 'fact_source', title: 'Elder', updatedAt: 20 });
    for (let i = 0; i < 110; i++) {
      await seedEntry(db, { id: `fact_noise_${i}`, title: `Noise ${i}`, okfType: 'person', updatedAt: 10_000 + i });
    }
    generateText.mockResolvedValue(llmJson({
      classifications: [{ id: 'fact_source', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Old Town' }] }],
    }));
    const result = await wiki.runOntologyBackfill('e1');
    expect(result.edgesAdded).toBe(1);
  });

  // Spec test 10
  it('recheck cooldown: omitted fact deferred, re-eligible after cooldown; host loop terminates', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_meh' });
    generateText.mockResolvedValue(llmJson({ classifications: [] })); // model omits it
    const r1 = await wiki.runOntologyBackfill('e1');
    expect(r1).toMatchObject({ scanned: 1, typed: 0, failedValidation: 0, remaining: 0, deferred: 1 });

    // Host convergence loop terminates immediately: remaining === 0.
    generateText.mockClear();
    const r2 = await wiki.runOntologyBackfill('e1');
    expect(generateText).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ scanned: 0, remaining: 0, deferred: 1 });

    // Age the stamp past the cooldown → selected again.
    await db.runAsync(
      `UPDATE ${PREFIX}entries SET ontology_checked_at = ? WHERE id = 'fact_meh'`,
      [Date.now() - ONTOLOGY_BACKFILL_RECHECK_MS - 1000]);
    generateText.mockResolvedValue(llmJson({ classifications: [{ id: 'fact_meh', okf_type: 'person' }] }));
    const r3 = await wiki.runOntologyBackfill('e1');
    expect(r3).toMatchObject({ scanned: 1, typed: 1 });
  });

  // Spec test 11
  it('cooldown stamp never touches updated_at', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_skip', updatedAt: 424242 });
    generateText.mockResolvedValue(llmJson({ classifications: [] }));
    await wiki.runOntologyBackfill('e1');
    const row = await getFactRow(db, 'fact_skip');
    expect(row!.updated_at).toBe(424242);
    expect(row!.ontology_checked_at).not.toBeNull();
  });

  // Spec test 12
  it('malformed output throws with lock released and zero writes; unknown ids counted not thrown', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_j', updatedAt: 777 });
    generateText.mockResolvedValue('not json at all {');
    await expect(wiki.runOntologyBackfill('e1')).rejects.toThrow();
    const row = await getFactRow(db, 'fact_j');
    expect(row!.okf_type).toBeNull();
    expect(row!.ontology_checked_at).toBeNull(); // no cooldown stamps outside the tx

    // lock released — next run proceeds
    generateText.mockResolvedValue(llmJson({ classifications: [{ id: 'fact_ghost', okf_type: 'person' }] }));
    const r = await wiki.runOntologyBackfill('e1');
    expect(r).toMatchObject({ scanned: 1, typed: 0, failedValidation: 1 });
  });

  it('duplicate classification ids: first wins, duplicates counted as failedValidation', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_dup' });
    generateText.mockResolvedValue(llmJson({
      classifications: [
        { id: 'fact_dup', okf_type: 'person' },
        { id: 'fact_dup', okf_type: 'place' },
      ],
    }));
    const r = await wiki.runOntologyBackfill('e1');
    expect(r.typed).toBe(1);
    expect(r.failedValidation).toBe(1);
    expect((await getFactRow(db, 'fact_dup'))!.okf_type).toBe('person');
  });

  it('options.batchSize overrides the default; invalid values throw', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_b1', updatedAt: 1 });
    await seedEntry(db, { id: 'fact_b2', updatedAt: 2 });
    generateText.mockResolvedValue(llmJson({ classifications: [{ id: 'fact_b1', okf_type: 'person' }] }));
    const r = await wiki.runOntologyBackfill('e1', { batchSize: 1 });
    expect(r.scanned).toBe(1);
    expect(r.remaining).toBe(1);
    await expect(wiki.runOntologyBackfill('e1', { batchSize: 0 })).rejects.toThrow(/batchSize/);
    expect(ONTOLOGY_BACKFILL_BATCH_SIZE).toBe(25);
  });
});

describe('runOntologyBackfill — lock discipline (WikiMemory)', () => {
  it('concurrent invocation throws WikiBusyError; sequential run succeeds', async () => {
    const { db, wiki, generateText } = await makeWiki('strict');
    await seedEntry(db, { id: 'fact_lock' });

    let releaseLlm!: () => void;
    const gate = new Promise<void>(resolve => { releaseLlm = resolve; });
    generateText.mockImplementation(async () => {
      await gate;
      return llmJson({ classifications: [{ id: 'fact_lock', okf_type: 'person' }] });
    });

    const first = wiki.runOntologyBackfill('e1');
    await new Promise(r => setTimeout(r, 10)); // let first acquire the lock
    await expect(wiki.runOntologyBackfill('e1')).rejects.toThrow(WikiBusyError);

    releaseLlm();
    await expect(first).resolves.toMatchObject({ typed: 1 });

    // sequential run after completion succeeds (early-exits: nothing untyped)
    await expect(wiki.runOntologyBackfill('e1')).resolves.toMatchObject({ scanned: 0 });
  });
});
