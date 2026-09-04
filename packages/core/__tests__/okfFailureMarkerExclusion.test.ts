import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter, WikiFact } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;
const PREFIX = 'llm_wiki_';

async function makeWikiWithFact(factId: string): Promise<{ wiki: WikiMemory; db: SQLiteAdapter; repo: any }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  await wiki.importDump({
    generatedAt: 1_700_000_000_000,
    entities: {
      e1: {
        facts: [{
          id: factId,
          entity_id: 'e1',
          title: 'T',
          body: 'B',
          tags: [],
          confidence: 'certain',
          source_type: 'user_stated',
          source_hash: null,
          source_ref: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
          okf_type: 'fact',
        }],
        tasks: [],
        events: [],
        edges: [],
        summary: '',
      },
    },
  });
  return { wiki, db, repo: (wiki as any).entryRepo };
}

describe('OKF D2: embedding failure markers stay host-local', () => {
  it('exportDump bundle facts do NOT carry embedding failure marker fields', async () => {
    const { wiki, repo } = await makeWikiWithFact('f1');
    await repo.markEmbeddingFailure('f1', 'provider_error', 1000);
    const dump = await wiki.exportDump();
    const exported = dump.entities['e1']?.facts.find((f: WikiFact) => f.id === 'f1');
    expect(exported).toBeDefined();
    expect('embedding_failed_at' in (exported as any)).toBe(false);
    expect('embedding_failure_kind' in (exported as any)).toBe(false);
    expect('embedding_attempts' in (exported as any)).toBe(false);
  });

  it('importing a bundle with stray marker fields leaves the imported row at defaults', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, stubOptions);
    await wiki.setup();
    // Construct a bundle whose fact JSON carries every marker field — a
    // stray/legacy bundle or one produced by an older buggy exporter.
    await wiki.importDump({
      generatedAt: 1_700_000_000_000,
      entities: {
        e1: {
          facts: [{
            id: 'f1',
            entity_id: 'e1',
            title: 'T',
            body: 'B',
            tags: [],
            confidence: 'certain',
            source_type: 'user_stated',
            source_hash: null,
            source_ref: null,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            last_accessed_at: null,
            access_count: 0,
            deleted_at: null,
            okf_type: 'fact',
            // Stray fields — a buggy exporter or attacker shouldn't be able to
            // smuggle host-local embedding state across the bundle boundary.
            embedding_failed_at: 9999,
            embedding_failure_kind: 'provider_error',
            embedding_attempts: 7,
          } as any],
          tasks: [],
          events: [],
          edges: [],
          summary: '',
        },
      },
    });
    const row = await db.getFirstAsync<{
      embedding_failed_at: number | null;
      embedding_failure_kind: string | null;
      embedding_attempts: number;
    }>(
      `SELECT embedding_failed_at, embedding_failure_kind, embedding_attempts FROM ${PREFIX}entries WHERE id = 'f1'`,
    );
    expect(row?.embedding_failed_at).toBeNull();
    expect(row?.embedding_failure_kind).toBeNull();
    expect(row?.embedding_attempts).toBe(0);
  });
});