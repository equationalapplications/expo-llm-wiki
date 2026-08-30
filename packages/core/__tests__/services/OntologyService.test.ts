import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OntologyService } from '../../src/services/OntologyService';
import { WikiStrictOntologyViolation } from '../../src/index';
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
    { type: 'place', description: 'A location.' },
  ],
  edge_types: [
    { type: 'Reports_To', source_type: 'person', target_type: 'Person', description: 'Hierarchy.' },
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residency.' },
  ],
};

const polyManifest: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Content.' },
    { type: 'person', description: 'An individual.' },
    { type: 'organization', description: 'An org.' },
    { type: 'place', description: 'A location.' },
    { type: 'event', description: 'An event.' },
    { type: 'product', description: 'A product.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'a' },
    { type: 'about', source_type: 'creativework', target_type: 'organization', description: 'b' },
    { type: 'about', source_type: 'creativework', target_type: 'place', description: 'c' },
    { type: 'about', source_type: 'creativework', target_type: 'event', description: 'd' },
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

    it('appendix explains polymorphic edge rows', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(metadataRepo.getManifest).mockResolvedValue({ mode: 'strict', manifest });
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const ctx = await svc.buildPromptContext('entity1');
      expect(ctx!.ontologyModeInstructions).toContain(
        'An edge_type may appear in the manifest multiple times',
      );
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

    it('throws WikiStrictOntologyViolation on unknown node type when strict: true', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      expect(() =>
        svc.validateAndNormalizeFact(
          { title: 'T', body: 'B', tags: [], confidence: 'certain', okf_type: 'unknown' },
          manifest,
          { strict: true, entityId: 'entity-x' },
        ),
      ).toThrow(WikiStrictOntologyViolation);
    });

    it('throws with kind="node" and the offending type for unknown node types in strict mode', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      try {
        svc.validateAndNormalizeFact(
          { title: 'T', body: 'B', tags: [], confidence: 'certain', okf_type: 'unknown' },
          manifest,
          { strict: true, entityId: 'entity-x' },
        );
        throw new Error('expected throw');
      } catch (e) {
        const err = e as WikiStrictOntologyViolation;
        expect(err).toBeInstanceOf(WikiStrictOntologyViolation);
        expect(err.kind).toBe('node');
        expect(err.type).toBe('unknown');
        expect(err.entityId).toBe('entity-x');
      }
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

    it('returns the number of edges actually persisted', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      vi.mocked(edgeRepo.addIgnoreDuplicate).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const titleIndex = new Map([
        ['alpha', { id: 'fact_a', okf_type: 'place' }],
        ['beta', { id: 'fact_b', okf_type: 'place' }],
      ]);
      const count = await svc.resolveAndPersistEdges(
        'e1', 'fact_src', 'person',
        [
          { edge_type: 'lives_in', target_title: 'Alpha' },
          { edge_type: 'lives_in', target_title: 'Beta' },
          { edge_type: 'lives_in', target_title: 'Missing' }, // unresolved target — skipped
        ],
        edgeManifest, titleIndex, {} as any, 123,
      );
      expect(count).toBe(1); // true + false + skipped
    });

    it('selects the definition whose target_type matches the resolved target okf_type', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      vi.mocked(edgeRepo.addIgnoreDuplicate).mockResolvedValue(true);
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const titleIndex = new Map([
        ['yosemite valley', { id: 'fact_place', okf_type: 'place' }],
      ]);
      const count = await svc.resolveAndPersistEdges(
        'e1', 'fact_doc', 'creativework',
        [{ edge_type: 'about', target_title: 'Yosemite Valley' }],
        polyManifest, titleIndex, {} as any, 1,
      );
      expect(count).toBe(1);
      expect(edgeRepo.addIgnoreDuplicate).toHaveBeenCalledTimes(1);
      expect(edgeRepo.addIgnoreDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ source_id: 'fact_doc', target_id: 'fact_place', edge_type: 'about' }),
        expect.anything(),
      );
    });

    it('skips the edge when the target okf_type matches no definition', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const titleIndex = new Map([
        ['widget', { id: 'fact_prod', okf_type: 'product' }],
      ]);
      const count = await svc.resolveAndPersistEdges(
        'e1', 'fact_doc', 'creativework',
        [{ edge_type: 'about', target_title: 'Widget' }],
        polyManifest, titleIndex, {} as any, 1,
      );
      expect(count).toBe(0);
      expect(edgeRepo.addIgnoreDuplicate).not.toHaveBeenCalled();
    });

    it('skips the edge when the target is untyped', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const titleIndex = new Map([
        ['mystery', { id: 'fact_m', okf_type: null }],
      ]);
      const count = await svc.resolveAndPersistEdges(
        'e1', 'fact_doc', 'creativework',
        [{ edge_type: 'about', target_title: 'Mystery' }],
        polyManifest, titleIndex, {} as any, 1,
      );
      expect(count).toBe(0);
      expect(edgeRepo.addIgnoreDuplicate).not.toHaveBeenCalled();
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

  describe('OntologyService.resolveEdges — parent inheritance', () => {
    const parentEdgeManifest: OntologyManifest = {
      node_types: [
        { type: 'creativework', description: 'Parent.' },
        { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
        { type: 'person', description: 'Person.' },
      ],
      edge_types: [
        { type: 'about', source_type: 'creativework', target_type: 'person', description: 'x' },
      ],
    };

    it('child source type satisfies an edge declared for its parent', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const titleIndex = new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]);
      const edges = svc.resolveEdges(
        'e1', 'f1', 'design_spec',
        [{ edge_type: 'about', target_title: 'Jane Doe' }],
        parentEdgeManifest, titleIndex, 1000,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        entity_id: 'e1', source_id: 'f1', target_id: 'p1', edge_type: 'about',
      });
    });

    it('exact source match and parent-derived match are both candidates; target_type disambiguates', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const manifest: OntologyManifest = {
        node_types: parentEdgeManifest.node_types,
        edge_types: [
          { type: 'about', source_type: 'creativework', target_type: 'person', description: 'parent-def' },
          { type: 'about', source_type: 'design_spec', target_type: 'creativework', description: 'exact-def' },
        ],
      };
      // Target 'person' → parent-def wins; target 'the spec' → exact-def wins.
      const toPerson = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'about', target_title: 'Jane Doe' }], manifest,
        new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]), 1000);
      expect(toPerson[0]?.edge_type).toBe('about');
      expect(toPerson[0]?.target_id).toBe('p1');
      const toWork = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'about', target_title: 'The Spec' }], manifest,
        new Map([['the spec', { id: 'c1', okf_type: 'creativework' }]]), 1000);
      expect(toWork[0]?.target_id).toBe('c1');
    });

    it('resolves a target through its parent_type (D3)', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const manifest: OntologyManifest = {
        node_types: parentEdgeManifest.node_types,
        edge_types: [
          { type: 'supersedes', source_type: 'creativework', target_type: 'creativework', description: 'x' },
        ],
      };
      const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'supersedes', target_title: 'Old Spec' }], manifest,
        new Map([['old spec', { id: 'd0', okf_type: 'design_spec' }]]), 1000);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ target_id: 'd0', edge_type: 'supersedes' });
    });

    it('prefers an exact target def over a parent-derived one, whatever the order', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const rows = [
        { type: 'about', source_type: 'creativework', target_type: 'creativework', description: 'broad' },
        { type: 'about', source_type: 'creativework', target_type: 'design_spec', description: 'narrow' },
      ];
      for (const edge_types of [rows, [...rows].reverse()]) {
        const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
          [{ edge_type: 'about', target_title: 'Other Spec' }],
          { node_types: parentEdgeManifest.node_types, edge_types },
          new Map([['other spec', { id: 'd9', okf_type: 'design_spec' }]]), 1000);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.target_id).toBe('d9');
      }
    });

    it('still skips a target with no okf_type', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'about', target_title: 'Untyped' }], parentEdgeManifest,
        new Map([['untyped', { id: 'u1', okf_type: null }]]), 1000);
      expect(edges).toEqual([]);
    });

    it('validates a seed manifest on both branches of getEffectiveState (D11)', async () => {
      const danglingSeed = {
        mode: 'strict' as const,
        manifest: {
          node_types: [{ type: 'design_spec', description: 'x', parent_type: 'nonexistent' }],
          edge_types: [],
        },
      };
      const make = () => {
        const { metadataRepo, edgeRepo } = makeMocks();
        // No persisted row, so getEffectiveState falls through to the seed.
        (metadataRepo.getManifest as any).mockResolvedValue(null);
        return new OntologyService(metadataRepo, edgeRepo, { seedManifests: { e1: danglingSeed } } as any);
      };
      // no-tx branch: previously did a bare cache.set and never validated.
      await expect(make().getEffectiveState('e1')).rejects.toThrow(/Parent type not found/);
      // tx branch: validated via setManifest, but must not depend on that.
      await expect(make().getEffectiveState('e1', {} as any)).rejects.toThrow(/Parent type not found/);
    });

    it('accepts a valid parent-bearing seed on both branches (D11 regression guard)', async () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      (metadataRepo.getManifest as any).mockResolvedValue(null);
      const svc = new OntologyService(metadataRepo, edgeRepo, {
        seedManifests: { e1: { mode: 'strict' as const, manifest: parentEdgeManifest } },
      } as any);
      await expect(svc.getEffectiveState('e1')).resolves.toMatchObject({ mode: 'strict' });
    });

    it('child source does not satisfy an edge declared on an unrelated type', () => {
      const { metadataRepo, edgeRepo } = makeMocks();
      const svc = new OntologyService(metadataRepo, edgeRepo);
      const manifest: OntologyManifest = {
        node_types: [
          { type: 'creativework', description: 'Parent.' },
          { type: 'software_application', description: 'App.' },
          { type: 'design_spec', description: 'Child.', parent_type: 'creativework' },
          { type: 'person', description: 'Person.' },
        ],
        edge_types: [
          { type: 'assigns', source_type: 'software_application', target_type: 'person', description: 'x' },
        ],
      };
      const edges = svc.resolveEdges('e1', 'f1', 'design_spec',
        [{ edge_type: 'assigns', target_title: 'Jane Doe' }], manifest,
        new Map([['jane doe', { id: 'p1', okf_type: 'person' }]]), 1000);
      expect(edges).toEqual([]);
    });
  });
});
