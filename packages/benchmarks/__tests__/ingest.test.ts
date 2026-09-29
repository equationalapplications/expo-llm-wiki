import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { flagsKey, ingestQuestion } from '../src/longmemeval/ingest';
import type { LmeQuestion } from '../src/longmemeval/dataset';

function makeSyntheticQuestion(): LmeQuestion {
  // 2 sessions × 3 turns = 6 events total.
  return {
    question_id: 'synthetic__t4__001',
    question_type: 'single-session-user',
    question: 'What colour did the user pick?',
    answer: 'blue',
    question_date: '2023/05/20 (Sat) 02:21',
    haystack_dates: [
      '2023/05/18 (Thu) 10:00',
      '2023/05/19 (Fri) 11:00',
    ],
    haystack_sessions: [
      [
        { role: 'user', content: 'I am thinking of a colour.' },
        { role: 'assistant', content: 'Tell me more.' },
        { role: 'user', content: 'It is blue.' },
      ],
      [
        { role: 'user', content: 'Confirmed blue is my favourite.' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'Thanks.' },
      ],
    ],
  };
}

function countEvents(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM llm_wiki_events WHERE entity_id = 'lme-user'")
      .get() as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function countFacts(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM llm_wiki_entries WHERE entity_id = 'lme-user' AND deleted_at IS NULL")
      .get() as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function readMeta(dbFile: string, key: string): string | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare('SELECT value FROM llm_wiki_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

function makeFakeProvider(callTracker: { calls: number }): { generateText: (p: { systemPrompt: string; userPrompt: string }) => Promise<string> } {
  return {
    async generateText({ systemPrompt }) {
      callTracker.calls += 1;
      // One fact per librarian call. Other call sites (ingest, heal, …) get `{}`
      // so the parser stays quiet.
      if (systemPrompt.includes('knowledge extraction agent')) {
        return JSON.stringify({
          facts: [
            { title: 'User favourite colour', body: 'The user favourite colour is blue.' },
          ],
          tasks: [],
        });
      }
      return '{}';
    },
  };
}

describe('flagsKey', () => {
  it('encodes strategy+maintenance and appends the read token budget when present', () => {
    expect(flagsKey({ strategy: 'legacy', maintenance: 'auto' })).toBe('legacy-auto');
    expect(flagsKey({ strategy: 'ops', maintenance: 'deferred' })).toBe('ops-deferred');
    expect(flagsKey({ strategy: 'ops', maintenance: 'deferred', readTokenBudget: 800 })).toBe('ops-deferred-b800');
    expect(flagsKey({ strategy: 'legacy', maintenance: 'auto', readTokenBudget: 0 })).toBe('legacy-auto');
  });
});

describe('ingestQuestion (legacy-auto)', () => {
  it('replays a 2-session question, runs maintenance to quiescence, caches, and reuses the cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lme-ingest-'));
    const q = makeSyntheticQuestion();
    const callTracker = { calls: 0 };
    const provider = makeFakeProvider(callTracker);
    const embed: (t: string) => Promise<number[]> = async (t) => [t.length % 7, 1];

    try {
      // First call: builds the cache file from scratch.
      const first = await ingestQuestion(q, {
        flags: { strategy: 'legacy', maintenance: 'auto' },
        provider,
        embed,
        cacheDir,
        engineVersion: '7.7.7-test',
      });
      expect(first.cached).toBe(false);
      expect(first.dbFile).toContain('7.7.7-test');
      expect(first.dbFile).toContain(flagsKey({ strategy: 'legacy', maintenance: 'auto' }));
      expect(first.dbFile.endsWith(`${q.question_id}.sqlite`)).toBe(true);
      expect(existsSync(first.dbFile)).toBe(true);
      expect(typeof first.ingestMs).toBe('number');
      expect(first.ingestMs).toBeGreaterThanOrEqual(0);

      expect(readMeta(first.dbFile, 'bench_ingest_complete')).toBe('1');
      expect(countEvents(first.dbFile)).toBe(6);
      expect(countFacts(first.dbFile)).toBeGreaterThanOrEqual(1);

      // The provider must have been invoked at least once for the librarian pass.
      expect(callTracker.calls).toBeGreaterThanOrEqual(1);

      // Second call: must reuse the cache and skip the provider entirely.
      const callCountBefore = callTracker.calls;
      const second = await ingestQuestion(q, {
        flags: { strategy: 'legacy', maintenance: 'auto' },
        provider,
        embed,
        cacheDir,
        engineVersion: '7.7.7-test',
      });
      expect(second.cached).toBe(true);
      expect(second.dbFile).toBe(first.dbFile);
      expect(callTracker.calls).toBe(callCountBefore);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});