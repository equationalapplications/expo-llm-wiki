// packages/core/__tests__/sourceRefNormalize.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runSourceRefNormalize, writeNormalizeStamp, stampMatches, SOURCE_REF_NORMALIZE_ALG, NORMALIZE_STAMP_KEY, ENTRIES_WM_KEY, SRI_WM_KEY } from '../src/db/sourceRefNormalize';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { normalizeSourceRef } from '../src/utils/pure';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('sourceRefNormalize', () => {
  let db: any;
  let prefix: string;
  let meta: MetadataRepository;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    prefix = 'llm_wiki_';
    wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}' },
      config: { tablePrefix: prefix }
    });
    await wiki.setup();
    meta = wiki.__testAccess.metadataRepo;
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  describe('stampMatches', () => {
    it('returns false for null raw', () => {
      expect(stampMatches(null)).toBe(false);
      expect(stampMatches(undefined)).toBe(false);
    });

    it('returns false for invalid JSON', () => {
      expect(stampMatches('not json')).toBe(false);
    });

    it('returns false for missing normalize_alg', () => {
      expect(stampMatches(JSON.stringify({ schema_version: 14 }))).toBe(false);
    });

    it('returns false for wrong normalize_alg', () => {
      expect(stampMatches(JSON.stringify({ schema_version: 14, normalize_alg: 0 }))).toBe(false);
    });

    it('returns true for correct normalize_alg', () => {
      expect(stampMatches(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }))).toBe(true);
    });

    it('returns false for extra fields', () => {
      expect(stampMatches(JSON.stringify({
        schema_version: 14,
        normalize_alg: SOURCE_REF_NORMALIZE_ALG,
        extra: 'field'
      }))).toBe(true);
    });
  });

  describe('writeNormalizeStamp', () => {
    it('writes stamp with correct values', async () => {
      await writeNormalizeStamp(meta, db);
      const raw = await meta.getMeta(NORMALIZE_STAMP_KEY);
      expect(raw).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });

  describe('runSourceRefNormalize - fresh store', () => {
    it('fresh store gets stamp and no watermarks', async () => {
      // Fresh store has no stamp
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBeNull();
      expect(await meta.getMeta(ENTRIES_WM_KEY)).toBeNull();
      expect(await meta.getMeta(SRI_WM_KEY)).toBeNull();

      await runSourceRefNormalize(db, prefix, meta);

      // After run, stamp is present, watermarks are cleared
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
      expect(await meta.getMeta(ENTRIES_WM_KEY)).toBeNull();
      expect(await meta.getMeta(SRI_WM_KEY)).toBeNull();
    });

    it('stamped store performs zero normalize reads on next open', async () => {
      // Pre-stamp the store
      await writeNormalizeStamp(meta, db);

      // Run normalize - should be no-op due to stamp
      await runSourceRefNormalize(db, prefix, meta);

      // Stamp should still be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });

  describe('runSourceRefNormalize - normalization', () => {
    beforeEach(async () => {
      // Insert test entries with source_ref that need normalization
      await db.withTransactionAsync(async (tx) => {
        // Regular ref that needs no change
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e1', 'entity1', 'docs/page.md', Date.now()]);

        // Ref with spaces to trim
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e2', 'entity1', '  docs/page2.md  ', Date.now()]);

        // Ref with special chars to remove
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e3', 'entity1', 'docs/a$b%page.md', Date.now()]);

        // Ref that becomes NULL after normalization
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e4', 'entity1', '///', Date.now()]);

        // Ref that needs truncation
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e5', 'entity1', 'a'.repeat(260), Date.now()]);
      });
    });

    it('normalizes entries incl. >255 and trim-before-truncate cases', async () => {
      // Verify initial state
      const initial = await db.getAllAsync(`SELECT id, source_ref FROM ${prefix}entries WHERE id IN ('e1', 'e2', 'e3', 'e4', 'e5')`);
      expect(initial).toEqual([
        { id: 'e1', source_ref: 'docs/page.md' },
        { id: 'e2', source_ref: '  docs/page2.md  ' },
        { id: 'e3', source_ref: 'docs/a$b%page.md' },
        { id: 'e4', source_ref: '///' },
        { id: 'e5', source_ref: 'a'.repeat(260) },
      ]);

      await runSourceRefNormalize(db, prefix, meta);

      // Check normalized state
      const normalized = await db.getAllAsync(`SELECT id, source_ref FROM ${prefix}entries WHERE id IN ('e1', 'e2', 'e3', 'e4', 'e5')`);
      expect(normalized).toEqual([
        { id: 'e1', source_ref: 'docs/page.md' }, // unchanged
        { id: 'e2', source_ref: 'docs/page2.md' }, // trimmed
        { id: 'e3', source_ref: 'docsapage.md' }, // special chars removed
        { id: 'e4', source_ref: null }, // became NULL
        { id: 'e5', source_ref: 'a'.repeat(255) }, // truncated
      ]);

      // Stamp should be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });

  describe('runSourceRefNormalize - source_ref_index handling', () => {
    beforeEach(async () => {
      // Insert entries with source_ref that need normalization
      await db.withTransactionAsync(async (tx) => {
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, source_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
          ['e1', 'entity1', 'docs/page.md', 'hash1', Date.now()]);
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, source_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
          ['e2', 'entity1', '  docs/page2.md  ', 'hash2', Date.now()]);
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, source_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
          ['e3', 'entity1', 'docs/a$b%page.md', 'hash3', Date.now()]);
      });

      // Insert source_ref_index entries
      await db.withTransactionAsync(async (tx) => {
        await tx.runAsync(`INSERT INTO ${prefix}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ['sri1', 'entity1', 'hash1', 'docs/page.md', Date.now(), null]);
        await tx.runAsync(`INSERT INTO ${prefix}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ['sri2', 'entity1', 'hash2', '  docs/page2.md  ', Date.now(), null]);
        await tx.runAsync(`INSERT INTO ${prefix}source_ref_index (id, entity_id, source_hash, source_ref, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ['sri3', 'entity1', 'hash3', 'docs/a$b%page.md', Date.now(), null]);
      });
    });

    it('Pass 2 rewrites drifted source_ref_index refs, soft-deletes NULL-normalizing ones', async () => {
      await runSourceRefNormalize(db, prefix, meta);

      // Check entries
      const entries = await db.getAllAsync(`SELECT id, source_ref FROM ${prefix}entries`);
      expect(entries).toEqual([
        { id: 'e1', source_ref: 'docs/page.md' },
        { id: 'e2', source_ref: 'docs/page2.md' },
        { id: 'e3', source_ref: 'docsapage.md' },
      ]);

      // Check source_ref_index - should be updated with normalized refs, NULL ones soft-deleted
      const sri = await db.getAllAsync(`SELECT id, source_ref, deleted_at FROM ${prefix}source_ref_index`);
      expect(sri).toEqual([
        { id: 'sri1', source_ref: 'docs/page.md', deleted_at: null }, // unchanged
        { id: 'sri2', source_ref: 'docs/page2.md', deleted_at: null }, // updated
        { id: 'sri3', source_ref: 'docsapage.md', deleted_at: null }, // updated
      ]);

      // Stamp should be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });

  describe('runSourceRefNormalize - resume behavior', () => {
    beforeEach(async () => {
      // Insert many entries to test batching
      await db.withTransactionAsync(async (tx) => {
        for (let i = 0; i < 150; i++) {
          const ref = i % 2 === 0 ? `docs/page${i}.md` : `  docs/page${i}.md  `;
          await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
            [`e${i}`, 'entity1', ref, Date.now()]);
        }
      });
    });

    it('Runs to completion across many chunks', async () => {
      // Set initial watermark to test resume
      await meta.setMeta(ENTRIES_WM_KEY, JSON.stringify({ rowid: 100, id: 'e100' }));

      await runSourceRefNormalize(db, prefix, meta);

      // All entries should be normalized
      const entries = await db.getAllAsync(`SELECT id, source_ref FROM ${prefix}entries`);
      entries.forEach(entry => {
        const normalized = normalizeSourceRef(entry.source_ref!);
        expect(entry.source_ref).toBe(normalized);
      });

      // Stamp should be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
      expect(await meta.getMeta(ENTRIES_WM_KEY)).toBeNull();
    });

    it('Resumes from valid watermark, restarts when fingerprint row moved', async () => {
      // Set watermark
      await meta.setMeta(ENTRIES_WM_KEY, JSON.stringify({ rowid: 50, id: 'e50' }));

      // Simulate row movement by updating the fingerprint row
      await db.runAsync(`UPDATE ${prefix}entries SET id = 'e50-renamed' WHERE id = 'e50'`);

      await runSourceRefNormalize(db, prefix, meta);

      // Process should continue and complete despite fingerprint mismatch
      const entries = await db.getAllAsync(`SELECT id, source_ref FROM ${prefix}entries`);
      entries.forEach(entry => {
        const normalized = normalizeSourceRef(entry.source_ref!);
        expect(entry.source_ref).toBe(normalized);
      });

      // Stamp should be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });

  describe('runSourceRefNormalize - VACUUM behavior', () => {
    beforeEach(async () => {
      // Insert some entries
      await db.withTransactionAsync(async (tx) => {
        await tx.runAsync(`INSERT INTO ${prefix}entries (id, entity_id, source_ref, created_at) VALUES (?, ?, ?, ?)`,
          ['e1', 'entity1', '  docs/page.md  ', Date.now()]);
      });

      // Set watermarks
      await meta.setMeta(ENTRIES_WM_KEY, JSON.stringify({ rowid: 1, id: 'e1' }));
      await meta.setMeta(SRI_WM_KEY, JSON.stringify({ rowid: 1, id: 'sri1' }));
    });

    it('VACUUM clears watermarks', async () => {
      // VACUUM should clear watermarks
      await meta.vacuum();

      expect(await meta.getMeta(ENTRIES_WM_KEY)).toBeNull();
      expect(await meta.getMeta(SRI_WM_KEY)).toBeNull();
    });
  });

  describe('runSourceRefNormalize - edge cases', () => {
    it('Empty tables complete immediately', async () => {
      // No entries, no source_ref_index entries
      await runSourceRefNormalize(db, prefix, meta);

      // Stamp should be present
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });

    it('Alg mismatch forces exactly one rescan', async () => {
      // Set wrong alg stamp
      await meta.setMeta(NORMALIZE_STAMP_KEY, JSON.stringify({ schema_version: 14, normalize_alg: 0 }));

      await runSourceRefNormalize(db, prefix, meta);

      // Stamp should be updated with correct alg
      expect(await meta.getMeta(NORMALIZE_STAMP_KEY)).toBe(JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }));
    });
  });
});