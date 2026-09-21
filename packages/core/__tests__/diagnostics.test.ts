import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitDiagnostic, DiagnosticBuffer, type WikiDiagnosticInput } from '../src/utils/diagnostics';
import type { WikiDiagnostic } from '../src/types';

const base: WikiDiagnosticInput = {
  code: 'edge_dropped',
  operation: 'ingest',
  trigger: 'call',
  entityId: 'e1',
  detail: { factId: 'fact_1', reason: 'target_not_found' },
};

afterEach(() => vi.restoreAllMocks());

describe('emitDiagnostic', () => {
  it('derives severity, message and timestamp from the code', () => {
    const seen: WikiDiagnostic[] = [];
    const before = Date.now();
    emitDiagnostic({ onDiagnostic: (d) => { seen.push(d); } }, base);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ...base, severity: 'warn' });
    expect(typeof seen[0].message).toBe('string');
    expect(seen[0].message.length).toBeGreaterThan(0);
    expect(seen[0].at).toBeGreaterThanOrEqual(before);
  });

  it('uses fixed severities: info for dedupe/low-confidence, error for background jobs', () => {
    const seen: WikiDiagnostic[] = [];
    const hook = { onDiagnostic: (d: WikiDiagnostic) => { seen.push(d); } };
    emitDiagnostic(hook, { ...base, code: 'fact_deduplicated' });
    emitDiagnostic(hook, { ...base, code: 'classification_low_confidence' });
    emitDiagnostic(hook, { ...base, code: 'background_job_failed' });
    expect(seen.map((d) => d.severity)).toEqual(['info', 'info', 'error']);
  });

  it('is a silent no-op without a hook', () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    emitDiagnostic({}, base);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('isolates a throwing hook', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => emitDiagnostic({ onDiagnostic: () => { throw new Error('boom'); } }, base)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('isolates a rejecting async hook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = (async () => { throw new Error('async boom'); }) as unknown as (d: WikiDiagnostic) => void;
    expect(() => emitDiagnostic({ onDiagnostic: hook }, base)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per options object for a non-function hook and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options = { onDiagnostic: 42 as unknown as (d: WikiDiagnostic) => void };
    emitDiagnostic(options, base);
    emitDiagnostic(options, base);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hands the hook a copy of detail so host mutation cannot reach core', () => {
    const input: WikiDiagnosticInput = { ...base, detail: { chunkIndexes: [1, 2] } };
    emitDiagnostic({ onDiagnostic: (d) => { d.detail!.chunkIndexes!.push(99); } }, input);
    expect(input.detail!.chunkIndexes).toEqual([1, 2]);
  });
});

describe('DiagnosticBuffer', () => {
  it('flushes in insertion order and empties itself', () => {
    const seen: WikiDiagnostic[] = [];
    const options = { onDiagnostic: (d: WikiDiagnostic) => { seen.push(d); } };
    const buffer = new DiagnosticBuffer();
    buffer.push({ ...base, detail: { itemIndex: 0 } });
    buffer.push({ ...base, detail: { itemIndex: 1 } });
    expect(buffer.size).toBe(2);
    buffer.flush(options);
    buffer.flush(options);
    expect(seen.map((d) => d.detail?.itemIndex)).toEqual([0, 1]);
    expect(buffer.size).toBe(0);
  });

  it('discard drops everything', () => {
    const seen: WikiDiagnostic[] = [];
    const buffer = new DiagnosticBuffer();
    buffer.push(base);
    buffer.discard();
    buffer.flush({ onDiagnostic: (d) => { seen.push(d); } });
    expect(seen).toEqual([]);
  });
});
