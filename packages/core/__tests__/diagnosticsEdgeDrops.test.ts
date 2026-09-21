import { describe, it, expect } from 'vitest';
import { factRejectionReason, taskRejectionReason, validateFact, validateTask } from '../src/utils/pure';
import { validateInlineEdges, type EdgeDrop } from '../src/utils/ontology';
import { OntologyService } from '../src/services/OntologyService';
import { edgeDropDiagnostic } from '../src/utils/diagnostics';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

describe('rejection reasons', () => {
  it('classifies facts that validateFact rejects', () => {
    expect(validateFact({ title: 5, body: 'b' })).toBeNull();
    expect(factRejectionReason({ title: 5, body: 'b' })).toBe('invalid_shape');
    expect(factRejectionReason(null)).toBe('invalid_shape');
    expect(factRejectionReason({ title: '   ', body: 'b' })).toBe('missing_title');
    expect(factRejectionReason({ title: 't', body: '' })).toBe('missing_body');
  });

  it('classifies tasks that validateTask rejects', () => {
    expect(validateTask({ description: 7 })).toBeNull();
    expect(taskRejectionReason({ description: 7 })).toBe('invalid_shape');
    expect(taskRejectionReason({ description: '  ' })).toBe('missing_description');
  });
});

describe('validateInlineEdges drops', () => {
  it('records invalid_shape and type_not_in_manifest', () => {
    const drops: EdgeDrop[] = [];
    const kept = validateInlineEdges('person', null, [
      { edge_type: 'lives_in', target_title: 'London' },
      { edge_type: 5, target_title: 'x' } as never,
      { edge_type: 'unknown_edge', target_title: 'y' },
    ], MANIFEST, { drops });
    expect(kept).toHaveLength(1);
    expect(drops).toEqual([
      { reason: 'invalid_shape', sourceId: null, edgeType: null, sourceNodeType: 'person', targetNodeType: null },
      { reason: 'type_not_in_manifest', sourceId: null, edgeType: 'unknown_edge', sourceNodeType: 'person', targetNodeType: null },
    ]);
  });
});

describe('OntologyService drops', () => {
  const service = new OntologyService({} as never, {} as never, undefined);

  it('validateAndNormalizeFact records no_source_type for every edge of an unknown-typed fact', () => {
    const drops: EdgeDrop[] = [];
    const out = service.validateAndNormalizeFact(
      { title: 't', body: 'b', tags: [], confidence: 'certain', okf_type: 'alien',
        edges: [{ edge_type: 'lives_in', target_title: 'London' }] },
      MANIFEST, { strict: false, drops },
    );
    expect(out).toEqual({ okf_type: null, edges: [] });
    expect(drops).toEqual([
      { reason: 'no_source_type', sourceId: null, edgeType: 'lives_in', sourceNodeType: null, targetNodeType: null },
    ]);
  });

  it('resolveEdges records target_not_found and target_type_mismatch with the source id', () => {
    const drops: EdgeDrop[] = [];
    const titleIndex = new Map([
      ['london', { id: 'fact_l', okf_type: 'person' }],
    ]);
    const out = service.resolveEdges('e1', 'fact_s', 'person', [
      { edge_type: 'lives_in', target_title: 'Nowhere' },
      { edge_type: 'lives_in', target_title: 'London' },
    ], MANIFEST, titleIndex, 1, drops);
    expect(out).toEqual([]);
    expect(drops).toEqual([
      { reason: 'target_not_found', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: null },
      { reason: 'target_type_mismatch', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: 'person' },
    ]);
  });

  it('resolveEdges records no_source_type when the source is untyped', () => {
    const drops: EdgeDrop[] = [];
    service.resolveEdges('e1', 'fact_s', null, [{ edge_type: 'lives_in', target_title: 'x' }], MANIFEST, new Map(), 1, drops);
    expect(drops.map((d) => d.reason)).toEqual(['no_source_type']);
  });

  it('behaves exactly as before when no drops array is passed', () => {
    const out = service.resolveEdges('e1', 'fact_s', 'person', [{ edge_type: 'lives_in', target_title: 'Nowhere' }], MANIFEST, new Map(), 1);
    expect(out).toEqual([]);
  });
});

describe('edgeDropDiagnostic', () => {
  it('maps a drop to an edge_dropped input without null keys', () => {
    const input = edgeDropDiagnostic(
      { reason: 'target_not_found', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: null },
      { entityId: 'e1', operation: 'ingest', trigger: 'call', sourceRef: 'doc.md' },
    );
    expect(input).toEqual({
      code: 'edge_dropped', operation: 'ingest', trigger: 'call', entityId: 'e1',
      detail: { reason: 'target_not_found', factId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', sourceRef: 'doc.md' },
    });
  });

  it('prefers ctx.factId when the drop was recorded before the id existed', () => {
    const input = edgeDropDiagnostic(
      { reason: 'no_source_type', sourceId: null, edgeType: 'lives_in', sourceNodeType: null, targetNodeType: null },
      { entityId: 'e1', operation: 'librarian', trigger: 'auto', factId: 'fact_new' },
    );
    expect(input.detail).toEqual({ reason: 'no_source_type', factId: 'fact_new', edgeType: 'lives_in' });
  });
});
