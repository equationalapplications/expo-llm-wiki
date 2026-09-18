import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WikiMemory, WikiGraphNodeOwnershipConflict,
  WikiSourceRefHashCollision, WikiStrictOntologyViolation,
} from '../src/WikiMemory';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiFact } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;
let repo: EntryRepository;
const prefix = 'llm_wiki_';
const tables = ['entries', 'edges', 'source_ref_index', 'entity_manifests',
  'checkpoints', 'meta', 'outbox'];

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}' },
    config: { enableOutbox: true },
  });
  await wiki.setup();
  repo = new EntryRepository(db, prefix, new OutboxRepository(db, prefix, true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.closeAsync();
});

function fact(overrides: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'foreign-fact', entity_id: 'entity-B', title: 'Private title',
    body: 'Private body', tags: ['private-tag'], confidence: 'certain',
    source_type: 'immutable_document', source_hash: null, source_ref: null,
    created_at: 100, updated_at: 200, last_accessed_at: 300,
    access_count: 7, deleted_at: null, generated_by: 'private-generator',
    stale_after: 900, last_verified_at: 400, last_verified_by: 'private-verifier',
    embedding_blob: new Uint8Array(new Float32Array([0.25, 0.75]).buffer),
    ...overrides,
  } as WikiFact;
}

async function snapshot(tx: SQLiteAdapter = db) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    result[table] = await tx.getAllAsync(`SELECT * FROM ${prefix}${table} ORDER BY rowid`);
  }
  return result;
}

async function seedForeign(deleted_at: number | null = null) {
  await db.withTransactionAsync(async tx => {
    await repo.upsert(fact({ deleted_at }), tx);
    // Distinct retained serialized metadata must never leak or be replaced.
    await tx.runAsync(`UPDATE llm_wiki_entries SET
      okf_sources = ?, okf_verified = ?, okf_usage_window = ?, updated_at = ?
      WHERE id = ?`, [
      '[{"private":"source-marker"}]', '[{"private":"verification-marker"}]',
      '{"private":"window-marker"}', 201, 'foreign-fact',
    ]);
  });
}

async function rejected(action: () => Promise<unknown>): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  throw new Error('Expected operation to reject');
}

function graph(nodes: Array<{ id: string; type: string; title: string }>) {
  return { sourceRef: 'a.ts', sourceHash: 'b'.repeat(64), nodes, edges: [] };
}

describe('repository ownership', () => {
  it.each([null, 123])('preserves a foreign row with deleted_at=%s', async deletedAt => {
    await seedForeign(deletedAt);
    const before = await snapshot();
    await db.withTransactionAsync(async tx => {
      await expect(repo.upsert(fact({ entity_id: 'entity-A', title: 'Replacement' }), tx))
        .rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves permitted update metadata and emits its normal event', async () => {
    await seedForeign();
    const before = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM llm_wiki_entries WHERE id = ?', ['foreign-fact']);
    const count = (await snapshot()).outbox.length;
    await db.withTransactionAsync(tx => repo.upsert(fact(), tx));
    const after = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM llm_wiki_entries WHERE id = ?', ['foreign-fact']);
    for (const key of ['created_at', 'generated_by', 'okf_sources', 'okf_verified',
      'okf_usage_window', 'last_verified_at', 'last_verified_by', 'embedding_blob']) {
      expect(after![key]).toEqual(before![key]);
    }
    const events = await db.getAllAsync<{ operation: string; payload: string }>(
      'SELECT operation, payload FROM llm_wiki_outbox ORDER BY rowid');
    expect(events).toHaveLength(count + 1);
    expect(events.at(-1)!.operation).toBe('UPDATE');
    expect(JSON.parse(events.at(-1)!.payload).generated_by).toBe('private-generator');
  });

  // The only hidden read is the early metadata lookup, so SQLite itself
  // executes the owner predicate. A repository built on a deliberately
  // unusable outer DB proves the write and the verification read cannot
  // escape the supplied tx.
  it.each([false, true])('detects real SQL suppression, underreport=%s', async underreport => {
    await seedForeign();
    const before = await snapshot();
    await db.withTransactionAsync(async realTx => {
      let hidden = false;
      let verificationReads = 0;
      const actualChanges: number[] = [];
      const tx = new Proxy(realTx, {
        get(target, key) {
          if (key === 'getFirstAsync') return async <T>(sql: string, params?: unknown[]) => {
            if (sql.includes('FROM llm_wiki_entries') && sql.includes('WHERE id = ?')) {
              if (!hidden) { hidden = true; return null; }
              verificationReads++;
            }
            return target.getFirstAsync<T>(sql, params);
          };
          if (key === 'runAsync') return async (sql: string, params?: unknown[]) => {
            const result = await target.runAsync(sql, params);
            if (sql.includes('ON CONFLICT(id) DO UPDATE')) actualChanges.push(result.changes);
            return underreport ? { ...result, changes: 0 } : result;
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SQLiteAdapter;
      const forbiddenDb = new Proxy(realTx, {
        get() { return () => { throw new Error('Outer database used instead of tx'); }; },
      }) as SQLiteAdapter;
      const guardedRepo = new EntryRepository(forbiddenDb, prefix,
        new OutboxRepository(forbiddenDb, prefix, true));
      await expect(guardedRepo.upsert(fact({ entity_id: 'entity-A' }), tx))
        .rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
      expect(actualChanges).toEqual([0]);
      expect(verificationReads).toBe(1);
    });
    expect(await snapshot()).toEqual(before);
  });

  // Robustness of upsert's disambiguation only. An adapter that behaves this
  // way violates the SQLiteAdapter contract and breaks unrelated count
  // consumers; upsert merely declines to compound it with a spurious
  // ownership error. This does NOT make under-reporting adapters supported.
  it('accepts inserts and unchanged/changed same-owner writes when changes underreports', async () => {
    await db.withTransactionAsync(async realTx => {
      const tx = new Proxy(realTx, {
        get(target, key) {
          if (key === 'runAsync') return async (sql: string, params?: unknown[]) => ({
            ...await target.runAsync(sql, params), changes: 0,
          });
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SQLiteAdapter;
      await repo.upsert(fact(), tx);
      await repo.upsert(fact(), tx);
      await repo.upsert(fact({ title: 'Changed' }), tx);
      await expect(repo.upsert(fact({ entity_id: 'entity-A' }), tx))
        .rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
    });
    expect(await db.getFirstAsync('SELECT title FROM llm_wiki_entries WHERE id = ?',
      ['foreign-fact'])).toEqual({ title: 'Changed' });
    expect(await db.getAllAsync('SELECT operation FROM llm_wiki_outbox ORDER BY rowid'))
      .toEqual([{ operation: 'INSERT' }, { operation: 'UPDATE' }, { operation: 'UPDATE' }]);
  });

  // An adapter that drops the write AND reports 0 leaves no stored row. Real
  // SQLite cannot produce this (an unconflicted INSERT always lands), so the
  // throw cannot fire spuriously; it keeps the outbox from describing a row
  // that does not exist.
  it('throws instead of publishing when the write left no stored row', async () => {
    await db.withTransactionAsync(async realTx => {
      const tx = new Proxy(realTx, {
        get(target, key) {
          if (key === 'runAsync') return async (sql: string, params?: unknown[]) =>
            sql.includes('ON CONFLICT(id) DO UPDATE')
              ? { changes: 0, lastInsertRowId: 0 }
              : target.runAsync(sql, params);
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SQLiteAdapter;
      const error = await rejected(() => repo.upsert(fact(), tx));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
      expect(await tx.getAllAsync('SELECT * FROM llm_wiki_outbox')).toEqual([]);
    });
  });
});

describe('graph preflight', () => {
  it.each([null, 123])('does no writes for mixed foreign batch, deleted_at=%s', async deletedAt => {
    await seedForeign(deletedAt);
    await db.withTransactionAsync(tx => wiki.upsertGraph('entity-A', {
      sourceRef: 'a.ts', sourceHash: 'a'.repeat(64),
      nodes: [{ id: 'old-a', type: '', title: 'Old A' }],
      edges: [{ id: 'old-edge', type: 'links', sourceId: 'old-a', targetId: 'missing' }],
    }, tx));
    const seededWiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { enableOutbox: true, ontology: { seedManifests: {
        'entity-A': { mode: 'strict', manifest: {
          node_types: [{ type: 'Function', description: '' }],
          edge_types: [{ type: 'links', source_type: 'Function',
            target_type: 'Function', description: '' }],
        } },
      } } },
    });
    expect(await db.getFirstAsync('SELECT * FROM llm_wiki_entity_manifests WHERE entity_id = ?',
      ['entity-A'])).toBeNull();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.withTransactionAsync(async tx => {
      await tx.runAsync('INSERT INTO llm_wiki_meta(key,value) VALUES (?,?)', ['host-marker', 'kept']);
      const before = await snapshot(tx);
      const error = await rejected(() => seededWiki.upsertGraph('entity-A', {
        ...graph([
          { id: 'new-a', type: 'Function', title: 'New A' },
          { id: 'old-a', type: 'Function', title: 'Update A' },
          { id: 'foreign-fact', type: 'Function', title: 'Attempt' },
        ]),
        edges: [{ type: 'links', sourceId: 'new-a', targetId: 'foreign-fact' }],
      }, tx));
      expect(error).toBeInstanceOf(WikiGraphNodeOwnershipConflict);
      expect(error).not.toHaveProperty('cause');
      expect(Object.keys(error as Error).sort()).toEqual(['code', 'name']);
      const visible = JSON.stringify(error) + String(error);
      for (const privateValue of ['entity-B', 'foreign-fact', 'Private title',
        'Private body', 'private-generator', 'source-marker', 'verification-marker']) {
        expect(visible).not.toContain(privateValue);
      }
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
      expect(await snapshot(tx)).toEqual(before);
    });
    expect(await db.getFirstAsync('SELECT value FROM llm_wiki_meta WHERE key = ?',
      ['host-marker'])).toEqual({ value: 'kept' });
    expect(await db.getFirstAsync('SELECT * FROM llm_wiki_entity_manifests WHERE entity_id = ?',
      ['entity-A'])).toBeNull();
  });

  it('checks foreign ownership after the first 500 distinct IDs', async () => {
    await seedForeign();
    const nodes = Array.from({ length: 501 }, (_, i) => ({
      id: `new-${i}`, type: '', title: `New ${i}`,
    }));
    nodes.push({ id: 'foreign-fact', type: '', title: 'Conflict last' });
    const before = await snapshot();
    await db.withTransactionAsync(async tx => {
      await expect(wiki.upsertGraph('entity-A', graph(nodes), tx))
        .rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves live hash no-op and collision precedence, but deleted refs fall through', async () => {
    await seedForeign();
    await db.withTransactionAsync(tx => wiki.upsertGraph('entity-A', graph([]), tx));
    expect(await db.getFirstAsync(
      'SELECT deleted_at FROM llm_wiki_source_ref_index WHERE entity_id = ? AND source_hash = ?',
      ['entity-A', 'b'.repeat(64)],
    )).toEqual({ deleted_at: null });
    const nodes = [{ id: 'foreign-fact', type: '', title: 'Attempt' }];
    const before = await snapshot();
    await db.withTransactionAsync(async tx => {
      expect(await wiki.upsertGraph('entity-A', graph(nodes), tx))
        .toEqual({ nodesWritten: 0, edgesWritten: 0, superseded: 0 });
      await expect(wiki.upsertGraph('entity-A', { ...graph(nodes), sourceRef: 'other.ts' }, tx))
        .rejects.toBeInstanceOf(WikiSourceRefHashCollision);
    });
    expect(await snapshot()).toEqual(before);
    await db.runAsync('UPDATE llm_wiki_source_ref_index SET deleted_at = 123 WHERE entity_id = ?',
      ['entity-A']);
    const deletedBefore = await snapshot();
    await db.withTransactionAsync(async tx => {
      await expect(wiki.upsertGraph('entity-A', graph(nodes), tx))
        .rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
    });
    expect(await snapshot()).toEqual(deletedBefore);
  });

  it('rejects foreign ownership before strict ontology validation or seed persistence', async () => {
    await seedForeign();
    const strictWiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { ontology: { seedManifests: { 'entity-A': {
        mode: 'strict', manifest: {
          node_types: [{ type: 'Function', description: '' }], edge_types: [],
        },
      } } } },
    });
    expect(await db.getFirstAsync(
      'SELECT * FROM llm_wiki_entity_manifests WHERE entity_id = ?', ['entity-A'],
    )).toBeNull();
    const before = await snapshot();
    await db.withTransactionAsync(async tx => {
      await expect(strictWiki.upsertGraph('entity-A', {
        ...graph([{ id: 'foreign-fact', type: 'Unknown', title: 'Attempt' }]),
        edges: [{ type: 'unknown-edge', sourceId: 'foreign-fact', targetId: 'missing' }],
      }, tx)).rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
    });
    // Catching the rejection above lets the transaction commit: no rollback
    // can hide an incorrectly persisted seed manifest.
    expect(await snapshot()).toEqual(before);
  });

  it('keeps strict ontology validation for ownership-valid data', async () => {
    const strictWiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { ontology: { seedManifests: { 'entity-A': {
        mode: 'strict', manifest: {
          node_types: [{ type: 'Function', description: '' }], edge_types: [],
        },
      } } } },
    });
    await expect(db.withTransactionAsync(tx => strictWiki.upsertGraph('entity-A',
      graph([{ id: 'fresh', type: 'Unknown', title: 'Fresh' }]), tx)))
      .rejects.toBeInstanceOf(WikiStrictOntologyViolation);
  });

  it('preserves duplicate-ID counts, metadata and same-owner resurrection', async () => {
    await db.withTransactionAsync(tx => repo.upsert(fact({
      id: 'same', entity_id: 'entity-A', deleted_at: 123,
    }), tx));
    const eventsBefore = (await snapshot()).outbox.length;
    const result = await db.withTransactionAsync(tx => wiki.upsertGraph('entity-A', graph([
      { id: 'same', type: '', title: 'First' },
      { id: 'same', type: '', title: 'Last' },
      { id: 'fresh', type: '', title: 'Fresh' },
    ]), tx));
    expect(result).toEqual({ nodesWritten: 3, edgesWritten: 0, superseded: 0 });
    expect(await db.getFirstAsync(
      'SELECT title, deleted_at, generated_by, created_at FROM llm_wiki_entries WHERE id = ?', ['same'],
    )).toEqual({ title: 'Last', deleted_at: null, generated_by: 'private-generator', created_at: 100 });
    expect((await snapshot()).outbox).toHaveLength(eventsBefore + 3);
    expect(await db.withTransactionAsync(tx => wiki.upsertGraph('entity-A', {
      sourceRef: 'empty.ts', sourceHash: 'c'.repeat(64), nodes: [], edges: [],
    }, tx))).toEqual({ nodesWritten: 0, edgesWritten: 0, superseded: 0 });
  });

  it('keeps foreign edge-ID failures late and relies on caller rollback', async () => {
    await db.withTransactionAsync(tx => wiki.upsertGraph('entity-B', {
      sourceRef: 'b.ts', sourceHash: 'a'.repeat(64),
      nodes: [{ id: 'b', type: '', title: 'B' }],
      edges: [{ id: 'foreign-edge', type: 'links', sourceId: 'b', targetId: 'missing' }],
    }, tx));
    const before = await snapshot();
    let sawNodeBeforeRollback = false;
    const error = await rejected(() => db.withTransactionAsync(async tx => {
      try {
        await wiki.upsertGraph('entity-A', {
          ...graph([{ id: 'a', type: '', title: 'A' }]),
          edges: [{ id: 'foreign-edge', type: 'links', sourceId: 'a', targetId: 'missing' }],
        }, tx);
      } catch (error) {
        sawNodeBeforeRollback = !!await tx.getFirstAsync(
          'SELECT id FROM llm_wiki_entries WHERE id = ?', ['a']);
        throw error;
      }
    }));
    expect(sawNodeBeforeRollback).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect(await snapshot()).toEqual(before);
  });

  it('propagates a late repository domain error and rolls back earlier graph mutations', async () => {
    const before = await snapshot();
    const failure = new WikiGraphNodeOwnershipConflict();
    const actualRepo = wiki.__testAccess.entryRepo;
    const original = actualRepo.upsert.bind(actualRepo);
    let sawFirstNode = false;
    vi.spyOn(actualRepo, 'upsert').mockImplementation(async (incoming, tx) => {
      if (incoming.id === 'late') {
        sawFirstNode = !!await tx.getFirstAsync(
          'SELECT id FROM llm_wiki_entries WHERE id = ?', ['first']);
        throw failure;
      }
      return original(incoming, tx);
    });
    await expect(db.withTransactionAsync(tx => wiki.upsertGraph('entity-A', graph([
      { id: 'first', type: '', title: 'First' }, { id: 'late', type: '', title: 'Late' },
    ]), tx))).rejects.toBe(failure);
    expect(sawFirstNode).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
