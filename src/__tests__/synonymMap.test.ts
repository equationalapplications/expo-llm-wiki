import { describe, it, expect } from 'vitest';
import type * as SQLite from 'expo-sqlite';
import { WikiMemory } from '../WikiMemory';
import type { LLMProvider, WikiConfig } from '../types';

const llmProvider: LLMProvider = { generateText: async () => '{}' };

// Expose private formatSearchQuery via casting for unit testing.
function makeWiki(config?: WikiConfig) {
  // We don't need a real DB to call formatSearchQuery — but constructor needs one.
  // Use a stub that won't be touched.
  const db = {} as unknown as SQLite.SQLiteDatabase;
  const wiki = new WikiMemory(db, { llmProvider, config });
  return wiki as unknown as { formatSearchQuery(q: string): string };
}

describe('formatSearchQuery synonym expansion', () => {
  it('no synonymMap: behaves as before', () => {
    const w = makeWiki();
    const q = w.formatSearchQuery('how was your run today');
    expect(q).toBe('"how"* OR "was"* OR "your"* OR "run"* OR "today"*');
  });

  it('expands a token using synonymMap, deduped', () => {
    const w = makeWiki({ synonymMap: { run: ['jog', 'sprint', 'run'] } });
    const q = w.formatSearchQuery('run');
    expect(q).toContain('"run"*');
    expect(q).toContain('"jog"*');
    expect(q).toContain('"sprint"*');
    // dedup: 'run' present once
    expect(q.match(/"run"\*/g)?.length).toBe(1);
  });

  it('preserves tokens with no synonym entry', () => {
    const w = makeWiki({ synonymMap: { run: ['jog'] } });
    const q = w.formatSearchQuery('today');
    expect(q).toBe('"today"*');
  });

  it('expands multiple tokens independently', () => {
    const w = makeWiki({ synonymMap: { run: ['jog'], partner: ['spouse'] } });
    const q = w.formatSearchQuery('run partner');
    expect(q).toContain('"run"*');
    expect(q).toContain('"jog"*');
    expect(q).toContain('"partner"*');
    expect(q).toContain('"spouse"*');
  });

  it('caps total tokens at 12 after expansion', () => {
    const synonymMap = {
      run: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'],
    };
    const w = makeWiki({ synonymMap });
    const q = w.formatSearchQuery('run');
    const tokenCount = (q.match(/"[^"]+"\*/g) || []).length;
    expect(tokenCount).toBeLessThanOrEqual(12);
  });

  it('empty synonymMap behaves as no synonymMap', () => {
    const w = makeWiki({ synonymMap: {} });
    const q = w.formatSearchQuery('run');
    expect(q).toBe('"run"*');
  });

  it('lowercases synonym values before adding', () => {
    const w = makeWiki({ synonymMap: { run: ['JOG'] } });
    const q = w.formatSearchQuery('run');
    expect(q).toContain('"jog"*');
    expect(q).not.toContain('"JOG"*');
  });
});
