import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { IngestionService } from '../src/services/IngestionService';
import { PromptService } from '../src/services/PromptService';
import { INGEST_SYSTEM_PROMPT } from '../src/prompts';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { setupDatabase } from '../src/db/schema';

describe('IngestionService — PromptService injection', () => {
  const fakeLlmResponse = JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] });
  let mockDb: any;
  let mockOptions: any;
  let mockEntryRepo: any;
  let mockSearchService: any;
  let mockJobManager: any;
  let mockEmbeddingService: any;

  beforeEach(() => {
    mockDb = {
      withTransactionAsync: vi.fn(async (fn: (tx: any) => Promise<void>) => fn(mockDb)),
      runAsync: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowId: 0 }),
      getAllAsync: vi.fn().mockResolvedValue([]),
      getFirstAsync: vi.fn().mockResolvedValue(null),
    };
    mockOptions = { llmProvider: { generateText: vi.fn().mockResolvedValue(fakeLlmResponse) } };
    mockEntryRepo = {
      findIdsBySource: vi.fn().mockResolvedValue([]),
      softDeleteBySource: vi.fn().mockResolvedValue(undefined),
      findRecentByEntityId: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    mockSearchService = {
      sync: vi.fn().mockResolvedValue(undefined),
      evictCache: vi.fn(),
    };
    mockJobManager = {
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
    };
    mockEmbeddingService = {
      embedFact: vi.fn().mockResolvedValue(true),
      notifyEmbeddingPersisted: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('passes systemPrompt and userPrompt from PromptService to llmProvider', async () => {
    const promptService = new PromptService();
    const svc = new IngestionService(mockDb, 'llm_wiki_', mockOptions, mockEntryRepo, mockSearchService, mockJobManager, mockEmbeddingService, promptService);

    const sourceHash = 'a'.repeat(64);
    await svc.ingestDocument('entity1', {
      sourceRef: 'doc://test',
      sourceHash,
      documentChunk: 'hello world',
    });

    expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: INGEST_SYSTEM_PROMPT,
        userPrompt: expect.stringContaining('hello world'),
      })
    );
  });

  it('applies runtime promptOverride via PromptService', async () => {
    const promptService = new PromptService();
    const svc = new IngestionService(mockDb, 'llm_wiki_', mockOptions, mockEntryRepo, mockSearchService, mockJobManager, mockEmbeddingService, promptService);

    const sourceHash = 'b'.repeat(64);
    await svc.ingestDocument('entity1', {
      sourceRef: 'doc://test2',
      sourceHash,
      documentChunk: 'chunk text',
      promptOverride: 'custom system prompt',
    });

    expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'custom system prompt' })
    );
  });
});

type Row = Record<string, any>;

class MockSQLiteDatabase {
    private entries: Row[] = [];
    private tasks: Row[] = [];
    private events: Row[] = [];
    private rowidCounter = 0;

    async execAsync(_sql: string): Promise<void> {}

    async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }

    async runAsync(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('UPDATE') && normalized.includes('SET source_ref = ? WHERE rowid = ?')) {
        const [sourceRef, rowid] = args;
        let changes = 0;
        for (const entry of this.entries) {
          if (entry.rowid === rowid) {
            entry.source_ref = sourceRef;
            changes++;
          }
        }
        return { changes, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('UPDATE') && normalized.includes('entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL')) {
        const [deletedAt, updatedAt, sourceRef, entityId] = args;
        let changes = 0;
        for (const entry of this.entries) {
          if (entry.source_ref === sourceRef && entry.entity_id === entityId && entry.deleted_at == null) {
            entry.deleted_at = deletedAt;
            entry.updated_at = updatedAt;
            changes++;
          }
        }
        return { changes, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)')) {
        const [id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at] = args;
        const rowid = ++this.rowidCounter;
        this.entries.push({
          rowid,
          id,
          entity_id,
          title,
          body,
          tags,
          confidence,
          source_type,
          source_hash,
          source_ref,
          created_at,
          updated_at,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        });
        return { changes: 1, lastInsertRowId: rowid };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('entries') && normalized.includes('embedding_blob')) {
        const [id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob] = args;
        const rowid = ++this.rowidCounter;
        this.entries.push({
          rowid,
          id,
          entity_id,
          title,
          body,
          tags,
          confidence,
          source_type,
          source_hash,
          source_ref,
          created_at,
          updated_at,
          last_accessed_at,
          access_count,
          deleted_at: deleted_at ?? null,
          embedding_blob,
        });
        return { changes: 1, lastInsertRowId: rowid };
      }

      return { changes: 0, lastInsertRowId: 0 };
    }

    async getAllAsync<T>(sql: string, args: any[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT rowid, source_ref FROM') && normalized.includes('entries')) {
        return [] as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')) {
        const [entityId] = args;
        return this.entries
          .filter(e => e.entity_id === entityId && e.deleted_at == null)
          .sort((a, b) => b.updated_at - a.updated_at) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC')) {
        const [entityId] = args;
        return this.tasks
          .filter(t => t.entity_id === entityId && t.deleted_at == null)
          .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10')) {
        const [entityId] = args;
        return this.events
          .filter(e => e.entity_id === entityId)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 10) as T[];
      }

      return [] as T[];
    }

    async getFirstAsync<T>(): Promise<T | null> {
      return null;
    }
  }

function makeMockProvider(factsPerChunk: Array<Array<{ title: string; body: string; tags: string[]; confidence: string }>>) {
  let i = 0;
  const calls: number[] = [];
  const startTimes: number[] = [];
  const concurrentCounter = { current: 0, max: 0 };
  return {
    calls,
    concurrentCounter,
    provider: {
      generateText: async ({ userPrompt }: { systemPrompt: string; userPrompt: string }) => {
        concurrentCounter.current++;
        if (concurrentCounter.current > concurrentCounter.max) {
          concurrentCounter.max = concurrentCounter.current;
        }
        const chunkIndex = i++;
        calls.push(chunkIndex);
        startTimes.push(Date.now());
        // simulate async work
        await new Promise(r => setTimeout(r, 20));
        concurrentCounter.current--;
        return JSON.stringify({ facts: factsPerChunk[chunkIndex] ?? [] });
      },
    },
  };
}

async function freshWiki(provider: any) {
  const db = new MockSQLiteDatabase();
  const wiki = new WikiMemory(db, { llmProvider: provider, config: { tablePrefix: 'test_' } });
  await wiki.setup();
  return wiki;
}

const sourceHash = 'a'.repeat(64);

describe('ingestDocument', () => {
  it('parallelizes LLM calls across chunks when chunkConcurrency > 1', async () => {
    const text = 'Sentence one. Sentence two.\n\n'.repeat(2000); // ~56KB, forces multiple chunks
    const m = makeMockProvider([
      [{ title: 'Fact 1', body: 'body 1', tags: [], confidence: 'certain' }],
      [{ title: 'Fact 2', body: 'body 2', tags: [], confidence: 'certain' }],
      [{ title: 'Fact 3', body: 'body 3', tags: [], confidence: 'certain' }],
      [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);
    const wiki = await freshWiki(m.provider);
    const result = await wiki.ingestDocument('e1', {
      sourceRef: 'doc1',
      sourceHash,
      documentChunk: text,
      maxChunkLength: 3000,
      chunkOverlap: 0,
      chunkConcurrency: 4,
    });
    expect(result.chunks).toBeGreaterThan(1);
    // max concurrency should be > 1 (parallel execution)
    expect(m.concurrentCounter.max).toBeGreaterThan(1);
  });

  it('processes chunks sequentially when chunkConcurrency is 1 (default)', async () => {
    const text = 'Sentence one. Sentence two.\n\n'.repeat(2000);
    const m = makeMockProvider([
      [{ title: 'Fact 1', body: 'body 1', tags: [], confidence: 'certain' }],
      [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);
    const wiki = await freshWiki(m.provider);
    const result = await wiki.ingestDocument('e1b', {
      sourceRef: 'doc1b',
      sourceHash,
      documentChunk: text,
      maxChunkLength: 3000,
      chunkOverlap: 0,
      // chunkConcurrency defaults to 1
    });
    expect(result.chunks).toBeGreaterThan(1);
    expect(m.concurrentCounter.max).toBe(1);
  });

  it('deduplicates facts with same normalized title across chunks', async () => {
    // Two chunks each returning a fact with same normalized title
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.';
    const m = makeMockProvider([
      [{ title: 'Same Title', body: 'body 1', tags: [], confidence: 'certain' }],
      [{ title: 'same title', body: 'body 2', tags: [], confidence: 'certain' }], // duplicate normalized
    ]);
    const wiki = await freshWiki(m.provider);
    await wiki.ingestDocument('e2', {
      sourceRef: 'doc2',
      sourceHash,
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    const bundle = await wiki.getMemoryBundle('e2');
    const sames = bundle.facts.filter(f => f.title.toLowerCase() === 'same title');
    expect(sames.length).toBe(1);
    expect(sames[0].body).toBe('body 1'); // first-wins
  });

  it('one chunk failing rejects whole call with no DB writes', async () => {
    const text = 'First chunk content.\n\nSecond chunk content.';
    let callCount = 0;
    const failProvider = {
      generateText: async () => {
        callCount++;
        if (callCount === 2) throw new Error('LLM failed');
        return JSON.stringify({ facts: [{ title: 'Good Fact', body: 'some body text', tags: [], confidence: 'certain' }] });
      },
    };
    const wiki = await freshWiki(failProvider);
    await expect(
      wiki.ingestDocument('e3', { sourceRef: 'doc3', sourceHash, documentChunk: text, maxChunkLength: 30, chunkOverlap: 0 })
    ).rejects.toThrow('LLM failed');
    const bundle = await wiki.getMemoryBundle('e3');
    expect(bundle.facts.length).toBe(0);
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['NaN', NaN],
    ['fractional 1.7 floors to 1', 1.7],
  ])('chunkConcurrency %s falls back gracefully (sequential)', async (_label, value) => {
    const text = 'Sentence one. Sentence two.\n\n'.repeat(50);
    const m = makeMockProvider([
      [{ title: 'Fact A', body: 'body a', tags: [], confidence: 'certain' }],
      [], [], [], [],
    ]);
    const wiki = await freshWiki(m.provider);
    await expect(
      wiki.ingestDocument('e_cc', {
        sourceRef: `doc_cc_${String(value)}`,
        sourceHash,
        documentChunk: text,
        maxChunkLength: 500,
        chunkOverlap: 0,
        chunkConcurrency: value,
      })
    ).resolves.toBeDefined();
    // Invalid values fall back to 1 — max concurrency should be exactly 1
    expect(m.concurrentCounter.max).toBe(1);
  });
});

describe('ingestDocument — ontology', () => {
  const PREFIX = 'llm_wiki_';
  const sourceHash = 'c'.repeat(64);

  it('persists okf_type and edge when target is in same chunk', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);

    const ingestResponse = JSON.stringify({
      facts: [
        {
          title: 'Bob Smith',
          body: 'Bob is a manager.',
          tags: [],
          confidence: 'certain',
          okf_type: 'person',
        },
        {
          title: 'Jane reports to Bob',
          body: 'Jane reports to Bob Smith.',
          tags: [],
          confidence: 'certain',
          okf_type: 'person',
          edges: [{ edge_type: 'reports_to', target_title: 'Bob Smith' }],
        },
      ],
    });

    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => ingestResponse },
      config: { tablePrefix: PREFIX, ontology: { mode: 'strict' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('entity_ont', {
      node_types: [{ type: 'person', description: 'An individual.' }],
      edge_types: [{
        type: 'reports_to',
        source_type: 'person',
        target_type: 'person',
        description: 'Hierarchy.',
      }],
    }, { mode: 'strict' });

    await wiki.ingestDocument('entity_ont', {
      sourceRef: 'doc://ontology',
      sourceHash,
      documentChunk: 'Jane reports to Bob Smith. Bob is a manager.',
    });

    const bundle = await wiki.getMemoryBundle('entity_ont');
    const jane = bundle.facts.find(f => f.title === 'Jane reports to Bob');
    const bob = bundle.facts.find(f => f.title === 'Bob Smith');
    expect(jane?.okf_type).toBe('person');
    expect(bob?.okf_type).toBe('person');
    expect(bundle.edges?.length).toBe(1);
    expect(bundle.edges?.[0].edge_type).toBe('reports_to');
    expect(bundle.edges?.[0].source_id).toBe(jane?.id);
    expect(bundle.edges?.[0].target_id).toBe(bob?.id);
  });

  it('persists edge when source fact appears before target across ingest calls', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);

    const bobResponse = JSON.stringify({
      facts: [{
        title: 'Bob Smith',
        body: 'Bob is a manager.',
        tags: [],
        confidence: 'certain',
        okf_type: 'person',
      }],
    });
    const janeResponse = JSON.stringify({
      facts: [{
        title: 'Jane reports to Bob',
        body: 'Jane reports to Bob Smith.',
        tags: [],
        confidence: 'certain',
        okf_type: 'person',
        edges: [{ edge_type: 'reports_to', target_title: 'Bob Smith' }],
      }],
    });

    let callCount = 0;
    const wiki = new WikiMemory(db, {
      llmProvider: {
        generateText: async () => (callCount++ === 0 ? bobResponse : janeResponse),
      },
      config: { tablePrefix: PREFIX, ontology: { mode: 'strict' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('entity_ont_rev', {
      node_types: [{ type: 'person', description: 'An individual.' }],
      edge_types: [{
        type: 'reports_to',
        source_type: 'person',
        target_type: 'person',
        description: 'Hierarchy.',
      }],
    }, { mode: 'strict' });

    await wiki.ingestDocument('entity_ont_rev', {
      sourceRef: 'doc://bob',
      sourceHash: 'a'.repeat(64),
      documentChunk: 'Bob Smith is a manager.',
    });
    await wiki.ingestDocument('entity_ont_rev', {
      sourceRef: 'doc://jane',
      sourceHash: 'b'.repeat(64),
      documentChunk: 'Jane reports to Bob Smith.',
    });

    const bundle = await wiki.getMemoryBundle('entity_ont_rev');
    const jane = bundle.facts.find(f => f.title === 'Jane reports to Bob');
    const bob = bundle.facts.find(f => f.title === 'Bob Smith');
    expect(jane?.okf_type).toBe('person');
    expect(bob?.okf_type).toBe('person');
    expect(bundle.edges?.length).toBe(1);
    expect(bundle.edges?.[0].edge_type).toBe('reports_to');
    expect(bundle.edges?.[0].source_id).toBe(jane?.id);
    expect(bundle.edges?.[0].target_id).toBe(bob?.id);
  });
});
