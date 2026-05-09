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

const HASH_A = 'a'.repeat(64); // valid 64-char hex sourceHash

describe('pipeline — Scenario 4: ingestDocument → read', () => {
  it('facts extracted from ingested document are retrievable via read()', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({
      facts: [
        { title: 'Neural networks', body: 'Inspired by biological neurons, used in deep learning', tags: ['ml'], confidence: 'certain' },
        { title: 'Gradient descent', body: 'Optimisation algorithm that minimises loss by iterating toward lower gradients', tags: ['ml'], confidence: 'certain' },
      ],
    });
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([llmResponse]) });
    await wiki.setup();

    const result = await wiki.ingestDocument('user-1', {
      sourceRef: 'ml-intro',
      sourceHash: HASH_A,
      documentChunk: 'Machine learning uses neural networks and gradient descent to learn from data.',
    });

    expect(result.truncated).toBe(false);
    expect(result.chunks).toBe(1);

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.length).toBe(2);
    expect(bundle.facts.every((f) => f.source_type === 'immutable_document')).toBe(true);
    expect(bundle.facts.every((f) => f.source_ref === 'ml-intro')).toBe(true);

    const readResult = await wiki.read('user-1', 'neural networks');
    expect(readResult.facts.length).toBeGreaterThan(0);
    expect(readResult.facts[0].title).toBe('Neural networks');
  });
});

const HASH_B = 'b'.repeat(64);

describe('pipeline — Scenario 5: hasChanged', () => {
  it('returns false for same sourceRef+sourceHash, true for different hash or unknown ref', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] });
    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM([llmResponse]) });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some content for the document.',
    });

    // same ref + same hash → not changed
    expect(await wiki.hasChanged('user-1', 'doc-a', HASH_A)).toBe(false);

    // same ref + different hash → changed
    expect(await wiki.hasChanged('user-1', 'doc-a', HASH_B)).toBe(true);

    // unknown ref → changed (treat as new)
    expect(await wiki.hasChanged('user-1', 'doc-b', HASH_A)).toBe(true);
  });
});

describe('pipeline — Scenario 6: chunk boundary', () => {
  it('long document is split into multiple chunks, each stored and retrievable', async () => {
    const db = openTestDatabase();
    // 800-char doc split into ≥4 chunks at maxChunkLength:200
    const longText = [
      'Photosynthesis converts light into chemical energy stored as glucose.',
      'Chlorophyll absorbs red and blue light while reflecting green wavelengths.',
      'The light-dependent reactions occur in the thylakoid membranes of chloroplasts.',
      'The Calvin cycle fixes carbon dioxide into three-carbon sugars using ATP and NADPH.',
      'Oxygen is released as a byproduct of splitting water molecules during photolysis.',
      'C4 plants concentrate carbon dioxide to minimise photorespiration losses.',
      'CAM plants open stomata at night to reduce water loss in arid conditions.',
      'Rubisco is the enzyme responsible for carbon fixation in the Calvin cycle.',
    ].join(' ');

    // Provide one LLM response per expected chunk (≥4 at 200-char limit)
    const makeFact = (title: string) =>
      JSON.stringify({ facts: [{ title, body: 'Detail', tags: [], confidence: 'certain' }] });
    const chunkResponses = Array.from({ length: 8 }, (_, i) => makeFact(`Plant fact ${i + 1}`));

    const wiki = new WikiMemory(db, { llmProvider: scriptedLLM(chunkResponses) });
    await wiki.setup();

    const result = await wiki.ingestDocument('user-1', {
      sourceRef: 'plant-biology',
      sourceHash: HASH_A,
      documentChunk: longText,
      maxChunkLength: 200,
      chunkOverlap: 0,
    });

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.length).toBeGreaterThanOrEqual(2);
    expect(bundle.facts.every((f) => f.source_ref === 'plant-biology')).toBe(true);

    // Facts from later chunks should be retrievable
    const readResult = await wiki.read('user-1', 'Plant fact');
    expect(readResult.facts.length).toBeGreaterThan(0);
  });
});

describe('pipeline — Scenario 7: idempotent re-ingest', () => {
  it('calling ingestDocument twice with same sourceRef+sourceHash yields same fact count', async () => {
    const db = openTestDatabase();
    const llmResponse = JSON.stringify({
      facts: [
        { title: 'Fact one', body: 'Body one', tags: [], confidence: 'certain' },
        { title: 'Fact two', body: 'Body two', tags: [], confidence: 'certain' },
      ],
    });
    // Second call re-ingests same chunk → 2 more scripted responses needed
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([llmResponse, llmResponse]),
    });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some stable document content.',
    });
    const countAfterFirst = (await wiki.getMemoryBundle('user-1')).facts.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Re-ingest identical source: old facts soft-deleted, new ones created → same active count
    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-a',
      sourceHash: HASH_A,
      documentChunk: 'Some stable document content.',
    });
    const countAfterSecond = (await wiki.getMemoryBundle('user-1')).facts.length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe('pipeline — Scenario 8: forget by sourceRef removes all chunks', () => {
  it('forgetting by sourceRef removes all ingested facts; read returns empty', async () => {
    const db = openTestDatabase();
    const chunkResp = (title: string) =>
      JSON.stringify({ facts: [{ title, body: 'Body', tags: [], confidence: 'certain' }] });
    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([
        chunkResp('Chunk A'), chunkResp('Chunk B'), chunkResp('Chunk C'), chunkResp('Chunk D'),
      ]),
    });
    await wiki.setup();

    await wiki.ingestDocument('user-1', {
      sourceRef: 'doc-alpha',
      sourceHash: HASH_A,
      documentChunk: 'A'.repeat(201) + ' ' + 'B'.repeat(201),
      maxChunkLength: 200,
      chunkOverlap: 0,
    });

    const before = await wiki.getMemoryBundle('user-1');
    expect(before.facts.some((f) => f.source_ref === 'doc-alpha')).toBe(true);

    await wiki.forget('user-1', { sourceRef: 'doc-alpha' });

    const bundle = await wiki.getMemoryBundle('user-1');
    expect(bundle.facts.filter((f) => f.source_ref === 'doc-alpha')).toHaveLength(0);

    const readResult = await wiki.read('user-1', 'Chunk A');
    const alphaIds = before.facts.map((f) => f.id);
    expect(readResult.facts.every((f) => !alphaIds.includes(f.id))).toBe(true);
  });
});
