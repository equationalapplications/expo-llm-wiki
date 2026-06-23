import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OntologyService } from '../../src/services/OntologyService';
import type { MetadataRepository } from '../../src/repositories/MetadataRepository';
import type { EdgeRepository } from '../../src/repositories/EdgeRepository';
import type { OntologyManifest } from '../../src/types';

const manifest: OntologyManifest = {
  node_types: [{ type: 'person', description: 'An individual.' }],
  edge_types: [],
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
  });

  describe('mergeEmergentUpdates', () => {
    it('updates cache after merge', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const merged = {
        node_types: [...manifest.node_types, { type: 'vendor', description: 'V' }],
        edge_types: [],
      };
      vi.mocked(metadataRepo.mergeManifestUpdates).mockResolvedValue(merged);
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'emergent', manifest: merged });
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const tx = {} as any;
      const result = await svc.mergeEmergentUpdates('entity1', { node_types: [{ type: 'vendor', description: 'V' }] }, tx);
      expect(result).toEqual(merged);
      const cached = await svc.getEffectiveState('entity1');
      expect(cached.manifest).toEqual(merged);
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
