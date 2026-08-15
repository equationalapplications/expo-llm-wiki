import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

const stubOptions = { llmProvider: { generateText: async () => '{}' } } as const;

async function makeWiki(): Promise<{ wiki: WikiMemory; db: SQLiteAdapter }> {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, stubOptions);
  await wiki.setup();
  return { wiki, db };
}

async function insertProbeFact(db: SQLiteAdapter, updatedAt: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at) VALUES ('probe', 'e1', 'T', 'B', 'certain', 'user_stated', ?, ?)`,
    [updatedAt, updatedAt],
  );
}

describe('OkfTrustWritesRepository', () => {
  it('writeOkfTrust does not change updated_at', async () => {
    const { wiki, db } = await makeWiki();
    const t = 1_700_000_000_000;
    await insertProbeFact(db, t);
    await wiki.writeOkfTrust('probe', 'e1', [{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }]);
    const row = await db.getFirstAsync<{ updated_at: number; okf_verified: string; last_verified_by: string }>(
      `SELECT updated_at, okf_verified, last_verified_by FROM llm_wiki_entries WHERE id = 'probe'`,
    );
    expect(Number(row?.updated_at)).toBe(t);
    expect(JSON.parse(row?.okf_verified ?? '[]')).toEqual([{ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' }]);
    expect(row?.last_verified_by).toBe('human:ahormati');
  });

  it('setLifecycleStatus does not change updated_at', async () => {
    const { wiki, db } = await makeWiki();
    const t = 1_700_000_000_000;
    await insertProbeFact(db, t);
    await wiki.setLifecycleStatus('probe', 'e1', 'deprecated');
    const probe = await db.getFirstAsync<{ updated_at: number; lifecycle_status: string }>(
      `SELECT updated_at, lifecycle_status FROM llm_wiki_entries WHERE id = 'probe'`,
    );
    expect(Number(probe?.updated_at)).toBe(t);
    expect(probe?.lifecycle_status).toBe('deprecated');
  });

  it('setStaleAfter(null) clears the column without touching updated_at', async () => {
    const { wiki, db } = await makeWiki();
    const t = 1_700_000_000_000;
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at, stale_after) VALUES ('probe2', 'e1', 'T', 'B', 'certain', 'user_stated', ?, ?, 12345)`,
      [t, t],
    );
    await wiki.setStaleAfter('probe2', 'e1', null);
    const row = await db.getFirstAsync<{ updated_at: number; stale_after: number | null }>(
      `SELECT updated_at, stale_after FROM llm_wiki_entries WHERE id = 'probe2'`,
    );
    expect(Number(row?.updated_at)).toBe(t);
    expect(row?.stale_after).toBeNull();
  });

  it('writeOkfSources does not change updated_at', async () => {
    const { wiki, db } = await makeWiki();
    const t = 1_700_000_000_000;
    await insertProbeFact(db, t);
    await wiki.writeOkfSources('probe', 'e1', [{ resource: 'https://example.com', id: 'a' }]);
    const row = await db.getFirstAsync<{ updated_at: number; okf_sources: string }>(
      `SELECT updated_at, okf_sources FROM llm_wiki_entries WHERE id = 'probe'`,
    );
    expect(Number(row?.updated_at)).toBe(t);
    expect(JSON.parse(row?.okf_sources ?? '[]')).toEqual([{ resource: 'https://example.com', id: 'a' }]);
  });

  it('setGeneratedBy does not change updated_at', async () => {
    const { wiki, db } = await makeWiki();
    const t = 1_700_000_000_000;
    await insertProbeFact(db, t);
    await wiki.setGeneratedBy('probe', 'e1', 'process:cron-nightly');
    const row = await db.getFirstAsync<{ updated_at: number; generated_by: string }>(
      `SELECT updated_at, generated_by FROM llm_wiki_entries WHERE id = 'probe'`,
    );
    expect(Number(row?.updated_at)).toBe(t);
    expect(row?.generated_by).toBe('process:cron-nightly');
  });
});
