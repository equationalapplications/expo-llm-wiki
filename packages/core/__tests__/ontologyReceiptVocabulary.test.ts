import { describe, it, expect } from 'vitest';
import {
  shouldEmitOntologyReceipt,
  capReceiptSlug,
  SEVERITY,
  MESSAGE,
} from '../src/utils/diagnostics';
import type { WikiDiagnosticCode } from '../src/types';

describe('ontology receipt vocabulary (ontology-curation Task 3)', () => {
  it('severity is fixed per code', () => {
    expect(SEVERITY.node_type_dropped).toBe('warn');
    expect(SEVERITY.node_type_folded).toBe('info');
    expect(SEVERITY.node_type_assigned).toBe('info');
    expect(SEVERITY.ontology_update_rejected).toBe('warn');
    expect(SEVERITY.ingest_zero_facts).toBe('warn');
  });

  it('every new code has a fixed message template', () => {
    const codes: WikiDiagnosticCode[] = [
      'node_type_dropped',
      'node_type_folded',
      'node_type_assigned',
      'ontology_update_rejected',
      'ingest_zero_facts',
    ];
    for (const code of codes) {
      expect(typeof MESSAGE[code]).toBe('string');
      expect(MESSAGE[code].length).toBeGreaterThan(0);
    }
  });

  it('messages carry no content (no slug interpolation)', () => {
    expect(MESSAGE.node_type_folded).not.toMatch(/_/);
    expect(MESSAGE.ontology_update_rejected).not.toContain('slug');
  });

  it('shouldEmitOntologyReceipt gates on mode', () => {
    expect(shouldEmitOntologyReceipt('off')).toBe(false);
    expect(shouldEmitOntologyReceipt('emergent')).toBe(true);
    expect(shouldEmitOntologyReceipt('strict')).toBe(true);
  });

  it('capReceiptSlug truncates at 64 and handles non-strings', () => {
    expect(capReceiptSlug('a'.repeat(100))).toHaveLength(64);
    expect(capReceiptSlug('person')).toBe('person');
    expect(capReceiptSlug(undefined as unknown as string)).toBe('');
  });
});
