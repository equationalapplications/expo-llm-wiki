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
});
