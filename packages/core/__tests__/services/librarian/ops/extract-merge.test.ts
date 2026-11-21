import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../../../../src/WikiMemory';
import { selectBatch, runExtract } from '../../../../src/services/librarian/ops/extract';
import { openTestDatabase } from '../../../helpers/sqliteAdapter';

type P = { systemPrompt: string; userPrompt: string };
const eventCount = (p: P) => (p.userPrompt.match(/^e\d+(#\d+)? \[/gm) ?? []).length;
const labelsOf = (p: P) => [...p.userPrompt.matchAll(/^(e\d+) \[/gm)].map((m) => m[1]);
const fact = (title: string, source: string) => ({ title, body: 'b', tags: [], confidence: 'certain', source_event: source });

async function mk(generateText: (p: P) => Promise<string>, onDiagnostic?: (d: any) => void) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { ...(onDiagnostic ? { onDiagnostic } : {}), llmProvider: { generateText: vi.fn(generateText) }, config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } } } as any);
  await wiki.setup();
  const deps = (wiki.__testAccess.maintenanceService as any).librarianDeps();
  const ev = (id: string, at: number, summary: string) =>
    db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, 'u', 'observation', ?, ?)`, [id, summary, at]);
  return { db, wiki, deps, ev };
}

const tooLong = () => new Error('prompt is too long: 250000 tokens > 200000 maximum');

describe('ops extract split-path merge', () => {
  it('offsets second-half candidate indices by the first half raw fact count, not candidate count', async () => {
    // 2 events: initial call overflows -> halves of 1 event each.
    // First half returns [valid, invalid]: 2 raw factItems but 1 candidate.
    const { deps, ev } = await mk(async (p) => {
      if (eventCount(p) > 1) throw tooLong();
      const labels = labelsOf(p);
      if (labels[0] === 'e1') {
        return JSON.stringify({ facts: [fact('Valid from e1', 'e1'), { title: 'garbage, no body' }], tasks: [] });
      }
      return JSON.stringify({ facts: [fact('Valid from e2', 'e2')], tasks: [] });
    });
    await ev('evt_1', 10, 'summary one');
    await ev('evt_2', 20, 'summary two');
    const sel: any = await selectBatch(deps, 'u', null, undefined, undefined, undefined);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    const rejected = out.diagnostics.filter((d: any) => d.code === 'fact_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].detail.itemIndex).toBe(1);
    // Candidates and rejection diagnostics share the raw fact-index space:
    // the second half's single candidate must sit at index 2 (offset by a.factItems=2).
    const sorted = [...out.candidates].sort((a: any, b: any) => a.index - b.index);
    expect(sorted.map((c: any) => c.index)).toEqual([0, 2]);
    expect(sorted.map((c: any) => c.fact.title).sort()).toEqual(['Valid from e1', 'Valid from e2']);
    // No collision between candidate indices and rejection itemIndex.
    const candIdx = new Set(out.candidates.map((c: any) => c.index));
    expect(candIdx.has(rejected[0].detail.itemIndex)).toBe(false);
  });

  it('normalizes ontology_updates with null entries through the split path without throwing', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (eventCount(p) > 1) throw tooLong();
      const labels = labelsOf(p);
      if (labels[0] === 'e1') {
        return JSON.stringify({ facts: [fact('F1', 'e1')], tasks: [], ontology_updates: { node_types: [null] } });
      }
      return JSON.stringify({ facts: [fact('F2', 'e2')], tasks: [] });
    });
    await ev('evt_1', 10, 'summary one');
    await ev('evt_2', 20, 'summary two');
    const sel: any = await selectBatch(deps, 'u', null, undefined, undefined, undefined);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    const nodes = out.ontologyUpdates?.node_types ?? [];
    expect(nodes.every((n: any) => n && typeof n.type === 'string' && n.type.length > 0)).toBe(true);
  });

  it('normalizes non-array ontology_updates fields through the split path without throwing', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (eventCount(p) > 1) throw tooLong();
      const labels = labelsOf(p);
      if (labels[0] === 'e1') {
        return JSON.stringify({ facts: [fact('F1', 'e1')], tasks: [], ontology_updates: { node_types: {}, edge_types: 7 } });
      }
      return JSON.stringify({ facts: [fact('F2', 'e2')], tasks: [], ontology_updates: { node_types: [{ type: 'concept', label: 'Concept' }] } });
    });
    await ev('evt_1', 10, 'summary one');
    await ev('evt_2', 20, 'summary two');
    const sel: any = await selectBatch(deps, 'u', null, undefined, undefined, undefined);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.ontologyUpdates?.node_types).toEqual([{ type: 'concept', label: 'Concept' }]);
    expect(out.ontologyUpdates?.edge_types).toBeUndefined();
  });

  it('still dedupes well-formed ontology updates across split halves', async () => {
    const { deps, ev } = await mk(async (p) => {
      if (eventCount(p) > 1) throw tooLong();
      const labels = labelsOf(p);
      return JSON.stringify({
        facts: [fact(`F ${labels[0]}`, labels[0])],
        tasks: [],
        ontology_updates: { node_types: [{ type: 'concept', label: 'Concept' }] },
      });
    });
    await ev('evt_1', 10, 'summary one');
    await ev('evt_2', 20, 'summary two');
    const sel: any = await selectBatch(deps, 'u', null, undefined, undefined, undefined);
    const out = await runExtract(deps, { entityId: 'u', trigger: 'call' }, sel.batch);
    expect(out.ontologyUpdates?.node_types).toEqual([{ type: 'concept', label: 'Concept' }]);
  });
});
