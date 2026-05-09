import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;
const ENTITY = 'boundary-entity';

function baseOptions(
  orphanAfterDays: number | null,
  staleInferredAfterDays: number | null,
): WikiOptions {
  return {
    llmProvider: { generateText: async () => '{}' },
    config: {
      orphanAfterDays,
      staleInferredAfterDays,
    },
  };
}

async function insertEntry(
  db: ReturnType<typeof openTestDatabase>,
  id: string,
  opts: {
    created_at: number;
    updated_at?: number;
    confidence?: string;
    source_type?: string;
    access_count?: number;
    last_accessed_at?: number | null;
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (
      id, entity_id, title, body, tags, confidence, source_type,
      created_at, updated_at, last_accessed_at, access_count, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      ENTITY,
      `t-${id}`,
      'body',
      '[]',
      opts.confidence ?? 'inferred',
      opts.source_type ?? 'librarian_inferred',
      opts.created_at,
      opts.updated_at ?? opts.created_at,
      opts.last_accessed_at ?? null,
      opts.access_count ?? 0,
    ],
  );
}

describe('WikiMemory.runHeal inclusive retention (<= thresholds)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('soft-deletes orphaned facts when created_at equals orphan threshold exactly', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const orphanDays = 11;
    const orphanThreshold = FIXED_NOW - orphanDays * MS_PER_DAY;

    const db = openTestDatabase();
    const wiki = new WikiMemory(db, baseOptions(orphanDays, null));
    await wiki.setup();

    await insertEntry(db, 'orph-eq', {
      created_at: orphanThreshold,
      confidence: 'certain',
      source_type: 'user_stated',
      access_count: 0,
    });
    await insertEntry(db, 'orph-new', {
      created_at: orphanThreshold + 1,
      confidence: 'certain',
      source_type: 'user_stated',
      access_count: 0,
    });

    await wiki.runHeal(ENTITY);

    const atEdge = await db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM llm_wiki_entries WHERE id = ?`,
      ['orph-eq'],
    );
    const newer = await db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM llm_wiki_entries WHERE id = ?`,
      ['orph-new'],
    );

    expect(atEdge?.deleted_at).not.toBeNull();
    expect(newer?.deleted_at).toBeNull();
  });

  it('downgrades stale inferred facts when last_accessed_at equals stale threshold exactly', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const staleDays = 17;
    const staleThreshold = FIXED_NOW - staleDays * MS_PER_DAY;

    const db = openTestDatabase();
    const wiki = new WikiMemory(db, baseOptions(null, staleDays));
    await wiki.setup();

    await insertEntry(db, 'stale-la-at', {
      created_at: staleThreshold - MS_PER_DAY,
      confidence: 'inferred',
      source_type: 'librarian_inferred',
      last_accessed_at: staleThreshold,
    });
    await insertEntry(db, 'stale-la-new', {
      created_at: staleThreshold - MS_PER_DAY,
      confidence: 'inferred',
      source_type: 'librarian_inferred',
      last_accessed_at: staleThreshold + 1,
    });

    await wiki.runHeal(ENTITY);

    const atEdge = await db.getFirstAsync<{ confidence: string }>(
      `SELECT confidence FROM llm_wiki_entries WHERE id = ?`,
      ['stale-la-at'],
    );
    const newer = await db.getFirstAsync<{ confidence: string }>(
      `SELECT confidence FROM llm_wiki_entries WHERE id = ?`,
      ['stale-la-new'],
    );

    expect(atEdge?.confidence).toBe('tentative');
    expect(newer?.confidence).toBe('inferred');
  });

  it('downgrades when last_accessed_at IS NULL and created_at equals stale threshold exactly', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    const staleDays = 23;
    const staleThreshold = FIXED_NOW - staleDays * MS_PER_DAY;

    const db = openTestDatabase();
    const wiki = new WikiMemory(db, baseOptions(null, staleDays));
    await wiki.setup();

    await insertEntry(db, 'stale-created-at', {
      created_at: staleThreshold,
      confidence: 'inferred',
      source_type: 'user_stated',
      last_accessed_at: null,
    });
    await insertEntry(db, 'stale-created-new', {
      created_at: staleThreshold + 1,
      confidence: 'inferred',
      source_type: 'user_stated',
      last_accessed_at: null,
    });

    await wiki.runHeal(ENTITY);

    const atEdge = await db.getFirstAsync<{ confidence: string }>(
      `SELECT confidence FROM llm_wiki_entries WHERE id = ?`,
      ['stale-created-at'],
    );
    const newer = await db.getFirstAsync<{ confidence: string }>(
      `SELECT confidence FROM llm_wiki_entries WHERE id = ?`,
      ['stale-created-new'],
    );

    expect(atEdge?.confidence).toBe('tentative');
    expect(newer?.confidence).toBe('inferred');
  });
});
