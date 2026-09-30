import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

function mk(config: Record<string, unknown>, generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }))) {
  const db = openTestDatabase();
  return { db, generateText, wiki: new WikiMemory(db, { llmProvider: { generateText }, config }) };
}

describe("maintenance: 'deferred'", () => {
  it('write() records events and never calls the LLM, even past every threshold', async () => {
    const { wiki, db, generateText } = mk({ maintenance: 'deferred', autoLibrarianThreshold: 1, autoHealThreshold: 1 });
    await wiki.setup();
    for (let i = 0; i < 5; i++) await wiki.write('u', { event_type: 'observation', summary: `e${i}` });
    await wiki.drain();
    expect(generateText).not.toHaveBeenCalled();
    expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_events`)).length).toBe(5);
  });
});

describe('drain()', () => {
  it("awaits auto-mode background jobs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const generateText = vi.fn(async () => { await gate; return JSON.stringify({ facts: [], tasks: [] }); });
    const { wiki } = mk({ autoLibrarianThreshold: 1 }, generateText);
    await wiki.setup();
    await wiki.write('u', { event_type: 'observation', summary: 'x' });
    let drained = false;
    const d = wiki.drain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);
    release();
    await d;
    expect(drained).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
  it('resolves immediately with nothing in flight', async () => {
    const { wiki } = mk({});
    await wiki.setup();
    await expect(wiki.drain()).resolves.toBeUndefined();
  });
});

describe('autoLibrarianTokenThreshold', () => {
  it('triggers the librarian on pending text size before the count threshold', async () => {
    const { wiki, generateText } = mk({ autoLibrarianThreshold: 1000, autoLibrarianTokenThreshold: 100 });
    await wiki.setup();
    await wiki.write('u', { event_type: 'observation', summary: 'x'.repeat(200) });
    await wiki.drain();
    expect(generateText).not.toHaveBeenCalled();
    await wiki.write('u', { event_type: 'observation', summary: 'x'.repeat(300) });
    await wiki.drain();
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
