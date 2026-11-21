import { describe, it, expect } from 'vitest';
import { mergeOntologyUpdates, emptyManifest } from '../../src/utils/ontology';
import type { OntologyManifest } from '../../src/types';

describe('merge rejection reporting (ontology-curation Task 6)', () => {
  it('reports duplicate_node_type for an existing slug, merges nothing', () => {
    const current: OntologyManifest = {
      node_types: [{ type: 'person', description: 'a' }],
      edge_types: [],
    };
    const out = mergeOntologyUpdates(current, {
      node_types: [{ type: 'PERSON', description: 'dup' }],
      edge_types: [],
    });
    expect(out.rejected).toEqual(['duplicate_node_type']);
    expect(out.manifest.node_types).toHaveLength(1);
  });

  it('reports invalid_shape for a node with no type', () => {
    const out = mergeOntologyUpdates(emptyManifest(), {
      node_types: [{ description: 'no slug' } as never],
      edge_types: [],
    });
    expect(out.rejected).toEqual(['invalid_shape']);
  });

  it('reports duplicate_edge for an existing triple', () => {
    const current: OntologyManifest = {
      node_types: [{ type: 'person', description: 'a' }],
      edge_types: [{ type: 'knows', source_type: 'person', target_type: 'person', description: 'x' }],
    };
    const out = mergeOntologyUpdates(current, {
      node_types: [],
      edge_types: [{ type: 'knows', source_type: 'person', target_type: 'person', description: 'dup' }],
    });
    expect(out.rejected).toEqual(['duplicate_edge']);
    expect(out.manifest.edge_types).toHaveLength(1);
  });

  it('reports unknown_endpoint for edges referencing absent node types', () => {
    const out = mergeOntologyUpdates(emptyManifest(), {
      node_types: [],
      edge_types: [{ type: 'knows', source_type: 'ghost', target_type: 'phantom', description: '' }],
    });
    expect(out.rejected).toEqual(['unknown_endpoint']);
  });

  it('reports invalid_shape for an edge with a missing field', () => {
    const out = mergeOntologyUpdates(emptyManifest(), {
      node_types: [],
      edge_types: [{ type: 'knows', source_type: 'person', description: '' } as never],
    });
    expect(out.rejected).toEqual(['invalid_shape']);
  });

  it('accepted proposals produce no rejections; a stripped parent is not a rejection', () => {
    const out = mergeOntologyUpdates(emptyManifest(), {
      node_types: [
        { type: 'person', description: 'a' },
        { type: 'child', description: 'b', parent_type: 'ghost' },
      ],
      edge_types: [{ type: 'knows', source_type: 'person', target_type: 'person', description: 'x' }],
    });
    expect(out.rejected).toEqual([]);
    expect(out.manifest.node_types).toHaveLength(2);
    expect(out.manifest.node_types[1].parent_type).toBeUndefined();
  });

  it('each dropped proposal gets its own entry, in order', () => {
    const out = mergeOntologyUpdates(
      { node_types: [{ type: 'person', description: 'a' }], edge_types: [] },
      {
        node_types: [
          { type: '', description: '' } as never,
          { type: 'person', description: 'dup' },
          { type: 'place', description: 'ok' },
        ],
        edge_types: [],
      },
    );
    expect(out.rejected).toEqual(['invalid_shape', 'duplicate_node_type']);
    expect(out.manifest.node_types).toHaveLength(2);
  });
});
