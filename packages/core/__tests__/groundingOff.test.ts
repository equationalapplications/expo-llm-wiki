import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, factRows, HASH_A } from './helpers/groundingHarness';
import type { WikiConfig } from '../src/types';

// Random ids and wall-clock timestamps differ between the two runs; mask them.
const mask = (s: string) => s
  .replace(/"(id|related_entry_id)": "[^"]*"/g, '"$1": "<id>"')
  .replace(/"([a-z_]*_at)": \d+/g, '"$1": 0');

async function run(config: WikiConfig) {
  const h = await makeDiagnosticWiki({
    config,
    generateText: async ({ userPrompt }) => userPrompt.startsWith('Heal Candidates')
      ? JSON.stringify({ downgraded: [], deleted: [], newFacts: [{ title: 'Healed', body: 'healed body', tags: [], confidence: 'inferred', evidence: ['anything at all goes here'] }] })
      : JSON.stringify({ facts: [{ title: 'Engine', body: 'engine body', tags: [], confidence: 'certain', evidence: ['not in the source at all'] }], tasks: [] }),
  });
  await h.wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'The engine document.' });
  await h.wiki.write('e1', { event_type: 'observation', summary: 'engine event' });
  await h.wiki.runLibrarian('e1');
  await h.wiki.runHeal('e1');
  const prompts = h.generateText.mock.calls.map(([p]) => ({ systemPrompt: p.systemPrompt, userPrompt: mask(p.userPrompt) }));
  const rows = (await factRows(h.db)).map(({ id: _id, last_verified_at: _t, ...r }) => r);
  return { prompts, rows, grounding: h.diagnostics.filter((d) => d.code.startsWith('grounding_')) };
}

describe("grounding mode 'off' equals baseline", () => {
  it('prompts, stored trust columns and diagnostics are identical to no grounding config', async () => {
    const baseline = await run({});
    const off = await run({ grounding: { mode: 'off', writers: ['ingest', 'librarian', 'heal'] } });
    expect(off).toEqual(baseline);
    expect(baseline.grounding).toEqual([]);
    expect(baseline.rows.every((r) => r.lifecycle_status === 'stable' && r.okf_verified === null)).toBe(true);
  });
});
