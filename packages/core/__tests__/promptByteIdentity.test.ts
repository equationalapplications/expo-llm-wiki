import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PromptService } from '../src/services/PromptService';
import { buildOntologyPromptAppendix, buildWriteOntologyAppendix } from '../src/prompts/ontology';
import { resolveGrounding } from '../src/utils/grounding';
import { labelEvents } from '../src/services/librarian/ops/text';
import type { OntologyMode } from '../src/types';

/**
 * Byte-identity pin (specs/type-on-write Test plan 1). The fixture file holds
 * a sha256 and length of every default write prompt and backfill prompt,
 * recorded on the UNMODIFIED code at origin/main dd6e2a4c, before PromptService
 * was touched by the type-on-write step. A prompt that drifts by one byte
 * fails here. Re-record only with RECORD_PROMPT_FIXTURES=1 and only when a
 * spec ruling intends the change.
 */
const FIXTURE = join(__dirname, 'fixtures', 'promptByteIdentity.json');

const MANIFEST = JSON.stringify({
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Residence' }],
}, null, 2);

const PLACEHOLDER_OVERRIDE = 'Custom prompt.\n{{ontologyManifest}}\n{{ontologyModeInstructions}}\nEvents {{events}} Facts {{currentFacts}} Chunk {{documentChunk}} Backfill {{facts}}';
const PLAIN_OVERRIDE = 'Custom plain prompt with no placeholders.';

const modes: Array<OntologyMode> = ['off', 'strict', 'emergent'];
const ctxFor = (mode: OntologyMode) => (mode === 'off' ? null : buildOntologyPromptAppendix(mode, MANIFEST));
const writeCtxFor = (mode: OntologyMode) => (mode === 'off' ? null : buildWriteOntologyAppendix(mode, MANIFEST));

const events = [{ id: 'e1', entity_id: 'u', event_type: 'observation' as const, summary: 'Moved to Seattle in 2020', created_at: 1_700_000_000_000 }];
const facts = [{ id: 'f1', title: 'Home', body: 'Lives in Seattle' }];
const guidances: Array<string | undefined> = [undefined, 'Prefer durable facts.'];
const groundings: Array<[string, ReturnType<typeof resolveGrounding>]> = [
  ['g0', null],
  ['g1', resolveGrounding({ mode: 'draft', writers: ['ingest', 'librarian'] })],
];

function record(): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, text: string) => {
    out[key] = `${createHash('sha256').update(text).digest('hex')}:${text.length}`;
  };
  for (const [gname, grounding] of groundings) {
    for (const [oname, override] of [['none', undefined], ['placeholder', PLACEHOLDER_OVERRIDE], ['plain', PLAIN_OVERRIDE]] as const) {
      for (const mode of modes) {
        for (const [gi, guidance] of guidances.entries()) {
          const base = `${gname}|${oname}|${mode}|guid${gi}`;
          const ps = new PromptService(oname === 'none' ? undefined : { ingestSystemPrompt: override, ontologyBackfillSystemPrompt: override }, grounding);
          const ctx = writeCtxFor(mode);
          const ing = ps.buildIngestPrompt('Doc chunk text', override, ctx, guidance);
          put(`ingest|${base}|sys`, ing.systemPrompt); put(`ingest|${base}|user`, ing.userPrompt);
          const lib = ps.buildLibrarianPrompt(events, facts, override, ctx, guidance);
          put(`librarian|${base}|sys`, lib.systemPrompt); put(`librarian|${base}|user`, lib.userPrompt);
          put(`librarian|${base}|corpus`, JSON.stringify(lib.groundingCorpus ?? null));
          if (oname === 'none') {
            const ops = ps.buildOpsExtractPrompt(labelEvents(events), ctx, guidance);
            put(`opsExtract|${base}|sys`, ops.systemPrompt); put(`opsExtract|${base}|user`, ops.userPrompt);
            put(`opsExtract|${base}|corpus`, JSON.stringify(ops.groundingCorpus ?? null));
          }
          for (const strategy of ['legacy', 'ops'] as const) {
            const t = ps.buildInstructionTemplates(ctx, strategy, guidance, ctxFor(mode));
            for (const k of Object.keys(t) as Array<keyof typeof t>) put(`templates|${strategy}|${base}|${k}`, t[k]);
          }
        }
        const ps = new PromptService(oname === 'none' ? undefined : { ontologyBackfillSystemPrompt: override }, grounding);
        const ctx = ctxFor(mode);
        for (const cand of [undefined, 'Candidates:\n- Seattle']) {
          const bf = ps.buildOntologyBackfillPrompt(facts, override, ctx, cand);
          put(`backfill|${gname}|${oname}|${mode}|${cand ? 'cand' : 'nocand'}|sys`, bf.systemPrompt);
          put(`backfill|${gname}|${oname}|${mode}|${cand ? 'cand' : 'nocand'}|user`, bf.userPrompt);
        }
      }
    }
  }
  return out;
}

describe('prompt byte identity (recorded at dd6e2a4c)', () => {
  it('every write and backfill prompt matches its recorded fixture', () => {
    const actual = record();
    if (process.env.RECORD_PROMPT_FIXTURES === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    const drift = Object.keys(expected).filter((k) => actual[k] !== expected[k]);
    expect(drift).toEqual([]);
  });
  it('covers a meaningful matrix', () => {
    expect(Object.keys(JSON.parse(readFileSync(FIXTURE, 'utf8'))).length).toBeGreaterThan(300);
  });
});
