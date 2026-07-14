import { describe, it, expect } from 'vitest';
import { validateManifest } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '../src/index';

describe('schemaOrgWarmAgentManifest', () => {
  it('passes core validateManifest', () => {
    expect(() => validateManifest(schemaOrgWarmAgentManifest)).not.toThrow();
  });

  it('has exactly 9 node types and 28 edges', () => {
    expect(schemaOrgWarmAgentManifest.node_types).toHaveLength(9);
    expect(schemaOrgWarmAgentManifest.edge_types).toHaveLength(28);
  });

  it('has 19 unique property names with the expected polymorphic counts', () => {
    const counts = new Map<string, number>();
    for (const e of schemaOrgWarmAgentManifest.edge_types) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    expect(counts.size).toBe(19);
    expect(counts.get('location')).toBe(2);
    expect(counts.get('organizer')).toBe(2);
    expect(counts.get('about')).toBe(4);
    expect(counts.get('itemReviewed')).toBe(5);
  });

  it('every edge endpoint exists in the node list', () => {
    const nodes = new Set(schemaOrgWarmAgentManifest.node_types.map(n => n.type));
    for (const e of schemaOrgWarmAgentManifest.edge_types) {
      expect(nodes.has(e.source_type), `${e.type} source ${e.source_type}`).toBe(true);
      expect(nodes.has(e.target_type), `${e.type} target ${e.target_type}`).toBe(true);
    }
  });

  it('every node and edge has a non-empty description', () => {
    for (const n of schemaOrgWarmAgentManifest.node_types) {
      expect(n.description.length, n.type).toBeGreaterThan(0);
    }
    for (const e of schemaOrgWarmAgentManifest.edge_types) {
      expect(e.description.length, e.type).toBeGreaterThan(0);
    }
  });

  it('matches snapshot (content drift guard)', () => {
    expect(schemaOrgWarmAgentManifest).toMatchSnapshot();
  });
});
