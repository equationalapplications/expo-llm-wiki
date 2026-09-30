import { describe, it, expect } from 'vitest';
import { resolveGateConfig } from '../src/services/librarian/ops/gate';
import { makeDiagnosticWiki } from './helpers/diagnosticsHarness';

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
});