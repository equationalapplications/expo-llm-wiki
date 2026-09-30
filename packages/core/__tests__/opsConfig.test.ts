import { describe, it, expect } from 'vitest';
import { resolveGateConfig } from '../src/services/librarian/ops/gate';
import { emitDiagnostic } from '../src/utils/diagnostics';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';
import type { WikiDiagnostic } from '../src/types';

describe('resolveGateConfig', () => {
  it('applies spec defaults', () => {
    expect(resolveGateConfig()).toEqual({ k: 5, dupThreshold: 0.97, novelThreshold: 0.55 });
  });
  it('clamps k and thresholds', () => {
    expect(resolveGateConfig({ k: 99, dupThreshold: 2, novelThreshold: -1 })).toEqual({ k: 20, dupThreshold: 1, novelThreshold: 0 });
    expect(resolveGateConfig({ k: 0 }).k).toBe(1);
  });
  it('rejects novel > dup', () => {
    expect(() => resolveGateConfig({ dupThreshold: 0.5, novelThreshold: 0.6 })).toThrow(TypeError);
  });
});

describe('new diagnostic codes are wired', () => {
  it('severity/message tables have entries (compile + runtime)', async () => {
    const { diagnostics } = await makeDiagnosticWiki();
    expect(diagnostics).toEqual([]);
  });
  it('ops + read_budget codes resolve to a severity and message', () => {
    const codes = ['librarian_gate', 'librarian_op_rejected', 'contradicts_document', 'resolve_failed', 'read_budget'] as const;
    const seen: WikiDiagnostic[] = [];
    for (const code of codes) {
      emitDiagnostic(
        { onDiagnostic: (d) => seen.push(d) },
        { code, operation: 'librarian', trigger: 'call', entityId: 'e1' },
      );
    }
    expect(seen.map((d) => d.code)).toEqual([...codes]);
    for (const d of seen) {
      expect(['info', 'warn', 'error']).toContain(d.severity);
      expect(typeof d.message).toBe('string');
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});
