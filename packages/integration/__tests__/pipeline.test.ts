import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { scriptedLLM } from '../helpers/llm';

describe('pipeline — Scenario 1: write → runLibrarian → read', () => {
  it('facts extracted by LLM are returned by read() in relevance order', async () => {
    const db = openTestDatabase();
    const librarianResponse = JSON.stringify({
      facts: [
        { title: 'Editor', body: 'Uses vim', tags: ['tools'], confidence: 'certain' },
        { title: 'UI theme', body: 'Prefers dark mode', tags: ['ui'], confidence: 'certain' },
      ],
      tasks: [],
    });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([librarianResponse], async (text) => {
        // keyword embed so 'editor vim' scores high for 'vim' queries
        if (text.toLowerCase().includes('vim') || text.toLowerCase().includes('editor')) return [1, 0, 0];
        if (text.toLowerCase().includes('dark') || text.toLowerCase().includes('ui')) return [0, 1, 0];
        return [0, 0, 1];
      }),
    });
    await wiki.setup();

    await wiki.write('user-1', {
      event_type: 'observation',
      summary: 'User prefers vim and dark mode',
    });

    await wiki.runLibrarian('user-1');

    const result = await wiki.read('user-1', 'vim editor');
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts[0].title).toBe('Editor');
  });

  it('events array is non-empty in bundle after write()', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([JSON.stringify({ facts: [], tasks: [] })]),
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'Hello world' });
    await wiki.runLibrarian('user-1');

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.events.length).toBeGreaterThan(0);
  });
});

describe('pipeline — Scenario 2: forget() removes fact from read()', () => {
  it('forgotten fact is absent from subsequent read(); other facts remain', async () => {
    const db = openTestDatabase();
    const librarianResponse = JSON.stringify({
      facts: [
        { title: 'Editor choice', body: 'Uses vim', tags: [], confidence: 'certain' },
        { title: 'UI preference', body: 'Dark mode', tags: [], confidence: 'certain' },
      ],
      tasks: [],
    });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([librarianResponse], async (text) => {
        if (text.toLowerCase().includes('editor') || text.toLowerCase().includes('vim')) return [1, 0, 0];
        if (text.toLowerCase().includes('ui') || text.toLowerCase().includes('dark')) return [0, 1, 0];
        return [0, 0, 1];
      }),
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'vim and dark mode' });
    await wiki.runLibrarian('user-1');

    // Identify the editor fact id
    const before = await wiki.getMemoryBundle('user-1');
    const editorFact = before.facts.find((f) => f.title === 'Editor choice');
    expect(editorFact).toBeDefined();

    await wiki.forget('user-1', { entryId: editorFact!.id });

    const result = await wiki.read('user-1', 'vim editor');
    const ids = result.facts.map((f) => f.id);
    expect(ids).not.toContain(editorFact!.id);
    // UI preference should still be present
    expect(result.facts.some((f) => f.title === 'UI preference')).toBe(true);
  });
});

describe('pipeline — Scenario 3: multi-entity isolation', () => {
  it('read() for entity-a never returns facts belonging to entity-b', async () => {
    const db = openTestDatabase();
    const callCount = { n: 0 };
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => {
          const idx = callCount.n++;
          if (idx === 0) {
            return JSON.stringify({
              facts: [{ title: 'Editor tool', body: 'Uses vim', tags: [], confidence: 'certain' }],
              tasks: [],
            });
          }
          return JSON.stringify({
            facts: [{ title: 'Cooking technique', body: 'Loves braising', tags: [], confidence: 'certain' }],
            tasks: [],
          });
        },
        embed: async (text: string): Promise<number[]> => {
          if (text.toLowerCase().includes('vim') || text.toLowerCase().includes('editor')) return [1, 0, 0];
          if (text.toLowerCase().includes('brai') || text.toLowerCase().includes('cook')) return [0, 1, 0];
          return [0, 0, 1];
        },
      },
    });
    await wiki.setup();

    await wiki.write('user-1', { event_type: 'observation', summary: 'Uses vim editor' });
    await wiki.runLibrarian('user-1');

    await wiki.write('user-2', { event_type: 'observation', summary: 'Loves braising' });
    await wiki.runLibrarian('user-2');

    const resultA = await wiki.read('user-1', 'cooking braising');
    const resultB = await wiki.read('user-2', 'vim editor');

    expect(resultA.facts.every((f) => f.entity_id === 'user-1')).toBe(true);
    expect(resultB.facts.every((f) => f.entity_id === 'user-2')).toBe(true);
    expect(resultA.facts.some((f) => f.title === 'Cooking technique')).toBe(false);
    expect(resultB.facts.some((f) => f.title === 'Editor tool')).toBe(false);
  });
});
