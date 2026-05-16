import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaintenanceService } from '../../src/services/MaintenanceService';
import { PromptService } from '../../src/services/PromptService';
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
      upsert: vi.fn().mockResolvedValue(undefined),
      markOrphaned: vi.fn().mockResolvedValue([]),
      downgradeStaleInferred: vi.fn().mockResolvedValue(undefined),
      downgradeByIds: vi.fn().mockResolvedValue(undefined),
      softDeleteByIds: vi.fn().mockResolvedValue(undefined),
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

  function makeService(promptService: PromptService) {
    return new MaintenanceService(
      mockDb, 'llm_wiki_', mockOptions,
      mockEntryRepo, mockTaskRepo, mockEventRepo, mockMetadataRepo,
      mockSearchService, mockJobManager, mockEmbeddingService,
      promptService,
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
      await svc.doRunHeal('entity1', 'custom heal override');
      expect(mockOptions.llmProvider.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'custom heal override' })
      );
    });
  });
});
