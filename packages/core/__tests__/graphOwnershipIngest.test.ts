import { describe, expect, it, vi } from 'vitest';
import { WikiMemory, WikiGraphNodeOwnershipConflict } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import * as ids from '../src/utils/ids';

describe('ingestion ownership propagation', () => {
  it.each([false, true])('preserves error identity and rolls back, partial=%s', async partial => {
    const db = openTestDatabase();
    let calls = 0;
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => {
        const call = calls++;
        if (partial && call === 1) return '{"facts":[';
        return JSON.stringify({ facts: [{ title: `Unique ${call}`, body: 'Attempted content',
          tags: [], confidence: 'certain' }] });
      } },
      config: { enableOutbox: true },
    });
    try {
      await wiki.setup();
      await db.withTransactionAsync(tx => wiki.upsertGraph('entity-B', {
        sourceRef: 'b.ts', sourceHash: 'a'.repeat(64),
        nodes: [{ id: 'foreign-fact', type: '', title: 'Original B' }], edges: [],
      }, tx));
      const snapshot = async () => {
        const rows: Record<string, unknown[]> = {};
        for (const table of ['entries', 'edges', 'source_ref_index', 'entity_manifests',
          'checkpoints', 'meta', 'outbox']) {
          rows[table] = await db.getAllAsync(`SELECT * FROM llm_wiki_${table} ORDER BY rowid`);
        }
        return rows;
      };
      const before = await snapshot();
      // Call-routing pins (spec test 16): the partial path (failedChunks > 0)
      // branches to appendPartialFacts, which calls entryRepo.upsert directly
      // and never reaches upsertGraphCore, so only the repository guard can
      // reject it. The full path runs upsertGraphCore, whose preflight throws
      // before any row write, so the repository write is never reached there.
      const upsertSpy = vi.spyOn(wiki.__testAccess.entryRepo, 'upsert');
      const preflightSpy = vi.spyOn(wiki.__testAccess.ingestionService, 'upsertGraphCore');
      const originalId = ids.generateId;
      vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') =>
        prefix === 'fact_' ? 'foreign-fact' : originalId(prefix));
      const operation = wiki.ingestDocument('entity-A', {
        sourceRef: 'new-doc', sourceHash: 'b'.repeat(64),
        documentChunk: partial
          ? 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.'
          : 'One successful extraction.',
        maxChunkLength: partial ? 50 : 1000, chunkOverlap: 0, chunkConcurrency: 1,
      });
      await expect(operation).rejects.toBeInstanceOf(WikiGraphNodeOwnershipConflict);
      if (partial) {
        expect(calls).toBeGreaterThan(1);
        expect(preflightSpy).not.toHaveBeenCalled();
        expect(upsertSpy).toHaveBeenCalled();
      } else {
        expect(calls).toBe(1);
        expect(preflightSpy).toHaveBeenCalledTimes(1);
        expect(upsertSpy).not.toHaveBeenCalled();
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await db.closeAsync();
    }
  });
});
