import { describe, it, expect } from 'vitest';
import {
  emptyManifest,
  normalizeTitleKey,
  resolveNodeType,
  validateManifest,
  mergeOntologyUpdates,
  validateInlineEdges,
  resolveEdgeDefinitions,
  typeSatisfies,
} from '../../src/utils/ontology';
import { WikiStrictOntologyViolation } from '../../src/index';
import type { OntologyManifest, OntologyNodeType } from '../../src/types';

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

const locationManifest: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'x' },
    { type: 'event', description: 'x' },
    { type: 'organization', description: 'x' },
    { type: 'place', description: 'x' },
  ],
  edge_types: [
    { type: 'location', source_type: 'event', target_type: 'place', description: 'x' },
    { type: 'location', source_type: 'organization', target_type: 'place', description: 'x' },
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

  it('validateManifest rejects one edge name spelled with different casing across triples', () => {
    expect(() => validateManifest({
      node_types: polyManifest.node_types,
      edge_types: [
        { type: 'about', source_type: 'creativework', target_type: 'person', description: 'a' },
        { type: 'About', source_type: 'creativework', target_type: 'place', description: 'b' },
      ],
    })).toThrow('Inconsistent casing for edge type: About conflicts with about');
  });

  it('mergeOntologyUpdates canonicalizes a new triple to the existing edge name casing', () => {
    const merged = mergeOntologyUpdates(manifest, {
      edge_types: [{ type: 'Reports_To', source_type: 'person', target_type: 'project', description: 'Project lead.' }],
    });
    expect(merged.edge_types).toHaveLength(2);
    expect(merged.edge_types[1].type).toBe('reports_to');
    expect(() => validateManifest(merged)).not.toThrow();
  });

  it('mergeOntologyUpdates canonicalizes casing within a single batch of new edges', () => {
    const merged = mergeOntologyUpdates(manifest, {
      edge_types: [
        { type: 'ownedBy', source_type: 'project', target_type: 'person', description: 'a' },
        { type: 'ownedby', source_type: 'person', target_type: 'project', description: 'b' },
      ],
    });
    expect(merged.edge_types.filter(e => e.type === 'ownedBy')).toHaveLength(2);
    expect(() => validateManifest(merged)).not.toThrow();
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

  it('resolveEdgeDefinitions returns all case-insensitive name matches', () => {
    const defs = resolveEdgeDefinitions('About', polyManifest);
    expect(defs).toHaveLength(4);
    expect(defs.every(d => d.type === 'about')).toBe(true);
    expect(resolveEdgeDefinitions('missing', polyManifest)).toEqual([]);
    expect(resolveEdgeDefinitions('  ', polyManifest)).toEqual([]);
  });

  it('validateInlineEdges keeps an edge when any definition matches name + source', () => {
    const edges = validateInlineEdges(
      'Organization',
      null,
      [{ edge_type: 'Location', target_title: 'HQ Building' }],
      locationManifest,
    );
    expect(edges).toEqual([{ edge_type: 'location', target_title: 'HQ Building' }]);
  });

  it('validateInlineEdges drops an edge when only the name matches (wrong source)', () => {
    const edges = validateInlineEdges(
      'person',
      null,
      [{ edge_type: 'location', target_title: 'HQ Building' }],
      locationManifest,
    );
    expect(edges).toEqual([]);
  });
});

describe('validateInlineEdges strict mode', () => {
  const manifest: OntologyManifest = {
    node_types: [{ type: 'Function', description: '' }, { type: 'Module', description: '' }],
    edge_types: [{ type: 'calls', source_type: 'Function', target_type: 'Function', description: '' }],
  };

  it('throws WikiStrictOntologyViolation on first invalid edge type when strict: true', () => {
    expect(() => validateInlineEdges(
      'Function', null,
      [{ edge_type: 'unmapped', target_title: 'foo' }],
      manifest,
      { strict: true, entityId: 'entity-x' },
    )).toThrow(WikiStrictOntologyViolation);
  });

  it('still silently drops invalid edge when strict: false (default)', () => {
    expect(validateInlineEdges(
      'Function', null,
      [{ edge_type: 'unmapped', target_title: 'foo' }],
      manifest,
    )).toEqual([]);
  });

  it('throws with kind="edge" and the offending type string in the message', () => {
    try {
      validateInlineEdges('Function', null, [{ edge_type: 'unmapped', target_title: 'x' }], manifest, { strict: true, entityId: 'entity-x' });
      throw new Error('expected throw');
    } catch (e) {
      const err = e as WikiStrictOntologyViolation;
      expect(err).toBeInstanceOf(WikiStrictOntologyViolation);
      expect(err.kind).toBe('edge');
      expect(err.type).toBe('unmapped');
      expect(err.entityId).toBe('entity-x');
    }
  });

  it('throws on a non-array edges value under strict mode', () => {
    expect(() => validateInlineEdges(
      'Function', null, 'not-an-array' as unknown as never,
      manifest, { strict: true, entityId: 'entity-x' },
    )).toThrow(WikiStrictOntologyViolation);
  });

  it('still returns [] for a non-array edges value under non-strict mode', () => {
    expect(validateInlineEdges(
      'Function', null, 'not-an-array' as unknown as never,
      manifest,
    )).toEqual([]);
  });
});

const parentManifest: OntologyManifest = {
  node_types: [
    { type: 'creativework', description: 'Parent content type.' },
    { type: 'design_spec', description: 'A design spec.', parent_type: 'creativework' },
    { type: 'software_application', description: 'An app.' },
    // Required: both edge_types below target `person`, and validateManifest
    // rejects an edge whose endpoints are not declared node types.
    { type: 'person', description: 'A person.' },
  ],
  edge_types: [
    { type: 'about', source_type: 'creativework', target_type: 'person', description: 'subject matter' },
    { type: 'assigns', source_type: 'software_application', target_type: 'person', description: 'owner' },
  ],
};

describe('ontology parent inheritance', () => {
  it('validateManifest accepts manifests without any parent_type fields', () => {
    expect(() => validateManifest(manifest)).not.toThrow(); // existing top-level `manifest`
  });

  it('validateManifest accepts a valid parent reference', () => {
    expect(() => validateManifest(parentManifest)).not.toThrow();
  });

  it('validateManifest rejects self-parent (case-insensitive)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent_type: 'Design_Spec' },
      ],
      edge_types: [],
    })).toThrow(/Self-parent/);
  });

  it('validateManifest rejects a parent slug that does not exist', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'design_spec', description: 'x', parent_type: 'nonexistent' },
      ],
      edge_types: [],
    })).toThrow(/Parent type not found/);
  });

  it('validateManifest rejects parent chains deeper than one level (D1)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'thing', description: 'root' },
        { type: 'creativework', description: 'mid', parent_type: 'thing' },
        { type: 'design_spec', description: 'leaf', parent_type: 'creativework' },
      ],
      edge_types: [],
    })).toThrow(/Parent chain too deep/);
  });

  it('validateManifest rejects a two-cycle (caught by the chain check, not self-parent)', () => {
    expect(() => validateManifest({
      node_types: [
        { type: 'a', description: 'x', parent_type: 'b' },
        { type: 'b', description: 'y', parent_type: 'a' },
      ],
      edge_types: [],
    })).toThrow(/Parent chain too deep/);
  });

  it('validateInlineEdges accepts a child source for an edge declared on the parent', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'about', target_title: 'Jane Doe' },
    ], parentManifest);
    expect(valid).toEqual([{ edge_type: 'about', target_title: 'Jane Doe' }]);
  });

  it('validateInlineEdges strict mode does not throw for a parent-matched source', () => {
    expect(() => validateInlineEdges('design_spec', null, [
      { edge_type: 'about', target_title: 'Jane Doe' },
    ], parentManifest, { strict: true, entityId: 'e1' })).not.toThrow();
  });

  it('validateInlineEdges does not accept a child whose parent is a different type', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'assigns', target_title: 'Jane Doe' },
    ], parentManifest);
    expect(valid).toEqual([]); // assigns is declared on software_application, not creativework
  });

  it('validateInlineEdges still rejects unknown edge types', () => {
    const valid = validateInlineEdges('design_spec', null, [
      { edge_type: 'nonexistent_edge', target_title: 'x' },
    ], parentManifest);
    expect(valid).toEqual([]);
  });

  it('resolveNodeType stays exact 1:1 — parent_type is never consulted (D2)', () => {
    expect(resolveNodeType('design_spec', parentManifest)).toBe('design_spec');
    expect(resolveNodeType('CreativeWork', parentManifest)).toBe('creativework');
    expect(resolveNodeType('thing', parentManifest)).toBeNull(); // not in manifest at all
  });

  // D10: absence means "no parent"; present-but-unusable is malformed.
  it.each([['empty string', ''], ['whitespace only', '   ']])(
    'validateManifest rejects a present-but-blank parent_type (%s)',
    (_label, blank) => {
      expect(() => validateManifest({
        node_types: [
          { type: 'creativework', description: 'p' },
          { type: 'design_spec', description: 'x', parent_type: blank },
        ],
        edge_types: [],
      })).toThrow(/must be a non-empty string/);
    },
  );

  // D10: validateManifest runs on JSON.parse output from manifest_json on
  // every read, so a legacy or hand-edited row can hold a non-string. It must
  // surface as a manifest error, never as a bare TypeError from .trim().
  // 0 and false are listed on purpose: a falsy non-string must not slip
  // through a truthiness check into the slug path.
  it.each([['number', 123], ['zero', 0], ['boolean', true], ['false', false],
           ['null', null], ['object', {}], ['array', []]])(
    'validateManifest rejects a non-string parent_type (%s) with a manifest error',
    (_label, bad) => {
      const run = () => validateManifest({
        node_types: [
          { type: 'creativework', description: 'p' },
          { type: 'design_spec', description: 'x', parent_type: bad as unknown as string },
        ],
        edge_types: [],
      });
      expect(run).toThrow(/must be a non-empty string/);
      expect(run).not.toThrow(TypeError);
    },
  );

  it('validateManifest accepts an absent parent_type (D10 — absence is not blankness)', () => {
    expect(() => validateManifest({
      node_types: [{ type: 'design_spec', description: 'x' }],
      edge_types: [],
    })).not.toThrow();
  });

  describe('typeSatisfies', () => {
    it('matches exactly, case- and whitespace-insensitively', () => {
      expect(typeSatisfies('design_spec', 'design_spec', parentManifest)).toBe(true);
      expect(typeSatisfies('Design_Spec', '  design_spec ', parentManifest)).toBe(true);
    });

    it('matches one hop up via parent_type', () => {
      expect(typeSatisfies('creativework', 'design_spec', parentManifest)).toBe(true);
    });

    it('does not match an unrelated declared type', () => {
      expect(typeSatisfies('software_application', 'design_spec', parentManifest)).toBe(false);
    });

    it('does not match downward — a parent does not satisfy its child', () => {
      expect(typeSatisfies('design_spec', 'creativework', parentManifest)).toBe(false);
    });

    it('never recurses (D1): a grandparent is not satisfied', () => {
      // Not a manifest validateManifest would accept — typeSatisfies must still
      // stop at one hop if a chain ever reaches it from a persisted row.
      const chain: OntologyManifest = {
        node_types: [
          { type: 'thing', description: 'root' },
          { type: 'creativework', description: 'mid', parent_type: 'thing' },
          { type: 'design_spec', description: 'leaf', parent_type: 'creativework' },
        ],
        edge_types: [],
      };
      expect(typeSatisfies('creativework', 'design_spec', chain)).toBe(true);
      expect(typeSatisfies('thing', 'design_spec', chain)).toBe(false);
    });

    it('returns false rather than throwing on blank or missing inputs', () => {
      expect(typeSatisfies('creativework', '', parentManifest)).toBe(false);
      expect(typeSatisfies('creativework', '   ', parentManifest)).toBe(false);
      expect(typeSatisfies('', 'design_spec', parentManifest)).toBe(false);
      // node_types is typed non-optional but is JSON.parse'd from a DB row at
      // runtime — the guard must hold for a malformed manifest.
      const noNodes = { edge_types: [] } as unknown as OntologyManifest;
      expect(typeSatisfies('creativework', 'design_spec', noNodes)).toBe(false);
      const malformed = { node_types: [{}], edge_types: [] } as unknown as OntologyManifest;
      expect(typeSatisfies('creativework', 'design_spec', malformed)).toBe(false);
      // Non-string fields must return false, not throw: typeSatisfies runs
      // inside the caller's transaction, so a TypeError here aborts an ingest.
      const badTypes = {
        node_types: [
          { type: 42, description: 'x' },
          { type: 'design_spec', description: 'x', parent_type: 123 },
        ],
        edge_types: [],
      } as unknown as OntologyManifest;
      expect(typeSatisfies('creativework', 'design_spec', badTypes)).toBe(false);
      expect(() => typeSatisfies('creativework', 'design_spec', badTypes)).not.toThrow();
    });
  });
});
