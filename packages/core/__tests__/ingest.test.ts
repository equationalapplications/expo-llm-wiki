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
  let mockSourceRefIndexRepo: any;
  let mockSearchService: any;
  let mockJobManager: any;
  let mockEmbeddingService: any;
  let mockMetadataRepo: any;
  let mockEdgeRepo: any;

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
    mockSourceRefIndexRepo = {
      findActiveByEntityAndHash: vi.fn().mockResolvedValue(null),
      softDeleteByEntityAndSourceRef: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    mockMetadataRepo = {
      getManifest: vi.fn().mockResolvedValue(null),
    };
    mockEdgeRepo = {
      addIgnoreDuplicate: vi.fn().mockResolvedValue(true),
      softDeleteBySourceFactIds: vi.fn().mockResolvedValue(0),
    };
    mockSearchService = {
      sync: vi.fn().mockResolvedValue(undefined),
      evictCache: vi.fn(),
    };
    mockJobManager = {
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      acquireIngestLocks: vi.fn().mockResolvedValue(vi.fn()),
    };
    mockEmbeddingService = {
      embedFact: vi.fn().mockResolvedValue(true),
      notifyEmbeddingPersisted: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('passes systemPrompt and userPrompt from PromptService to llmProvider', async () => {
    const promptService = new PromptService();
    const svc = new IngestionService(mockDb, 'llm_wiki_', mockOptions, mockEntryRepo, mockSourceRefIndexRepo, mockMetadataRepo, mockEdgeRepo, mockSearchService, mockJobManager, mockEmbeddingService, promptService);

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
    const svc = new IngestionService(mockDb, 'llm_wiki_', mockOptions, mockEntryRepo, mockSourceRefIndexRepo, mockMetadataRepo, mockEdgeRepo, mockSearchService, mockJobManager, mockEmbeddingService, promptService);

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

      if (normalized.startsWith('UPDATE') && normalized.includes('entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL')) {
        // Actual SQL: `... WHERE entity_id = ? AND deleted_at IS NULL [AND source_ref = ?]`
        // (order is entity_id first, then optional source_ref). args = [deletedAt, updatedAt, entityId]
        // or [deletedAt, updatedAt, entityId, sourceRef].
        const [deletedAt, updatedAt, entityId, sourceRefMaybe] = args;
        let changes = 0;
        for (const entry of this.entries) {
          if (entry.entity_id === entityId && entry.deleted_at == null) {
            if (sourceRefMaybe !== undefined && entry.source_ref !== sourceRefMaybe) continue;
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

      if (normalized.startsWith('SELECT id FROM') && normalized.includes('entries') && normalized.includes('source_ref = ?') && normalized.includes('entity_id = ?')) {
        // EntryRepository.findIdsBySource(entityId, sourceRef, null, tx, false)
        // Actual SQL: `SELECT id FROM entries WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL`
        const [entityId, sourceRef] = args as string[];
        return this.entries
          .filter(e => e.entity_id === entityId && e.source_ref === sourceRef && e.deleted_at == null)
          .map(e => ({ id: e.id })) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('entries') && normalized.includes('id IN (') && normalized.includes('deleted_at IS NULL')) {
        // EntryRepository.findByIds(ids, scopedEntityIds, tx)
        // Actual SQL: `SELECT * FROM entries WHERE id IN (?,...) [AND entity_id IN (?,...)] AND deleted_at IS NULL`
        // args layout: [...ids, ...entityIds]. Heuristic: filter by id match AND entity_id match.
        const idSet = new Set<string>();
        const entityIdSet = new Set<string>();
        for (const a of args) {
          if (typeof a !== 'string') continue;
          if (this.entries.some(e => e.id === a)) idSet.add(a);
          if (this.entries.some(e => e.entity_id === a)) entityIdSet.add(a);
        }
        return this.entries
          .filter(e => e.deleted_at == null && idSet.has(e.id) && entityIdSet.has(e.entity_id)) as T[];
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

  it('one chunk failing allows sibling chunks to commit; failedChunks reflects the count', async () => {
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
    const result = await wiki.ingestDocument('e3', {
      sourceRef: 'doc3',
      sourceHash,
      documentChunk: text,
      maxChunkLength: 30,
      chunkOverlap: 0,
    });
    expect(result.failedChunks).toBe(1);
    expect(result.ingestedChunks).toBe(result.chunks - 1);
    expect(result.parseFailures![0].source).toBe('llm');
    // Sibling facts DID write through.
    const bundle = await wiki.getMemoryBundle('e3');
    expect(bundle.facts.length).toBe(1);
    expect(bundle.facts[0].title).toBe('Good Fact');
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

    const bobResponse = JSON.stringify({
      facts: [
        {
          title: 'Bob Smith',
          body: 'Bob is a manager.',
          tags: [],
          confidence: 'certain',
          okf_type: 'person',
        },
      ],
    });
    const janeResponse = JSON.stringify({
      facts: [
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

    let responseIdx = 0;
    const responses = [bobResponse, janeResponse];
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => responses[responseIdx++] ?? '{}' },
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

    // v9 UNIQUE index forbids two live rows sharing (entity_id, source_hash),
    // so the two facts have to come from distinct documents (distinct hashes).
    // The ontology edge wiring between them is what this test is verifying.
    const bobHash = 'b'.repeat(64);
    const janeHash = 'c'.repeat(64);
    await wiki.ingestDocument('entity_ont', {
      sourceRef: 'doc://ontology-bob',
      sourceHash: bobHash,
      documentChunk: 'Bob Smith is a manager.',
    });
    await wiki.ingestDocument('entity_ont', {
      sourceRef: 'doc://ontology-jane',
      sourceHash: janeHash,
      documentChunk: 'Jane reports to Bob Smith.',
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

  it('persists LLM-supplied tags and confidence through the upsertGraphCore path (regression: ensure refactor did not lose metadata)', async () => {
    // Refactor route: ingestDocument → upsertGraphCore. The OLD wikiFact
    // construction stored the LLM-extracted `fact.tags` and `fact.confidence`
    // verbatim; the refactored upsertGraphCore initially hardcoded
    // `tags: []` and `confidence: 'certain'` (the public upsertGraph default
    // for deterministic host nodes), silently dropping them for ingest.
    // That broke search-filter-by-tag, heal-candidate selection
    // (`findHealCandidatesByEntityId` filters on `confidence = 'inferred'`),
    // and runReembed's embedding-text (which joins `tags.join(' ')`).
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const tags = ['auth', 'rate-limit'];
    const resp = JSON.stringify({
      facts: [{
        title: 'Tagged fact',
        body: 'Some body.',
        tags,
        confidence: 'inferred',
        okf_type: '',
      }],
    });
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => resp },
      config: { tablePrefix: PREFIX },
    });
    await wiki.setup();
    await wiki.ingestDocument('entity_tag', {
      sourceRef: 'doc://tag',
      sourceHash: 'd'.repeat(64),
      documentChunk: 'Tagged fact body.',
    });
    const bundle = await wiki.getMemoryBundle('entity_tag');
    const fact = bundle.facts.find(f => f.title === 'Tagged fact');
    expect(fact).toBeDefined();
    expect(fact!.tags).toEqual(tags);
    expect(fact!.confidence).toBe('inferred');
  });
});

describe('ingestDocument — partial commit (issue #92)', () => {
  // Deterministic 64-char hex string per integer index. `padStart` keeps
  // each output distinct (e.g. `1` and `11`) so a future test that reuses
  // one `freshWiki` instance with two colliding indices cannot hit the
  // duplicate-hash path for an unrelated reason.
  const sourceHashFor = (i: number) => String(i).padStart(4, '0').repeat(16);

  function makeBadJson() {
    // LLM emits a structurally-incomplete payload: an array bracket with
    // no balanced close. Both the strict scanner (no balanced span) and the
    // container-aware repair walker (no candidate produced — the stack
    // never pops to empty) reject this. See pure.ts parseJsonResponse.
    // The plan's originally-suggested `"she said "hi"` input is now
    // handled by tier-2; the previous `"a"b"` fixture was a bare quote
    // inside a value string which the walker also now repairs. An unclosed
    // bracket is a structural failure that defeats every parser tier.
    return '{"facts":[';
  }

  it('one chunk parse-fails: siblings commit, failedChunks=1, source=parse', async () => {
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const result = await wiki.ingestDocument('e_partial_1', {
      sourceRef: 'doc-partial-1',
      sourceHash: sourceHashFor(1),
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    expect(result.chunks).toBeGreaterThan(2);
    expect(result.failedChunks).toBe(1);
    expect(result.ingestedChunks).toBe(result.chunks - 1);
    expect(result.parseFailures).toBeDefined();
    expect(result.parseFailures![0].source).toBe('parse');
    expect(result.parseFailures![0].chunkIndex).toBe(1);
    expect(result.parseFailures![0].sourceRef).toBe('doc-partial-1');
    // Sibling facts reach the bundle (the persistent set is non-empty).
    const bundle = await wiki.getMemoryBundle('e_partial_1');
    expect(bundle.facts.length).toBe(result.ingestedChunks);
  });

  it('one chunk LLM-fails: siblings commit, source=llm (no tier)', async () => {
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) throw new Error('Bedrock ThrottlingException');
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const result = await wiki.ingestDocument('e_partial_2', {
      sourceRef: 'doc-partial-2',
      sourceHash: sourceHashFor(2),
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    expect(result.failedChunks).toBe(1);
    expect(result.parseFailures![0].source).toBe('llm');
    expect(result.parseFailures![0].tier).toBeUndefined();
    expect(result.parseFailures![0].message).toContain('ThrottlingException');
  });

  it('all chunks fail: throws WikiIngestEmptyError with full parseFailures', async () => {
    const text = 'First chunk content.\n\nSecond chunk content.\n\nThird chunk content.';
    const provider = {
      generateText: async () => makeBadJson(),
    };
    const wiki = await freshWiki(provider);
    await expect(
      wiki.ingestDocument('e_all_fail', {
        sourceRef: 'doc-all-fail',
        sourceHash: sourceHashFor(3),
        documentChunk: text,
        maxChunkLength: 30,
        chunkOverlap: 0,
      }),
    ).rejects.toMatchObject({
      name: 'WikiIngestEmptyError',
      sourceRef: 'doc-all-fail',
      chunks: expect.any(Number),
    });
  });

  it('mixed parse + llm failures: sources correctly tagged per chunk', async () => {
    const text = 'First chunk content here.\n\nSecond chunk content here.\n\nThird chunk content here.\n\nFourth chunk content here.\n\nFifth chunk content here.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 0) return makeBadJson();          // parse failure
        if (idx === 2) throw new Error('rate limit'); // llm failure
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const result = await wiki.ingestDocument('e_mixed', {
      sourceRef: 'doc-mixed',
      sourceHash: sourceHashFor(4),
      documentChunk: text,
      maxChunkLength: 35,
      chunkOverlap: 0,
    });
    expect(result.failedChunks).toBe(2);
    const sources = result.parseFailures!.map((f) => f.source).sort();
    expect(sources).toEqual(['llm', 'parse']);
  });

  it('console.warn fires exactly once per failed chunk', async () => {
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 0 || idx === 2) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await wiki.ingestDocument('e_warn', {
        sourceRef: 'doc-warn',
        sourceHash: sourceHashFor(5),
        documentChunk: text,
        maxChunkLength: 50,
        chunkOverlap: 0,
      });
      expect(warnSpy.mock.calls.length).toBe(result.failedChunks);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('console.warn NEVER includes the raw LLM response body', async () => {
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.';
    const badJson = makeBadJson();
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 0) return badJson;
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await wiki.ingestDocument('e_noleak', {
        sourceRef: 'doc-noleak',
        sourceHash: sourceHashFor(6),
        documentChunk: text,
        maxChunkLength: 50,
        chunkOverlap: 0,
      });
      // `makeBadJson()` returns `'{"facts":['` — the substring below is
      // a fragment of the raw LLM response body. If the no-leak invariant
      // regresses (e.g. the response text is interpolated into the warn
      // line), this assertion catches it. Do NOT change this fragment to
      // something not in `badJson` — the previous incarnation asserted
      // against `'"a"b"'` which was a vacuous substring check.
      const responseBodyFragment = '{"facts":[';
      expect(badJson).toContain(responseBodyFragment);
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          if (typeof arg === 'string') {
            expect(arg).not.toContain(responseBodyFragment);
          }
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('console.warn NEVER includes the provider Error.message body (llm-error branch)', async () => {
    // Regression for the provider-controlled `Error.message` leak:
    // some LLM SDKs surface the raw response body, document content, or a
    // multi-megabyte HTTP error in `Error.message`. The warn line must
    // redact this — full detail stays in `parseFailures` for callers that
    // opt in, but the unconditional warn is intentionally narrow.
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.';
    const responseBodyFragment = '{"facts":[{"body":"super-secret-proprietary-document-content"}]}';
    const leakyMessage = `Bedrock InvocationModelError: server returned 4xx with body: ${responseBodyFragment}`;
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 0) throw new Error(leakyMessage);
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await wiki.ingestDocument('e_noleak_llm', {
        sourceRef: 'doc-noleak-llm',
        sourceHash: sourceHashFor(8),
        documentChunk: text,
        maxChunkLength: 50,
        chunkOverlap: 0,
      });
      expect(result.failedChunks).toBe(1);
      expect(result.parseFailures![0].source).toBe('llm');
      // The full leaky message stays in parseFailures (typed diagnostic
      // for callers that opt in).
      expect(result.parseFailures![0].message).toContain(responseBodyFragment);
      // But the warn line must NOT contain the leaky fragment.
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          if (typeof arg === 'string') {
            expect(arg).not.toContain(responseBodyFragment);
          }
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ontologyContext failure propagates as a raw throw, does NOT become WikiIngestEmptyError', async () => {
    const text = 'First chunk content.\n\nSecond chunk content.';
    const provider = {
      generateText: async () =>
        JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }] }),
    };
    const wiki = await freshWiki(provider);
    // Inject a buildPromptContext failure by spying on the real ontology
    // service instance. Spying preserves the prototype methods on the
    // underlying service — a plain object-spread replacement would expose
    // only `buildPromptContext` and fail any future call that uses a
    // sibling method (e.g. `getEffectiveState`) with a TypeError instead of
    // the intended assertion.
    const svc = wiki.__testAccess.ingestionService as IngestionService;
    const ontologySpy = vi
      .spyOn((svc as any).ontologyService, 'buildPromptContext')
      .mockRejectedValue(new Error('DB connection lost'));
    try {
      await expect(
        wiki.ingestDocument('e_ontology', {
          sourceRef: 'doc-ontology',
          sourceHash: sourceHashFor(7),
          documentChunk: text,
          maxChunkLength: 30,
          chunkOverlap: 0,
        }),
      ).rejects.toThrow('DB connection lost');
    } finally {
      ontologySpy.mockRestore();
    }
  });

  it('partial commit does NOT update source_ref_index (no ownership on partial)', async () => {
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const svc = wiki.__testAccess.ingestionService as IngestionService;
    const upsertSpy = vi.spyOn(svc['sourceRefIndexRepo'], 'upsert');
    await wiki.ingestDocument('e_no_own', {
      sourceRef: 'doc://no-own',
      sourceHash: sourceHashFor(8),
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('partial commit does NOT supersede prior facts for the same sourceRef', async () => {
    // First: a full successful ingest.
    const text = 'First chunk content here long enough.';
    const fullProvider = {
      generateText: async () =>
        JSON.stringify({ facts: [{ title: 'Original', body: 'body', tags: [], confidence: 'certain' }] }),
    };
    const wiki = await freshWiki(fullProvider);
    const sourceHashA = sourceHashFor(9);
    await wiki.ingestDocument('e_super', {
      sourceRef: 'doc://super',
      sourceHash: sourceHashA,
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    // Confirm the original fact is live.
    const bundleBefore = await wiki.getMemoryBundle('e_super');
    expect(bundleBefore.facts.map((f) => f.title)).toContain('Original');

    // Now: a partial ingest with a new sourceHash (different content) but
    // same sourceRef — this must NOT soft-delete the prior fact.
    const partialText = 'New chunk content here long enough.\n\nNewer chunk content here long enough.';
    let i = 0;
    const partialProvider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `New ${idx}`, body: `new body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    (wiki as any).options.llmProvider = partialProvider;
    const sourceHashB = sourceHashFor(10);
    await wiki.ingestDocument('e_super', {
      sourceRef: 'doc://super',
      sourceHash: sourceHashB,
      documentChunk: partialText,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });

    const bundleAfter = await wiki.getMemoryBundle('e_super');
    // Both the original fact and the partial attempt's new facts are live.
    expect(bundleAfter.facts.map((f) => f.title)).toContain('Original');
    expect(bundleAfter.facts.map((f) => f.title)).toContain('New 0');
  });

  it('partial commit dedups against prior live facts for the same sourceRef', async () => {
    // First: a full ingest of 'Fact A' under sourceRef.
    const wiki = await freshWiki({
      generateText: async () =>
        JSON.stringify({ facts: [{ title: 'Fact A', body: 'body', tags: [], confidence: 'certain' }] }),
    });
    await wiki.ingestDocument('e_dedup', {
      sourceRef: 'doc://dedup',
      sourceHash: sourceHashFor(11),
      documentChunk: 'Chunk A content here long enough.',
      maxChunkLength: 50,
      chunkOverlap: 0,
    });

    // Now: a partial ingest where chunk 0 succeeds with the SAME title 'Fact A'.
    let i = 0;
    (wiki as any).options.llmProvider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: 'Fact A', body: 'duplicate body', tags: [], confidence: 'certain' }],
        });
      },
    };
    const result = await wiki.ingestDocument('e_dedup', {
      sourceRef: 'doc://dedup',
      sourceHash: sourceHashFor(12),
      documentChunk: 'New chunk content here long enough.\n\nNewer chunk content here long enough.',
      maxChunkLength: 50,
      chunkOverlap: 0,
    });

    expect(result.failedChunks).toBe(1);
    // Only one 'Fact A' in the bundle despite two ingest attempts.
    const bundle = await wiki.getMemoryBundle('e_dedup');
    const factAs = bundle.facts.filter((f) => f.title === 'Fact A');
    expect(factAs.length).toBe(1);
  });

  it('partial commit fires embedFact for every inserted fact', async () => {
    // Regression for the copilot review: when a partial commit inserts
    // rows via `appendPartialFacts`, those rows' embedding lifecycle
    // previously skipped `embedFact` and `onEmbeddingPersisted` because
    // the post-commit hook loop was gated on `failedChunks === 0`. That
    // left `embedding_blob` null on partial-path rows and never notified
    // the vector ranker — silently broken semantic retrieval until a
    // later full retry. The fix threads the inserted descriptors through
    // the same hook loop on either path.
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `Partial ${idx}`, body: `partial body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const embedSpy = vi.spyOn(wiki.__testAccess.embeddingService, 'embedFact');
    try {
      const result = await wiki.ingestDocument('e_partial_embed', {
        sourceRef: 'doc://partial-embed',
        sourceHash: sourceHashFor(13),
        documentChunk: text,
        maxChunkLength: 50,
        chunkOverlap: 0,
      });
      expect(result.chunks).toBeGreaterThan(2);
      expect(result.ingestedChunks).toBe(result.chunks - 1);
      expect(result.failedChunks).toBe(1);
      // Every successful chunk's fact reaches `embedFact` — one call per
      // inserted fact descriptor. The descriptor shape mirrors what
      // `runFullUpsertGraph` returns so the embedding service sees the
      // same shape whether the insert came from the full or partial path.
      expect(embedSpy.mock.calls.length).toBe(result.ingestedChunks);
      for (const call of embedSpy.mock.calls) {
        const descriptor = call[0];
        expect(typeof descriptor.id).toBe('string');
        expect(typeof descriptor.entity_id).toBe('string');
        expect(typeof descriptor.title).toBe('string');
        expect(typeof descriptor.body).toBe('string');
      }
    } finally {
      embedSpy.mockRestore();
    }
  });

  it('a subsequent full success replaces both prior partial and prior full attempts in one transaction', async () => {
    // First: a full ingest that establishes the sourceRef.
    const wiki = await freshWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 'Full', body: 'f', tags: [], confidence: 'certain' }] }),
    });
    const sourceRef = 'doc://retry';
    await wiki.ingestDocument('e_retry', {
      sourceRef,
      sourceHash: sourceHashFor(13),
      documentChunk: 'First chunk content here long enough.',
      maxChunkLength: 50,
      chunkOverlap: 0,
    });

    // Second: a partial ingest (chunk 1 fails) for the same sourceRef with new hash.
    let i = 0;
    (wiki as any).options.llmProvider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({ facts: [{ title: 'Partial', body: 'p', tags: [], confidence: 'certain' }] });
      },
    };
    await wiki.ingestDocument('e_retry', {
      sourceRef,
      sourceHash: sourceHashFor(14),
      documentChunk: 'New chunk content here long enough.\n\nNewer chunk content here long enough.',
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    const partialBundle = await wiki.getMemoryBundle('e_retry');
    // Both 'Full' (prior) and 'Partial' (this partial attempt) are live.
    expect(partialBundle.facts.map((f) => f.title).sort()).toEqual(['Full', 'Partial']);

    // Third: a full success for the same sourceRef with a new hash. The full
    // path's supersession replaces BOTH the prior full attempt AND the partial
    // attempt in one transaction.
    (wiki as any).options.llmProvider = {
      generateText: async () => JSON.stringify({ facts: [{ title: 'Final', body: 'f', tags: [], confidence: 'certain' }] }),
    };
    await wiki.ingestDocument('e_retry', {
      sourceRef,
      sourceHash: sourceHashFor(15),
      documentChunk: 'Final chunk content here long enough.',
      maxChunkLength: 50,
      chunkOverlap: 0,
    });

    // Only 'Final' should be live — both prior attempts were superseded.
    const bundle = await wiki.getMemoryBundle('e_retry');
    const titles = bundle.facts.map((f) => f.title);
    expect(titles).toEqual(['Final']);
  });

  it('hasChanged returns true after a partial commit (so the failed chunks retry on the same hash)', async () => {
    // Regression: appendPartialFacts stores source_hash as NULL on partial
    // rows. findLatestSourceHash reads from the most recently updated live
    // row, so the partial commit's NULL hash lets hasChanged keep returning
    // true on a same-hash retry — the failed chunks get a second chance.
    // The previous implementation stamped the incoming hash, which made
    // hasChanged return false and prevent the retry.
    const text = 'First chunk content here long enough.\n\nSecond chunk content here long enough.\n\nThird chunk content here long enough.';
    let i = 0;
    const provider = {
      generateText: async () => {
        const idx = i++;
        if (idx === 1) return makeBadJson();
        return JSON.stringify({
          facts: [{ title: `Fact ${idx}`, body: `body ${idx}`, tags: [], confidence: 'certain' }],
        });
      },
    };
    const wiki = await freshWiki(provider);
    const sourceRef = 'doc://same-hash';
    const sourceHash = sourceHashFor(20);

    // First attempt: partial (chunk 1 fails).
    const result = await wiki.ingestDocument('e_samehash', {
      sourceRef,
      sourceHash,
      documentChunk: text,
      maxChunkLength: 50,
      chunkOverlap: 0,
    });
    expect(result.failedChunks).toBe(1);
    expect(result.ingestedChunks).toBe(2);

    // Same hash, no full commit yet: hasChanged must still return true so a
    // retry of the same content re-attempts the failed chunk.
    await expect(wiki.hasChanged('e_samehash', sourceRef, sourceHash)).resolves.toBe(true);
  });
});
