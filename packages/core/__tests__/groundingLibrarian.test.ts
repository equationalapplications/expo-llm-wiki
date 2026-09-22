import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED } from './helpers/groundingHarness';

const ON = { grounding: { mode: 'draft' as const, writers: ['librarian' as const] } };
const SUMMARY = 'Ada said "the engine weaves algebraic patterns" \\ then\nleft early';
const fact = (title: string, evidence?: unknown) => ({ title, body: `${title} body`, tags: [], confidence: 'inferred', ...(evidence !== undefined ? { evidence } : {}) });

async function librarian(config: object, facts: object[]) {
  const h = await makeDiagnosticWiki({ config, generateText: async () => JSON.stringify({ facts, tasks: [] }) });
  await h.wiki.write('e1', { event_type: 'observation', summary: SUMMARY });
  await h.wiki.runLibrarian('e1');
  return h;
}

describe('librarian grounding', () => {
  it('grounds against raw event summaries: quotes, backslashes and newlines do not cause false failures', async () => {
    const h = await librarian(ON, [
      fact('Quoted', ['Ada said "the engine weaves algebraic patterns"']),
      fact('Backslash', ['algebraic patterns" \\ then left early']),
    ]);
    const rows = await factRows(h.db);
    expect(rows.map((r) => [r.title, r.lifecycle_status])).toEqual([['Backslash', 'stable'], ['Quoted', 'stable']]);
    expect(rows[0].okf_verified).toEqual(GROUNDED);
    expect(h.diagnostics.filter((d) => d.code.startsWith('grounding_'))).toEqual([]);
  });

  it('quoting the event id or event_type does not ground (identifiers are not corpus)', async () => {
    const h = await librarian({ grounding: { ...ON.grounding, minEvidenceChars: 5 } }, [fact('Ident', ['observation'])]);
    expect((await factRows(h.db))[0].lifecycle_status).toBe('draft');
  });

  it('no circular grounding: a quote copied from a current fact fails', async () => {
    let call = 0;
    const h = await makeDiagnosticWiki({
      config: ON,
      generateText: async () => {
        call++;
        return JSON.stringify({
          facts: call === 1
            ? [{ title: 'Seed fact', body: 'Babbage built the difference engine prototype', tags: [], confidence: 'inferred', evidence: ['the engine weaves algebraic patterns'] }]
            : [fact('Circular', ['Babbage built the difference engine prototype'])],
          tasks: [],
        });
      },
    });
    await h.wiki.write('e1', { event_type: 'observation', summary: SUMMARY });
    await h.wiki.runLibrarian('e1');
    await h.wiki.runLibrarian('e1');
    expect(h.generateText.mock.calls[1][0].userPrompt).toContain('Babbage built the difference engine prototype');
    const circular = (await factRows(h.db)).find((r) => r.title === 'Circular')!;
    expect(circular.lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_failed').map((d) => d.detail)).toEqual([
      { factId: circular.id, itemIndex: 0, reason: 'quote_not_found' },
    ]);
  });

  it('missing evidence → draft and grounding_missing with factId and itemIndex, no content', async () => {
    const h = await librarian(ON, [fact('Ok', ['the engine weaves algebraic patterns']), fact('Bare')]);
    const bare = (await factRows(h.db)).find((r) => r.title === 'Bare')!;
    expect(bare.lifecycle_status).toBe('draft');
    expect(ofCode(h.diagnostics, 'grounding_missing')).toEqual([expect.objectContaining({
      operation: 'librarian', trigger: 'call', entityId: 'e1', detail: { factId: bare.id, itemIndex: 1, reason: 'no_evidence' },
    })]);
    expectNoContent(h.diagnostics, ['Bare body', 'algebraic']);
  });

  it('a promptOverride without evidence wording still gets the block', async () => {
    const h = await librarian({ ...ON, prompts: { librarianSystemPrompt: 'Custom librarian.' } }, []);
    expect(h.generateText.mock.calls[0][0].systemPrompt).toMatch(/^Custom librarian\.[\s\S]*EVIDENCE REQUIREMENT/);
  });

  it('librarian outside grounding.writers: no block, facts stable, trust untouched', async () => {
    const h = await librarian({ grounding: { mode: 'draft' } }, [fact('Plain')]);
    expect(h.generateText.mock.calls[0][0].systemPrompt).not.toContain('EVIDENCE REQUIREMENT');
    expect((await factRows(h.db))[0]).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
  });
});
