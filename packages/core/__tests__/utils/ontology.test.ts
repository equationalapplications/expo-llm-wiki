import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  normalizeTitleKey,
  resolveNodeType,
  validateManifest,
  mergeOntologyUpdates,
  validateInlineEdges,
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

  it('validateManifest rejects case-insensitive duplicate node types', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'person', description: 'a' },
        { type: 'Person', description: 'b' },
      ],
      edge_types: [],
    })).toThrow(/Duplicate node type/);
  });

  it('mergeOntologyUpdates treats types case-insensitively', () => {
    const merged = mergeOntologyUpdates(manifest, {
      node_types: [{ type: 'Person', description: 'ignored duplicate' }],
    });
    expect(merged.node_types).toHaveLength(2);
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

  it('validateInlineEdges matches edge definitions case-insensitively', () => {
    const mixedCaseManifest: OntologyManifest = {
      node_types: [
        { type: 'Person', description: 'An individual.' },
        { type: 'project', description: 'A project.' },
      ],
      edge_types: [
        { type: 'Reports_To', source_type: 'person', target_type: 'Person', description: 'Hierarchy.' },
      ],
    };
    const edges = validateInlineEdges(
      'Person',
      null,
      [{ edge_type: 'reports_to', target_title: 'Bob Smith' }],
      mixedCaseManifest,
    );
    expect(edges).toEqual([{ edge_type: 'Reports_To', target_title: 'Bob Smith' }]);
  });
});
