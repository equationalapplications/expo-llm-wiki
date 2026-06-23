import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OntologyService } from '../../src/services/OntologyService';
import type { MetadataRepository } from '../../src/repositories/MetadataRepository';
import type { EdgeRepository } from '../../src/repositories/EdgeRepository';
import type { OntologyManifest } from '../../src/types';

const manifest: OntologyManifest = {
  node_types: [{ type: 'person', description: 'An individual.' }],
  edge_types: [],
};

const edgeManifest: OntologyManifest = {
  node_types: [
    { type: 'Person', description: 'An individual.' },
    { type: 'project', description: 'A project.' },
  ],
  edge_types: [
    { type: 'Reports_To', source_type: 'person', target_type: 'Person', description: 'Hierarchy.' },
  ],
};

function makeMocks() {
  const metadataRepo = {
    getManifest: vi.fn(),
    setManifest: vi.fn(),
    mergeManifestUpdates: vi.fn(),
  } as unknown as MetadataRepository;

  const edgeRepo = {
    addIgnoreDuplicate: vi.fn(),
  } as unknown as EdgeRepository;

  return { metadataRepo, edgeRepo };
}

describe('OntologyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveMode', () => {
    it('prefers stored mode over config default', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo, { mode: 'emergent' });
      expect(svc.resolveMode('strict')).toBe('strict');
    });

    it('falls back to config then off', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo, { mode: 'strict' });
      expect(svc.resolveMode()).toBe('strict');
      const offSvc = new OntologyService(metadataRepo, edgeRepo);
      expect(offSvc.resolveMode()).toBe('off');
    });
  });

  describe('getEffectiveState', () => {
    it('returns DB row when present', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'strict', manifest });
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const state = await svc.getEffectiveState('entity1');
      expect(state).toEqual({ mode: 'strict', manifest });
    });

    it('bootstraps from seedManifests when no DB row', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue(null);
      const svc = new OntologyService(metadataRepo, edgeRepo, {
        mode: 'strict',
        seedManifests: { entity1: { manifest, mode: 'strict' } },
      });
      const tx = {} as any;
      const state = await svc.getEffectiveState('entity1', tx);
      expect(state).toEqual({ mode: 'strict', manifest });
      expect(metadataRepo.setManifest).toHaveBeenCalledWith('entity1', { mode: 'strict', manifest }, tx);
    });

    it('persists seed on transactional read after non-transactional preview', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue(null);
      const svc = new OntologyService(metadataRepo, edgeRepo, {
        mode: 'strict',
        seedManifests: { entity1: { manifest, mode: 'strict' } },
      });
      const preview = await svc.getEffectiveState('entity1');
      expect(preview).toEqual({ mode: 'strict', manifest });
      expect(metadataRepo.setManifest).not.toHaveBeenCalled();

      const tx = {} as any;
      const persisted = await svc.getEffectiveState('entity1', tx);
      expect(persisted).toEqual({ mode: 'strict', manifest });
      expect(metadataRepo.setManifest).toHaveBeenCalledWith('entity1', { mode: 'strict', manifest }, tx);
    });

    it('caches seed state on non-transactional reads', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue(null);
      const svc = new OntologyService(metadataRepo, edgeRepo, {
        seedManifests: { entity1: { manifest, mode: 'strict' } },
      });
      await svc.getEffectiveState('entity1');
      await svc.getEffectiveState('entity1');
      expect(metadataRepo.getManifest).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildPromptContext', () => {
    it('returns null when mode is off', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue(null);
      const svc = new OntologyService(metadataRepo, edgeRepo);
      expect(await svc.buildPromptContext('entity1')).toBeNull();
    });

    it('returns appendix when mode is strict', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'strict', manifest });
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const ctx = await svc.buildPromptContext('entity1');
      expect(ctx).not.toBeNull();
      expect(ctx!.ontologyModeInstructions).toContain('STRICT MODE');
    });
  });

  describe('validateAndNormalizeFact', () => {
    it('normalizes okf_type casing from manifest', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const result = svc.validateAndNormalizeFact(
        { title: 'T', body: 'B', tags: [], confidence: 'certain', okf_type: 'Person' },
        manifest,
      );
      expect(result.okf_type).toBe('person');
    });

    it('returns null okf_type for unknown types', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const result = svc.validateAndNormalizeFact(
        { title: 'T', body: 'B', tags: [], confidence: 'certain', okf_type: 'unknown' },
        manifest,
      );
      expect(result).toEqual({ okf_type: null, edges: [] });
    });

    it('keeps valid okf_type while dropping invalid edges', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const result = svc.validateAndNormalizeFact(
        {
          title: 'T',
          body: 'B',
          tags: [],
          confidence: 'certain',
          okf_type: 'person',
          edges: [{ edge_type: 'unknown_edge', target_title: 'Bob' }],
        },
        edgeManifest,
      );
      expect(result).toEqual({ okf_type: 'Person', edges: [] });
    });
  });

  describe('resolveAndPersistEdges', () => {
    it('persists canonical edge types with case-insensitive manifest matching', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const titleIndex = new Map([
        ['bob smith', { id: 'fact_bob', okf_type: 'person' }],
      ]);
      const tx = {} as any;

      await svc.resolveAndPersistEdges(
        'entity1',
        'fact_alice',
        'Person',
        [{ edge_type: 'reports_to', target_title: 'Bob Smith' }],
        edgeManifest,
        titleIndex,
        tx,
        1,
      );

      expect(edgeRepo.addIgnoreDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({
          source_id: 'fact_alice',
          target_id: 'fact_bob',
          edge_type: 'Reports_To',
        }),
        tx,
      );
    });
  });

  describe('mergeEmergentUpdates', () => {
    it('invalidates cache so post-rollback reads reflect DB state', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const original = { mode: 'emergent' as const, manifest };
      const merged = {
        node_types: [...manifest.node_types, { type: 'vendor', description: 'V' }],
        edge_types: [],
      };
      vi.mocked(metadataRepo.getManifest).mockResolvedValue(original);
      const svc = new OntologyService(metadataRepo, edgeRepo);
      await svc.getEffectiveState('entity1');

      vi.mocked(metadataRepo.mergeManifestUpdates).mockResolvedValue(merged);
      const tx = {} as any;
      await svc.mergeEmergentUpdates('entity1', { node_types: [{ type: 'vendor', description: 'V' }] }, tx);

      vi.mocked(metadataRepo.getManifest).mockResolvedValue(original);
      const state = await svc.getEffectiveState('entity1');
      expect(state.manifest).toEqual(manifest);
    });
  });

  describe('invalidateCache', () => {
    it('forces re-fetch from DB after invalidation', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'strict', manifest });
      const svc = new OntologyService(metadataRepo, edgeRepo);
      await svc.getEffectiveState('entity1');
      expect(metadataRepo.getManifest).toHaveBeenCalledTimes(1);

      svc.invalidateCache('entity1');
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'emergent', manifest });
      const state = await svc.getEffectiveState('entity1');
      expect(metadataRepo.getManifest).toHaveBeenCalledTimes(2);
      expect(state.mode).toBe('emergent');
    });
  });
});
