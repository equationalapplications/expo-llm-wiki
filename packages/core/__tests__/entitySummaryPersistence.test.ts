import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { MetadataRepository, entitySummaryMetaKey } from '../src/repositories/MetadataRepository';
import type { MemoryDump, SQLiteAdapter } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

function dumpWith(entityId: string, summary?: string): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: [],
        tasks: [],
        events: [],
        edges: [],
        ...(summary !== undefined ? { summary } : {}),
      },
    },
  };
}

const testWikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

describe('entity summary persistence', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    wiki = new WikiMemory(db, testWikiOptions);
    await wiki.setup();
  });

  describe('MetadataRepository.deleteMeta', () => {
    it('deletes a key set via setMeta', async () => {
      const repo = new MetadataRepository(db, 'llm_wiki_');
      await repo.setMeta('some_key', 'some_value', db);
      await repo.deleteMeta('some_key', db);
      expect(await repo.getMeta('some_key')).toBeNull();
    });

    it('is a no-op for a missing key', async () => {
      const repo = new MetadataRepository(db, 'llm_wiki_');
      await expect(repo.deleteMeta('never_set', db)).resolves.toBeUndefined();
    });
  });

  describe('entitySummaryMetaKey', () => {
    it('builds the key from the raw entity id, appearing exactly once', () => {
      expect(entitySummaryMetaKey('char_42')).toBe('entity_summary:char_42');
    });
  });

  describe('importDump summary semantics', () => {
    it('persists an imported summary (merge mode)', async () => {
      await wiki.importDump(dumpWith('e1', 'Summary prose.'), { merge: true });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBe('Summary prose.');
    });

    it('merge with absent summary preserves the existing one', async () => {
      await wiki.importDump(dumpWith('e1', 'Original.'), { merge: true });
      await wiki.importDump(dumpWith('e1'), { merge: true });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBe('Original.');
    });

    it('merge with a different summary overwrites (incoming wins)', async () => {
      await wiki.importDump(dumpWith('e1', 'Old.'), { merge: true });
      await wiki.importDump(dumpWith('e1', 'New.'), { merge: true });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBe('New.');
    });

    it('replace with absent summary clears the key', async () => {
      await wiki.importDump(dumpWith('e1', 'Doomed.'), { merge: true });
      await wiki.importDump(dumpWith('e1'), { merge: false });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBeNull();
    });

    it('scopes summaries per entity: e2 import does not touch e1', async () => {
      await wiki.importDump(dumpWith('e1', 'Entity one.'), { merge: true });
      await wiki.importDump(dumpWith('e2', 'Entity two.'), { merge: false });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBe('Entity one.');
      expect(await repo.getMeta(entitySummaryMetaKey('e2'))).toBe('Entity two.');
    });
  });

  describe('exportDump summary round-trip', () => {
    it('returns the persisted summary on export', async () => {
      await wiki.importDump(dumpWith('e1', 'Round-trip me.'), { merge: true });
      const dump = await wiki.exportDump(['e1']);
      expect(dump.entities.e1.summary).toBe('Round-trip me.');
    });

    it('omits summary when none is stored', async () => {
      await wiki.importDump(dumpWith('e1'), { merge: true });
      const dump = await wiki.exportDump(['e1']);
      expect(dump.entities.e1.summary).toBeUndefined();
    });
  });

  describe('forget(clearAll) cleanup', () => {
    it('removes the summary key with the entity wipe', async () => {
      await wiki.importDump(dumpWith('e1', 'Wipe me.'), { merge: true });
      await wiki.forget('e1', { clearAll: true });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e1'))).toBeNull();
    });

    it("does not touch another entity's summary (scoping regression)", async () => {
      await wiki.importDump(dumpWith('e1', 'One.'), { merge: true });
      await wiki.importDump(dumpWith('e2', 'Two.'), { merge: true });
      await wiki.forget('e1', { clearAll: true });
      const repo = new MetadataRepository(db, 'llm_wiki_');
      expect(await repo.getMeta(entitySummaryMetaKey('e2'))).toBe('Two.');
    });
  });

  describe('getEntitySummary', () => {
    it('returns null before any import', async () => {
      expect(await wiki.getEntitySummary('e1')).toBeNull();
    });

    it('returns the stored value after import', async () => {
      await wiki.importDump(dumpWith('e1', 'Readable.'), { merge: true });
      expect(await wiki.getEntitySummary('e1')).toBe('Readable.');
    });

    it('returns null after replace-clear', async () => {
      await wiki.importDump(dumpWith('e1', 'Gone soon.'), { merge: true });
      await wiki.importDump(dumpWith('e1'), { merge: false });
      expect(await wiki.getEntitySummary('e1')).toBeNull();
    });
  });
});
