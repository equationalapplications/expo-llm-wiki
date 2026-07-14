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

const polyManifest: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Content.' },
    { type: 'person', description: 'An individual.' },
    { type: 'organization', description: 'An org.' },
    { type: 'place', description: 'A location.' },
    { type: 'event', description: 'An event.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'a' },
    { type: 'about', source_type: 'creativework', target_type: 'organization', description: 'b' },
    { type: 'about', source_type: 'creativework', target_type: 'place', description: 'c' },
    { type: 'about', source_type: 'creativework', target_type: 'event', description: 'd' },
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

  it('mergeOntologyUpdates adds a new source/target variant of an existing edge name', () => {
    const merged = mergeOntologyUpdates(manifest, {
      edge_types: [{ type: 'reports_to', source_type: 'person', target_type: 'project', description: 'Project lead.' }],
    });
    expect(merged.edge_types).toHaveLength(2);
    expect(merged.edge_types[1]).toEqual({
      type: 'reports_to', source_type: 'person', target_type: 'project', description: 'Project lead.',
    });
  });

  it('mergeOntologyUpdates skips an exact-triple duplicate case-insensitively', () => {
    const merged = mergeOntologyUpdates(manifest, {
      edge_types: [{ type: 'Reports_To', source_type: 'Person', target_type: 'PERSON', description: 'dup' }],
    });
    expect(merged.edge_types).toHaveLength(1);
  });

  it('validateManifest accepts one property name with distinct source/target triples', () => {
    expect(() => validateManifest(polyManifest)).not.toThrow();
  });

  it('validateManifest rejects an exact duplicate triple case-insensitively with the triple message', () => {
    expect(() => validateManifest({
      node_types: polyManifest.node_types,
      edge_types: [
        { type: 'about', source_type: 'creativework', target_type: 'person', description: 'a' },
        { type: 'About', source_type: 'CreativeWork', target_type: 'Person', description: 'b' },
      ],
    })).toThrow('Duplicate edge definition: About (CreativeWork → Person)');
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
