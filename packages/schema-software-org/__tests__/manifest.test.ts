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
      schemaOrgWarmAgentManifest.edge_types.length + 12,
    );
  });
});

describe('shape and counts', () => {
  it('ships exactly the 17 declared node types', () => {
    expect(new Set(schemaSoftwareOrgManifest.node_types.map(n => n.type))).toEqual(
      new Set([
        // 9 warm-agent (D2)
        'person', 'organization', 'place', 'event', 'project', 'action',
        'creativework', 'review', 'product',
        // 3 software-org base types (D5)
        'software_application', 'service', 'role',
        // 5 software-org creativework subtypes
        'design_spec', 'handoff', 'procedure', 'session_recap',
        'reference_doc',
      ]),
    );
  });

  it('has exactly 17 node types and 40 edge types', () => {
    expect(schemaSoftwareOrgManifest.node_types).toHaveLength(17);
    expect(schemaSoftwareOrgManifest.edge_types).toHaveLength(40);
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
  const descriptionOf = (slug: string) => {
    const node = schemaSoftwareOrgManifest.node_types.find(n => n.type === slug);
    expect(node, slug).toBeDefined();
    return node!.description;
  };

  it.each([
    ['software_application', ['repo_url', 'version', 'install_path', 'status']],
    ['service', ['provider', 'dashboard_url', 'status', 'tier']],
    ['role', ['role_name', 'scope', 'capabilities']],
    ['design_spec', ['status', 'spec_for', 'branch']],
    ['handoff', ['session_id', 'outcome', 'open_items']],
    ['procedure', ['trigger', 'last_reviewed', 'applies_to']],
    ['session_recap', ['session_date', 'key_decisions']],
    ['reference_doc', ['source_url', 'application']],
  ])('%s lists its expected frontmatter properties', (slug, props) => {
    const description = descriptionOf(slug as string);
    for (const prop of props as string[]) {
      expect(description, `${slug} should mention ${prop}`).toContain(prop);
    }
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
  const descriptionOf = (slug: string) =>
    schemaSoftwareOrgManifest.node_types.find(n => n.type === slug)!.description;

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
