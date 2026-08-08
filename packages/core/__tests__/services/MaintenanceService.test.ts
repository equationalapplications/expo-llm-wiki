import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaintenanceService } from '../../src/services/MaintenanceService';
import { PromptService } from '../../src/services/PromptService';
import { OntologyService } from '../../src/services/OntologyService';
import { MetadataRepository } from '../../src/repositories/MetadataRepository';
import { EdgeRepository } from '../../src/repositories/EdgeRepository';
import { EntryRepository } from '../../src/repositories/EntryRepository';
import { OutboxRepository } from '../../src/repositories/OutboxRepository';
import { MIGRATIONS } from '../../src/db/migrations';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT } from '../../src/prompts';

describe('MaintenanceService — PromptService injection', () => {
  let mockDb: any;
  let mockOptions: any;
  let mockEntryRepo: any;
  let mockTaskRepo: any;
  let mockEventRepo: any;
  let mockMetadataRepo: any;
  let mockSearchService: any;
  let mockJobManager: any;
  let mockEmbeddingService: any;

  const librarianResponse = JSON.stringify({ facts: [], tasks: [] });
  const healResponse = JSON.stringify({ downgraded: [], deleted: [], newFacts: [] });

  beforeEach(() => {
    mockDb = {
      withTransactionAsync: vi.fn(async (fn: (tx: any) => Promise<void>) => fn(mockDb)),
      runAsync: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowId: 0 }),
    };
    mockOptions = { llmProvider: { generateText: vi.fn() } };
    mockEntryRepo = {
      findRecentByEntityId: vi.fn().mockResolvedValue([]),
      findAllByEntityId: vi.fn().mockResolvedValue([]),
      // At least one heal candidate so runHeal/doRunHeal issue a generateText
      // call — these tests exercise prompt routing, not heal semantics.
      findHealCandidatesByEntityId: vi.fn().mockResolvedValue([{
        id: 'fact1', entity_id: 'entity1', title: 'title fact1', body: 'body fact1', tags: '[]',
        confidence: 'inferred', source_type: 'librarian_inferred', source_hash: null, source_ref: null,
        created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null,
      }]),
      findAnchorRowsByIds: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
      markOrphaned: vi.fn().mockResolvedValue([]),
      downgradeStaleInferred: vi.fn().mockResolvedValue([]),
      downgradeByIds: vi.fn().mockResolvedValue(undefined),
      softDeleteByIds: vi.fn().mockResolvedValue(undefined),
      countHealCandidatesByEntityId: vi.fn().mockResolvedValue({ eligible: 0, deferred: 0 }),
      markHealChecked: vi.fn().mockResolvedValue(undefined),
      findInferredTitlesByEntityId: vi.fn().mockResolvedValue([]),
    };
    mockTaskRepo = {
      findAllPending: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    mockEventRepo = {
      getRecent: vi.fn().mockResolvedValue([]),
    };
    mockMetadataRepo = {};
    mockSearchService = {
      sync: vi.fn().mockResolvedValue(undefined),
      evictCache: vi.fn(),
      searchKeyword: vi.fn().mockReturnValue([]),
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

  function makeService(promptService: PromptService, ontologyService?: OntologyService) {
    return new MaintenanceService(
      mockDb, 'llm_wiki_', mockOptions,
      mockEntryRepo, { softDeleteByEntityAndSourceRef: vi.fn().mockResolvedValue(0) } as any,
      mockTaskRepo, mockEventRepo, mockMetadataRepo,
      mockSearchService, mockJobManager, mockEmbeddingService,
      promptService,
      ontologyService,
    );
  }

  describe('runLibrarian', () => {
    it('uses base LIBRARIAN_SYSTEM_PROMPT by default', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(librarianResponse);
      const svc = makeService(new PromptService());
      await svc.runLibrarian('entity1');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: LIBRARIAN_SYSTEM_PROMPT })
      );
    });

    it('uses global librarianSystemPrompt override', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(librarianResponse);
      const svc = makeService(new PromptService({ librarianSystemPrompt: 'global lib' }));
      await svc.runLibrarian('entity1');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'global lib' })
      );
    });

    it('uses runtime promptOverride over global', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(librarianResponse);
      const svc = makeService(new PromptService({ librarianSystemPrompt: 'global lib' }));
      await svc.runLibrarian('entity1', { promptOverride: 'runtime lib' });
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'runtime lib' })
      );
    });
  });

  describe('runHeal', () => {
    it('uses base HEAL_SYSTEM_PROMPT by default', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(healResponse);
      const svc = makeService(new PromptService());
      await svc.runHeal('entity1');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: HEAL_SYSTEM_PROMPT })
      );
    });

    it('uses global healSystemPrompt override', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(healResponse);
      const svc = makeService(new PromptService({ healSystemPrompt: 'global heal' }));
      await svc.runHeal('entity1');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'global heal' })
      );
    });

    it('uses runtime promptOverride over global', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(healResponse);
      const svc = makeService(new PromptService({ healSystemPrompt: 'global heal' }));
      await svc.runHeal('entity1', { promptOverride: 'runtime heal' });
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'runtime heal' })
      );
    });
  });

  describe('doRunLibrarian', () => {
    it('accepts promptOverride and passes it to PromptService', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(librarianResponse);
      const svc = makeService(new PromptService());
      await svc.doRunLibrarian('entity1', 'custom lib override');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'custom lib override' })
      );
    });
  });

  describe('doRunHeal', () => {
    it('accepts promptOverride and passes it to PromptService', async () => {
      mockOptions.llmProvider.generateText.mockResolvedValue(healResponse);
      const svc = makeService(new PromptService());
      await svc.doRunHeal('entity1', { promptOverride: 'custom heal override' });
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'custom heal override' })
      );
    });
  });
});

describe('MaintenanceService — ontology integration', () => {
  const PREFIX = 'llm_wiki_';

  it('persists normalized okf_type from LLM response under strict manifest', async () => {
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const outboxMigration = MIGRATIONS.find(m => m.version === 4);
    if (outboxMigration) await outboxMigration.run(db, PREFIX);
    const metadataRepo = new MetadataRepository(db, PREFIX);
    const edgeRepo = new EdgeRepository(db, PREFIX);
    const outboxRepo = new OutboxRepository(db, PREFIX, true);
    const entryRepo = new EntryRepository(db, PREFIX, outboxRepo);
    const ontologyService = new OntologyService(metadataRepo, edgeRepo, { mode: 'strict' });

    await db.withTransactionAsync(async (tx) => {
      await metadataRepo.setManifest('entity1', {
        mode: 'strict',
        manifest: {
          node_types: [{ type: 'person', description: 'An individual.' }],
          edge_types: [],
        },
      }, tx);
    });

    const librarianResponse = JSON.stringify({
      facts: [{
        title: 'Jane leads team',
        body: 'Jane is the team lead.',
        tags: [],
        confidence: 'inferred',
        okf_type: 'Person',
        edges: [],
      }],
      tasks: [],
    });

    const mockTaskRepo = { upsert: vi.fn().mockResolvedValue(undefined) };
    const mockEventRepo = { getRecent: vi.fn().mockResolvedValue([]) };
    const mockSearchService = { sync: vi.fn(), evictCache: vi.fn() };
    const mockJobManager = { acquireLock: vi.fn(), releaseLock: vi.fn() };
    const mockEmbeddingService = { embedFact: vi.fn().mockResolvedValue(true) };

    const svc = new MaintenanceService(
      db, PREFIX,
      { llmProvider: { generateText: vi.fn().mockResolvedValue(librarianResponse) } },
      entryRepo,
      { softDeleteByEntityAndSourceRef: vi.fn().mockResolvedValue(0) } as any,
      mockTaskRepo as any,
      mockEventRepo as any,
      metadataRepo,
      mockSearchService as any,
      mockJobManager as any,
      mockEmbeddingService as any,
      new PromptService(),
      ontologyService,
    );

    await svc.doRunLibrarian('entity1');

    const facts = await entryRepo.findRecentByEntityId('entity1', 10);
    expect(facts).toHaveLength(1);
    expect(facts[0].okf_type).toBe('person');
  });
});
