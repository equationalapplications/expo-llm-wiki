import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  normalizeTitleKey,
  resolveNodeType,
  validateManifest,
  mergeOntologyUpdates,
} from '../../src/utils/ontology';
import type { OntologyManifest } from '../../src/types';

const manifest: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'An individual.' },
    { type: 'project', description: 'A project.' },
  ],
  edge_types: [
    { type: 'reports_to', source_type: 'person', target_type: 'person', description: 'Hierarchy.' },
  ],
};

describe('ontology utils', () => {
  it('normalizeTitleKey lowercases and collapses whitespace', () => {
    expect(normalizeTitleKey('  Jane   Doe ')).toBe('jane doe');
  });

  it('resolveNodeType is case-insensitive and returns canonical casing', () => {
    expect(resolveNodeType('Person', manifest)).toBe('person');
    expect(resolveNodeType('unknown', manifest)).toBeNull();
  });

  it('validateManifest rejects edge types with unknown endpoints', () => {
    expect(() => validateManifest({
      node_types: [{ type: 'person', description: 'x' }],
      edge_types: [{ type: 'bad', source_type: 'person', target_type: 'missing', description: 'y' }],
    })).toThrow();
  });

  it('mergeOntologyUpdates is append-only by type slug', () => {
    const merged = mergeOntologyUpdates(manifest, {
      node_types: [
        { type: 'person', description: 'ignored duplicate' },
        { type: 'vendor', description: 'New.' },
      ],
    });
    expect(merged.node_types).toHaveLength(3);
    expect(merged.node_types.find(n => n.type === 'person')?.description).toBe('An individual.');
    expect(merged.node_types.find(n => n.type === 'vendor')).toBeDefined();
  });

  it('emptyManifest returns empty arrays', () => {
    expect(emptyManifest()).toEqual({ node_types: [], edge_types: [] });
  });
});
