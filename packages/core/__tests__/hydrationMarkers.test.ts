import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import type { SQLiteAdapter } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

/**
 * Spec §2.7 + §5.3 promise that facts/tasks returned via `read()` carry
 * hydrated `isStale: boolean` and `trustTier: 'unverified' | 'machine-confirmed' | 'human-reviewed'`.
 * Hosts should not have to re-call `isStaleAfter` / `deriveTrustTier` themselves.
 *
 * These tests insert rows directly so the matrix under test (stale_after: past /
 * future / null; okf_verified: empty / machine / human) can be controlled
 * precisely, then asserts that `wiki.read()` hydrates both fields correctly
 * for facts and tasks.
 */
describe('read() hydrates isStale + trustTier (spec §2.7, §5.3)', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
  });

  // ---------- facts ----------

  describe('facts.isStale', () => {
    it('stale_after in the past → isStale: true', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, stale_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['f-stale', 'e1', 'past-stale fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000, 0],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].isStale).toBe(true);
    });

    it('stale_after in the future → isStale: false', async () => {
      const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, stale_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['f-fresh', 'e1', 'future fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000, future],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].isStale).toBe(false);
    });

    it('stale_after NULL → isStale: false (never stale per spec)', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, stale_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ['f-null', 'e1', 'no-stale fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].isStale).toBe(false);
    });
  });

  describe('facts.trustTier', () => {
    it('okf_verified NULL → trustTier: "unverified"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ['f-unverified', 'e1', 'no-verified fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].trustTier).toBe('unverified');
    });

    it('okf_verified empty array → trustTier: "unverified"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['f-empty-verified', 'e1', 'empty-verified fact', 'body', '[]', 'certain', 'user_stated', 1000, 1000, '[]'],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].trustTier).toBe('unverified');
    });

    it('okf_verified with process: actor → trustTier: "machine-confirmed"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'f-machine',
          'e1',
          'machine-confirmed fact',
          'body',
          '[]',
          'certain',
          'user_stated',
          1000,
          1000,
          JSON.stringify([{ by: 'process:cron', at: '2026-01-01T00:00:00Z' }]),
        ],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].trustTier).toBe('machine-confirmed');
    });

    it('okf_verified with human: actor → trustTier: "human-reviewed"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'f-human',
          'e1',
          'human-reviewed fact',
          'body',
          '[]',
          'certain',
          'user_stated',
          1000,
          1000,
          JSON.stringify([{ by: 'human:alice', at: '2026-01-01T00:00:00Z' }]),
        ],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].trustTier).toBe('human-reviewed');
    });

    it('mixed verifiers (machine + human) → trustTier: "human-reviewed" (any human wins)', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries
           (id, entity_id, title, body, tags, confidence, source_type,
            created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'f-mixed',
          'e1',
          'mixed-verified fact',
          'body',
          '[]',
          'certain',
          'user_stated',
          1000,
          1000,
          JSON.stringify([
            { by: 'process:cron', at: '2026-01-01T00:00:00Z' },
            { by: 'human:bob', at: '2026-02-01T00:00:00Z' },
          ]),
        ],
      );

      const result = await wiki.read('e1', '');
      expect(result.facts[0].trustTier).toBe('human-reviewed');
    });
  });

  // ---------- tasks ----------

  describe('tasks.isStale', () => {
    it('stale_after in the past → isStale: true', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_tasks
           (id, entity_id, description, status, priority, created_at, updated_at, stale_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['t-stale', 'e1', 'past-stale task', 'pending', 0, 1000, 1000, 0],
      );

      const result = await wiki.read('e1', '');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].isStale).toBe(true);
    });

    it('stale_after NULL → isStale: false', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_tasks
           (id, entity_id, description, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['t-null', 'e1', 'no-stale task', 'pending', 0, 1000, 1000],
      );

      const result = await wiki.read('e1', '');
      expect(result.tasks[0].isStale).toBe(false);
    });
  });

  describe('tasks.trustTier', () => {
    it('okf_verified NULL → trustTier: "unverified"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_tasks
           (id, entity_id, description, status, priority, created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        ['t-unverified', 'e1', 'no-verified task', 'pending', 0, 1000, 1000],
      );

      const result = await wiki.read('e1', '');
      expect(result.tasks[0].trustTier).toBe('unverified');
    });

    it('okf_verified with human: actor → trustTier: "human-reviewed"', async () => {
      await db.runAsync(
        `INSERT INTO llm_wiki_tasks
           (id, entity_id, description, status, priority, created_at, updated_at, okf_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          't-human',
          'e1',
          'human-verified task',
          'pending',
          0,
          1000,
          1000,
          JSON.stringify([{ by: 'human:alice', at: '2026-01-01T00:00:00Z' }]),
        ],
      );

      const result = await wiki.read('e1', '');
      expect(result.tasks[0].trustTier).toBe('human-reviewed');
    });
  });

  // ---------- matrix: both fields populated on every read ----------

  it('every fact and task returned by read() carries non-undefined isStale and trustTier', async () => {
    await db.runAsync(
      `INSERT INTO llm_wiki_entries
         (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['f-x', 'e1', 'x', 'body', '[]', 'certain', 'user_stated', 1000, 1000],
    );
    await db.runAsync(
      `INSERT INTO llm_wiki_tasks
         (id, entity_id, description, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['t-x', 'e1', 'x', 'pending', 0, 1000, 1000],
    );

    const result = await wiki.read('e1', '');
    for (const f of result.facts) {
      expect(f.isStale).toBe(false);
      expect(f.trustTier).toBe('unverified');
    }
    for (const t of result.tasks) {
      expect(t.isStale).toBe(false);
      expect(t.trustTier).toBe('unverified');
    }
  });
});
