import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDiagnosticWiki, HASH_A, HASH_B } from './helpers/diagnosticsHarness';
import type { ClassifyRequest, ClassifyResponse, OntologyManifest, OntologyMode, WikiConfig, WikiDiagnostic, LLMProvider } from '../src/types';

/**
 * specs/ingest-time-typing Test plan 1(b), 1(c): default-host compatibility pins,
 * recorded on the UNMODIFIED ingest code (origin/main b70247ee) before
 * IngestionService was touched. Prompts are stored as sha256:length; diagnostic
 * sequences are stored whole, with fact ids replaced by a stable ordinal.
 * Re-record only with RECORD_INGEST_FIXTURES=1 and only when a spec ruling
 * intends the change.
 */
const FIXTURE = join(__dirname, 'fixtures', 'ingestTypingCompat.json');

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residence' }],
};
const PLACEHOLDER_OVERRIDE = 'Custom prompt.\n{{ontologyManifest}}\n{{ontologyModeInstructions}}\nChunk {{documentChunk}}';
const modes: OntologyMode[] = ['off', 'strict', 'emergent'];

const h = (t: string) => `${createHash('sha256').update(t).digest('hex')}:${t.length}`;
const classifyAnswer: ClassifyResponse = { answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.99, probabilities: { person: 0.99 } } } };

type Variant = { name: string; config: WikiConfig; classify: boolean };
// Every variant below is a default host for ingest: the typeOnIngest key is unset,
// 'llm', or absent from the engine entirely; typeOnWrite never governs ingest.
const variants: Variant[] = [
  { name: 'unset', config: {}, classify: false },
  { name: 'unset+classify', config: {}, classify: true },
  { name: 'llm+classify', config: { systemOne: { typeOnIngest: 'llm' } } as WikiConfig, classify: true },
  { name: 'typeOnWrite-auto+classify', config: { systemOne: { typeOnWrite: 'auto' } }, classify: true },
];

async function capturePrompts(v: Variant, mode: OntologyMode, opts: { override?: string; guidance?: string }) {
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const classify = vi.fn(async (_r: ClassifyRequest) => classifyAnswer);
  const config: WikiConfig = { ...v.config, ...(opts.guidance ? { prompts: { guidance: opts.guidance } } : {}) };
  const provider: LLMProvider = {
    generateText: async (p) => { calls.push({ systemPrompt: p.systemPrompt, userPrompt: p.userPrompt }); return JSON.stringify({ facts: [{ title: 'Ada', body: 'b', tags: [], confidence: 'certain' }] }); },
    ...(v.classify ? { classify } : {}),
  };
  const { wiki } = await makeDiagnosticWiki({ config, extra: { llmProvider: provider } });
  await wiki.setOntologyManifest('e1', MANIFEST, { mode });
  await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'Ada lives in Paris.', ...(opts.override ? { promptOverride: opts.override } : {}) });
  return { calls, classify };
}

const scenarios: Array<[string, { override?: string; guidance?: string }]> = [
  ['default', {}],
  ['placeholder', { override: PLACEHOLDER_OVERRIDE }],
  ['guidance', { guidance: 'Prefer durable facts.' }],
];

function load(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(FIXTURE, 'utf8')); } catch { return {}; }
}
const RECORD = process.env.RECORD_INGEST_FIXTURES === '1';
const recorded: Record<string, unknown> = RECORD ? {} : load();

function check(key: string, value: unknown) {
  if (RECORD) { recorded[key] = value; return; }
  expect(value, key).toEqual(recorded[key]);
}

describe('ingest default-host byte identity (Test plan 1b)', () => {
  for (const v of variants) {
    for (const mode of modes) {
      for (const [sname, sopts] of scenarios) {
        it(`${v.name} | ${mode} | ${sname}`, async () => {
          const { calls, classify } = await capturePrompts(v, mode, sopts);
          expect(classify).not.toHaveBeenCalled();
          check(`prompt|${mode}|${sname}`, calls.map((c) => [h(c.systemPrompt), h(c.userPrompt)]));
        });
      }
    }
  }
});


const norm = (diagnostics: WikiDiagnostic[]) => {
  const ids = new Map<string, string>();
  const idOf = (id: string) => { if (!ids.has(id)) ids.set(id, `F${ids.size}`); return ids.get(id)!; };
  return diagnostics.map((d) => ({
    code: d.code, severity: d.severity, operation: d.operation, trigger: d.trigger, entityId: d.entityId,
    detail: JSON.parse(JSON.stringify(d.detail ?? {}, (k, v) => (k === 'factId' && typeof v === 'string' ? idOf(v) : v))),
  }));
};

async function receipts(kind: 'full' | 'partial' | 'zero', config: WikiConfig = {}, mode: 'strict' | 'emergent' = 'emergent') {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let empty = false;
  const full = JSON.stringify({ facts: [
    { title: 'Ada', body: 'ada', tags: [], confidence: 'certain', okf_type: 'per-son', edges: [{ edge_type: 'lives_in', target_title: 'Paris' }, { edge_type: 'nope', target_title: 'Paris' }] },
    { title: 'Paris', body: 'paris', tags: [], confidence: 'certain', okf_type: 'place' },
    { title: 'R2', body: 'r2', tags: [], confidence: 'certain', okf_type: 'robot' },
    { title: 'Plain', body: 'plain', tags: [], confidence: 'certain' },
    { title: 'Ada', body: 'ada dup', tags: [], confidence: 'certain' },
  ] });
  const { wiki, db, diagnostics } = await makeDiagnosticWiki({
    config: { ...config, ...(kind === 'partial' ? { maxChunkLength: 30, chunkOverlap: 0 } : {}) },
    generateText: async ({ userPrompt }) => {
      if (empty) return JSON.stringify({ facts: [] });
      return userPrompt.includes('BROKEN') ? 'not json' : full;
    },
  });
  await wiki.setOntologyManifest('e1', MANIFEST, { mode });
  const doc = kind === 'partial' ? 'ALPHA chunk text here.\n\nBROKEN chunk text here.' : 'content';
  await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: doc });
  if (kind === 'zero') {
    diagnostics.length = 0;
    empty = true;
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: 'content 2' });
  }
  // Filter BEFORE normalizing: the disclosed node_type_assigned receipts mention fact ids
  // the recorded sequence never saw, and must not shift the stable ordinals.
  const entryRows = await db.getAllAsync<{ id: string; title: string }>('SELECT id, title FROM llm_wiki_entries WHERE entity_id = ? AND deleted_at IS NULL', ['e1']);
  return { entryRows, seq: norm(diagnostics.filter((d) => d.code !== 'node_type_assigned')), assigned: diagnostics.filter((d) => d.code === 'node_type_assigned') };
}

describe('ingest default-host receipt sequences (Test plan 1c)', () => {
  for (const [mode, kind] of (['emergent', 'strict'] as const).flatMap((m) => (['full', 'partial', 'zero'] as const).map((k) => [m, k] as const))) {
    it(`${mode} ${kind} path`, async () => {
      const { seq } = await receipts(kind, {}, mode);
      // The one disclosed default-host delta (spec section 12) is node_type_assigned { writer: 'llm' }; it is excluded here and asserted below.
      check(mode === 'emergent' ? `receipts|${kind}` : `receipts|strict|${kind}`, seq);
      if (kind === 'zero') expect(seq.some((d) => d.code === 'ingest_zero_facts')).toBe(true);
    });
  }
  it('typeOnIngest llm gives the same full-path sequence as unset', async () => {
    const a = await receipts('full');
    const b = await receipts('full', { systemOne: { typeOnIngest: 'llm' } } as WikiConfig);
    expect(b.seq).toEqual(a.seq);
  });
  it('the one disclosed delta: node_type_assigned { writer: llm } per generative-typed fact, both paths', async () => {
    for (const kind of ['full', 'partial'] as const) {
      const { assigned, entryRows } = await receipts(kind);
      const idOf = (title: string) => entryRows.find((r) => r.title === title)?.id;
      // Ada (folded per-son -> person) and Paris (exact) resolve; R2 and Plain do not.
      expect(assigned.map((d) => ({ operation: d.operation, trigger: d.trigger, ...d.detail }))).toEqual([
        { operation: 'ingest', trigger: 'call', factId: idOf('Ada'), okfType: 'person', writer: 'llm', sourceRef: 'doc.md' },
        { operation: 'ingest', trigger: 'call', factId: idOf('Paris'), okfType: 'place', writer: 'llm', sourceRef: 'doc.md' },
      ]);
    }
  });
});

if (RECORD) {
  it('records the fixture', () => {
    writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + '\n');
  });
}

describe('late emergent resolution (default-host compat, specs/ingest-time-typing §4)', () => {
  it('a slug a later chunk proposes still types an earlier chunk fact, as before the refactor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, db } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('SECOND')
        ? JSON.stringify({ facts: [], ontology_updates: { node_types: [{ type: 'robot', description: 'A robot' }] } })
        : JSON.stringify({ facts: [{ title: 'R2', body: 'r2', tags: [], confidence: 'certain', okf_type: 'robot' }] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'FIRST chunk text here.\n\nSECOND chunk text here.' });
    const rows = await db.getAllAsync<{ title: string; okf_type: string | null }>('SELECT title, okf_type FROM llm_wiki_entries WHERE entity_id = ? AND deleted_at IS NULL', ['e1']);
    expect(rows).toEqual([{ title: 'R2', okf_type: 'robot' }]);
  });
});
