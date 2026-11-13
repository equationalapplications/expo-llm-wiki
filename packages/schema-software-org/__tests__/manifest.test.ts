import { describe, it, expect } from 'vitest';
import { validateManifest } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';
import { schemaSoftwareOrgManifest } from '../src/index';

/**
 * Intentional divergences from the warm-agent original. Every entry needs
 * a reason. Anything not listed here must match byte-for-byte (D2).
 */
const INTENTIONAL_NODE_OVERRIDES: Record<string, string> = {
  // D8: upstream says "Covers electronics, vehicles, household items, and
  // software", which pulls the organization's own repositories into
  // `product`. This row drops that clause and hands off to
  // software_application/service.
  product:
    'A physical item, software tool, or device owned or under consideration. '
    + 'Covers electronics, vehicles, and household items. For software the '
    + 'organization builds, ships, or maintains, use software_application '
    + 'instead; for a hosted capability it consumes or operates, use service.',
};

describe('schemaSoftwareOrgManifest', () => {
  it('passes core validateManifest', () => {
    expect(() => validateManifest(schemaSoftwareOrgManifest)).not.toThrow();
  });
});

// Single-source lookup for description-substring assertions across describes.
const descriptionOf = (slug: string) => {
  const node = schemaSoftwareOrgManifest.node_types.find(n => n.type === slug);
  expect(node, slug).toBeDefined();
  return node!.description;
};

describe('warm-agent parity (D2)', () => {
  const manifestByType = new Map(
    schemaSoftwareOrgManifest.node_types.map(n => [n.type, n]),
  );

  for (const original of schemaOrgWarmAgentManifest.node_types) {
    it(`node "${original.type}" tracks the warm-agent original`, () => {
      const copied = manifestByType.get(original.type);
      expect(copied).toBeDefined();
      const override = INTENTIONAL_NODE_OVERRIDES[original.type];
      if (override) {
        // A stale exception that no longer diverges would silently mask
        // real drift, so assert the divergence is still real.
        expect(original.description).not.toBe(override);
        expect(copied!.description).toBe(override);
      } else {
        expect(copied).toEqual(original);
      }
      expect(copied!.parent_type).toBeUndefined();
    });
  }

  it('every override still names an upstream type', () => {
    const upstream = new Set(schemaOrgWarmAgentManifest.node_types.map(n => n.type));
    for (const slug of Object.keys(INTENTIONAL_NODE_OVERRIDES)) {
      expect(upstream.has(slug)).toBe(true);
    }
  });

  it('warm-agent edges are copied with no exceptions', () => {
    // Order is part of the contract: `copied` preserves this manifest's order,
    // so this fails on any reshuffle of the warm block, not just on
    // description drift. Keep the 28 warm rows first and in upstream order.
    const triples = new Set(schemaOrgWarmAgentManifest.edge_types.map(
      e => `${e.type}|${e.source_type}|${e.target_type}`));
    const copied = schemaSoftwareOrgManifest.edge_types.filter(
      e => triples.has(`${e.type}|${e.source_type}|${e.target_type}`));
    expect(copied).toEqual(schemaOrgWarmAgentManifest.edge_types);
  });

  it('no stale rows are left behind if upstream removed one', () => {
    // Reverse audit of the test above. The filter checks the upstream rows it
    // knows about and silently drops any row that is no longer upstream. This
    // assertion catches the inverse: a total length that drops (upstream
    // shrank) or grows (a stale row got resurrected) without affecting the
    // 28 warm-agent rows the filter compares.
    expect(schemaSoftwareOrgManifest.edge_types).toHaveLength(
      schemaOrgWarmAgentManifest.edge_types.length + 14,
    );
  });
});

describe('shape and counts', () => {
  it('ships exactly the 21 declared node types', () => {
    expect(new Set(schemaSoftwareOrgManifest.node_types.map(n => n.type))).toEqual(
      new Set([
        // 9 warm-agent (D2)
        'person', 'organization', 'place', 'event', 'project', 'action',
        'creativework', 'review', 'product',
        // 3 software-org base types (D5)
        'software_application', 'service', 'role',
        // 3 software-org creativework subtypes
        'design_spec', 'procedure', 'reference_doc',
        // statement (abstract), its four kinds, and area
        'statement', 'rule', 'decision', 'lesson', 'trap', 'area',
      ]),
    );
  });

  it('has exactly 21 node types and 42 edge types', () => {
    expect(schemaSoftwareOrgManifest.node_types).toHaveLength(21);
    expect(schemaSoftwareOrgManifest.edge_types).toHaveLength(42);
  });

  it('has no duplicate node slugs', () => {
    const slugs = schemaSoftwareOrgManifest.node_types.map(n => n.type);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has unique (type, source, target) edge triples', () => {
    const triples = schemaSoftwareOrgManifest.edge_types.map(
      e => `${e.type}|${e.source_type}|${e.target_type}`);
    expect(new Set(triples).size).toBe(triples.length);
  });

  it('resolves every parent_type to a top-level node (one level — D5)', () => {
    const byType = new Map(schemaSoftwareOrgManifest.node_types.map(n => [n.type, n]));
    for (const node of schemaSoftwareOrgManifest.node_types) {
      if (node.parent_type === undefined) continue;
      const parent = byType.get(node.parent_type);
      expect(parent, `parent of ${node.type}`).toBeDefined();
      expect(parent!.parent_type, `${node.parent_type} must be top-level`).toBeUndefined();
    }
  });

  it('every edge endpoint exists in the node list', () => {
    const nodes = new Set(schemaSoftwareOrgManifest.node_types.map(n => n.type));
    for (const e of schemaSoftwareOrgManifest.edge_types) {
      expect(nodes.has(e.source_type), `${e.type} source ${e.source_type}`).toBe(true);
      expect(nodes.has(e.target_type), `${e.type} target ${e.target_type}`).toBe(true);
    }
  });

  it('every node and edge has a non-empty description', () => {
    for (const n of schemaSoftwareOrgManifest.node_types) {
      expect(n.description.length, n.type).toBeGreaterThan(0);
    }
    for (const e of schemaSoftwareOrgManifest.edge_types) {
      expect(e.description.length, e.type).toBeGreaterThan(0);
    }
  });
});

describe('property conventions (D3)', () => {
  it.each([
    ['software_application', ['repo_url', 'version', 'install_path', 'status']],
    ['service', ['provider', 'dashboard_url', 'status', 'tier']],
    ['role', ['role_name', 'scope', 'capabilities']],
    ['design_spec', ['status', 'spec_for', 'branch']],
    ['procedure', ['trigger', 'last_reviewed', 'applies_to']],
    ['reference_doc', ['source_url', 'application']],
    ['area', ['name', 'patterns_file']],
  ])('%s lists its expected frontmatter properties', (slug, props) => {
    const description = descriptionOf(slug as string);
    for (const prop of props as string[]) {
      expect(description, `${slug} should mention ${prop}`).toContain(prop);
    }
  });
});

describe('statement kinds', () => {
  const KINDS: Record<string, string> = {
    rule: 'A situation, and what to do in it.',
    decision: 'What was chosen, what was rejected, and why.',
    lesson: 'What went wrong, and what to do differently.',
    trap: 'A likely wrong assumption, and the fact that corrects it.',
  };
  const nodes = schemaSoftwareOrgManifest.node_types;
  const edges = schemaSoftwareOrgManifest.edge_types;

  it('drops handoff and session_recap and the handoffFor rows', () => {
    expect(nodes.find(n => n.type === 'handoff')).toBeUndefined();
    expect(nodes.find(n => n.type === 'session_recap')).toBeUndefined();
    expect(edges.filter(e => e.type === 'handoffFor')).toHaveLength(0);
  });

  it('the four kinds are children of statement; statement has no parent', () => {
    for (const k of Object.keys(KINDS)) {
      expect(nodes.find(n => n.type === k)?.parent_type, k).toBe('statement');
    }
    expect(nodes.find(n => n.type === 'statement')?.parent_type).toBeUndefined();
  });

  it('declares the about and partOf rows with the ruled endpoints', () => {
    const about = edges.filter(e => e.type === 'about' && e.source_type === 'statement');
    expect(about.map(e => e.target_type).sort()).toEqual(
      ['area', 'organization', 'software_application']);
    const partOf = edges.filter(e => e.type === 'partOf');
    expect(partOf).toHaveLength(1);
    expect(partOf[0].source_type).toBe('area');
    expect(partOf[0].target_type).toBe('software_application');
  });

  it('each kind carries its definition and "holds one claim"', () => {
    for (const [k, def] of Object.entries(KINDS)) {
      expect(descriptionOf(k), k).toContain(def);
      expect(descriptionOf(k), k).toContain('holds one claim');
    }
  });

  it('statement is abstract and states how attachment works', () => {
    const d = descriptionOf('statement');
    expect(d).toContain('classify a fact as one of the four kinds, never as `statement`');
    expect(d).toContain('attach with `about` to an `area`, the `software_application`, or the `organization`');
    expect(d).toContain('`about` rows declared with source `statement` apply to every kind');
  });

  it('area description names name and patterns_file', () => {
    expect(descriptionOf('area')).toContain('A named part of a `software_application`, such as deploy or billing.');
  });
});

describe('D6 shape guard', () => {
  it('supersedes stays declared on the parent', () => {
    // exact-first symmetric matching in core means this single parent row
    // covers a design_spec -> design_spec relationship.
    const edge = schemaSoftwareOrgManifest.edge_types.find(e => e.type === 'supersedes');
    expect(edge?.source_type).toBe('creativework');
    expect(edge?.target_type).toBe('creativework');
  });

  it('declares supersedes exactly once', () => {
    const rows = schemaSoftwareOrgManifest.edge_types.filter(e => e.type === 'supersedes');
    expect(rows).toHaveLength(1);
  });
});

describe('disambiguation text (D8)', () => {
  it('product no longer claims software', () => {
    const product = descriptionOf('product');
    expect(product).not.toContain('household items, and software');
    expect(product).toContain('software_application');
    expect(product).toContain('service');
  });

  it('software_application names product and service', () => {
    const description = descriptionOf('software_application');
    expect(description).toContain('product');
    expect(description).toContain('service');
  });

  it('service names product and software_application', () => {
    const description = descriptionOf('service');
    expect(description).toContain('product');
    expect(description).toContain('software_application');
  });

  it('stays organization-neutral (no company name in any description)', () => {
    const all = [
      ...schemaSoftwareOrgManifest.node_types.map(n => n.description),
      ...schemaSoftwareOrgManifest.edge_types.map(e => e.description),
    ].join('\n');
    expect(all).not.toMatch(/Equational Applications|\bEA\b|Tessera/);
  });
});

describe('content drift guard', () => {
  it('matches snapshot (content drift guard)', () => {
    expect(schemaSoftwareOrgManifest).toMatchSnapshot();
  });
});
