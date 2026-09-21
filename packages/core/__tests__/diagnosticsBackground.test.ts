import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

describe('background job diagnostics', () => {
  it('auto-librarian failure → background_job_failed with operation librarian, trigger auto; console.error unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('llm offline');
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { autoLibrarianThreshold: 1 },
      generateText: async () => { throw failure; },
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await vi.waitFor(() => expect(ofCode(diagnostics, 'background_job_failed')).toHaveLength(1));
    expect(ofCode(diagnostics, 'background_job_failed')[0]).toMatchObject({
      severity: 'error', operation: 'librarian', trigger: 'auto', entityId: 'e1',
      detail: { reason: 'unhandled_rejection' },
    });
    expect(error).toHaveBeenCalledWith(failure);
    expect(JSON.stringify(diagnostics)).not.toContain('llm offline');
  });

  it('auto-librarian run tags its own diagnostics with trigger auto', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { autoLibrarianThreshold: 1 },
      generateText: async () => JSON.stringify({ facts: [{ title: 5, body: 'x' }], tasks: [] }),
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await vi.waitFor(() => expect(ofCode(diagnostics, 'fact_rejected')).toHaveLength(1));
    expect(ofCode(diagnostics, 'fact_rejected')[0]).toMatchObject({ operation: 'librarian', trigger: 'auto' });
  });

  it('host-invoked runLibrarian tags diagnostics with trigger call', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 5, body: 'x' }], tasks: [] }),
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await wiki.runLibrarian('e1');
    expect(ofCode(diagnostics, 'fact_rejected')[0]).toMatchObject({ operation: 'librarian', trigger: 'call' });
  });
});
