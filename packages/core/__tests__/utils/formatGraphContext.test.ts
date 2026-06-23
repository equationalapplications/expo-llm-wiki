import { describe, it, expect } from 'vitest';
import { formatGraphContext } from '../../src/utils/formatGraphContext';
import type { GraphNeighborhood, WikiFact, WikiEdge } from '../../src/types';

function makeFact(overrides: Partial<WikiFact> & { id: string; title: string }): WikiFact {
  return {
    entity_id: 'entity1',
    body: 'body',
    tags: [],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: 1,
    updated_at: 1,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    okf_type: null,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<WikiEdge> & { id: string; source_id: string; target_id: string; edge_type: string }): WikiEdge {
  return {
    entity_id: 'entity1',
    created_at: 1,
    ...overrides,
  };
}

describe('formatGraphContext', () => {
  it('returns an empty string for an empty neighborhood', () => {
    expect(formatGraphContext({ nodes: [], edges: [] })).toBe('');
  });

  it('renders a node with no edges', () => {
    const neighborhood: GraphNeighborhood = {
      nodes: [makeFact({ id: '123', title: 'John Doe', okf_type: 'person' })],
      edges: [],
    };
    expect(formatGraphContext(neighborhood)).toBe('[person] John Doe (ID: 123)');
  });

  it('defaults the type label to "fact" when okf_type is null', () => {
    const neighborhood: GraphNeighborhood = {
      nodes: [makeFact({ id: '123', title: 'Some Note', okf_type: null })],
      edges: [],
    };
    expect(formatGraphContext(neighborhood)).toBe('[fact] Some Note (ID: 123)');
  });

  it('renders outbound before inbound edges, matching the documented shape', () => {
    const neighborhood: GraphNeighborhood = {
      nodes: [
        makeFact({ id: '123', title: 'John Doe', okf_type: 'person' }),
        makeFact({ id: '456', title: 'Jane Smith', okf_type: 'person' }),
        makeFact({ id: '789', title: 'Alpha Rewrite', okf_type: 'project' }),
      ],
      edges: [
        makeEdge({ id: 'e1', source_id: '123', target_id: '456', edge_type: 'reports_to' }),
        makeEdge({ id: 'e2', source_id: '789', target_id: '123', edge_type: 'contributes_to' }),
      ],
    };

    expect(formatGraphContext(neighborhood)).toBe(
      [
        '[person] John Doe (ID: 123)',
        '  -[reports_to]-> [person] Jane Smith',
        '  <-[contributes_to]- [project] Alpha Rewrite',
        '[person] Jane Smith (ID: 456)',
        '[project] Alpha Rewrite (ID: 789)',
      ].join('\n'),
    );
  });

  it('sorts same-direction edges by edge_type then connected title', () => {
    const neighborhood: GraphNeighborhood = {
      nodes: [
        makeFact({ id: 'a', title: 'A', okf_type: 'person' }),
        makeFact({ id: 'b', title: 'Zed', okf_type: 'person' }),
        makeFact({ id: 'c', title: 'Bob', okf_type: 'person' }),
        makeFact({ id: 'd', title: 'Carl', okf_type: 'person' }),
      ],
      edges: [
        makeEdge({ id: 'e1', source_id: 'a', target_id: 'b', edge_type: 'zzz_type' }),
        makeEdge({ id: 'e2', source_id: 'a', target_id: 'c', edge_type: 'aaa_type' }),
        makeEdge({ id: 'e3', source_id: 'a', target_id: 'd', edge_type: 'aaa_type' }),
      ],
    };

    const lines = formatGraphContext(neighborhood).split('\n');
    expect(lines).toEqual([
      '[person] A (ID: a)',
      '  -[aaa_type]-> [person] Bob',
      '  -[aaa_type]-> [person] Carl',
      '  -[zzz_type]-> [person] Zed',
      '[person] Zed (ID: b)',
      '[person] Bob (ID: c)',
      '[person] Carl (ID: d)',
    ]);
  });

  it('produces byte-identical output across repeated calls with equivalent (non-identical) input', () => {
    const build = (): GraphNeighborhood => ({
      nodes: [makeFact({ id: '1', title: 'A', okf_type: 'x' }), makeFact({ id: '2', title: 'B', okf_type: 'y' })],
      edges: [makeEdge({ id: 'e1', source_id: '1', target_id: '2', edge_type: 'link' })],
    });

    expect(formatGraphContext(build())).toBe(formatGraphContext(build()));
  });

  it('is deterministic when edge_type and connected title tie', () => {
    const n1 = makeFact({ id: '1', title: 'Root', okf_type: 'x' });
    const n2 = makeFact({ id: '2', title: 'Same', okf_type: 'x' });
    const n3 = makeFact({ id: '3', title: 'Same', okf_type: 'x' });

    const a: GraphNeighborhood = {
      nodes: [n1, n2, n3],
      edges: [
        makeEdge({ id: 'e1', source_id: '1', target_id: '2', edge_type: 'rel' }),
        makeEdge({ id: 'e2', source_id: '1', target_id: '3', edge_type: 'rel' }),
      ],
    };
    const b: GraphNeighborhood = {
      nodes: [n1, n2, n3],
      edges: [
        makeEdge({ id: 'e2', source_id: '1', target_id: '3', edge_type: 'rel' }),
        makeEdge({ id: 'e1', source_id: '1', target_id: '2', edge_type: 'rel' }),
      ],
    };

    expect(formatGraphContext(a)).toBe(formatGraphContext(b));
  });
});
