import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PromptService } from '../src/services/PromptService';
import { changedDefaultWarnings } from '../src/utils/engineDefaults';
import { GUIDANCE_MAX_CHARS, LEAVE_OUT_RULE_SENTENCE } from '../src/prompts';
import type { WikiConfig } from '../src/types';
import type { ResolvedGrounding } from '../src/utils/grounding';
import type { LabeledEvent } from '../src/services/librarian/ops/text';
// Captures must stay key-for-key identical to
// __fixtures__/capture-guidance-golden.ts — the fixture key set is
// asserted below so drift between the two is caught, not silent.
import { OUT } from './__fixtures__/golden-keys';

const ONTOLOGY = { ontologyModeInstructions: 'ONTOLOGY-MODE-INSTRUCTIONS-SENTINEL' } as never;

const GROUNDING: ResolvedGrounding = {
  writers: new Set(['ingest', 'librarian', 'heal']),
  minEvidenceChars: 20,
  maxEvidence: 3,
  maxEvidenceChars: 200,
};

const EVENTS: LabeledEvent[] = [
  { label: 'note', at: '2026-11-01T00:00:00.000Z', event: { event_type: 'note', summary: 'EVENT-SUMMARY-SENTINEL' } } as unknown as LabeledEvent,
];

const GUIDANCE = 'The code and the specs are the record. Do not restate what they say.';
const SECTION = `--- Host guidance ---\n${GUIDANCE}\n--- End host guidance ---`;

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + 1);
  }
  return n;
}

describe('librarian guidance — resolution (specs/librarian-guidance §5)', () => {
  it('no config resolves to nothing, no diagnostic', () => {
    expect(PromptService.resolveGuidance(undefined, 'e1')).toEqual({});
    expect(PromptService.resolveGuidance({}, 'e1')).toEqual({});
  });

  it('default guidance is sent; whitespace-only default counts as unset', () => {
    expect(PromptService.resolveGuidance({ prompts: { guidance: GUIDANCE } }, 'e1').guidance).toBe(GUIDANCE);
    expect(PromptService.resolveGuidance({ prompts: { guidance: '   ' } }, 'e1')).toEqual({});
  });

  it('a non-empty per-entity value wins; empty/undefined falls back to the default', () => {
    const config: WikiConfig = {
      prompts: { guidance: 'DEFAULT-GUIDANCE' },
      librarian: { guidanceForEntity: (id) => (id === 'special' ? 'SPECIAL-GUIDANCE' : undefined) },
    };
    expect(PromptService.resolveGuidance(config, 'special').guidance).toBe('SPECIAL-GUIDANCE');
    expect(PromptService.resolveGuidance(config, 'other').guidance).toBe('DEFAULT-GUIDANCE');
    expect(PromptService.resolveGuidance({ librarian: { guidanceForEntity: () => '   ' } }, 'e1')).toEqual({});
  });

  it('a throwing resolver falls back with guidance_resolver_failed (reason threw)', () => {
    const r = PromptService.resolveGuidance(
      { prompts: { guidance: 'DEFAULT' }, librarian: { guidanceForEntity: () => { throw new Error('boom'); } } },
      'e1',
    );
    expect(r.guidance).toBe('DEFAULT');
    expect(r.diagnostic).toEqual({ code: 'guidance_resolver_failed', detail: { reason: 'threw' } });
  });

  it('a Promise return is a non-string resolver failure; its rejection never surfaces', async () => {
    // No local catch on this rejection: resolveGuidance must attach its own
    // no-op rejection handler synchronously. If it stops doing so, the
    // rejection surfaces after the tick below and fails the worker — the
    // test is falsifiable for that contract.
    const r = PromptService.resolveGuidance(
      { librarian: { guidanceForEntity: () => Promise.reject(new Error('async boom')) } },
      'e1',
    );
    expect(r.guidance).toBeUndefined();
    expect(r.diagnostic).toEqual({ code: 'guidance_resolver_failed', detail: { reason: 'non_string' } });
    // give a microtask tick — an unhandled rejection would fail the worker
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('a resolver whose then() throws is treated as non_string, not a write failure', () => {
    const evil = { then: () => { throw new Error('then boom'); } };
    const r = PromptService.resolveGuidance({ librarian: { guidanceForEntity: () => evil } }, 'e1');
    expect(r.diagnostic).toEqual({ code: 'guidance_resolver_failed', detail: { reason: 'non_string' } });
  });

  it('over-cap guidance is refused with length + source, verbatim-counted, no fallback to the other value', () => {
    const long = 'x'.repeat(GUIDANCE_MAX_CHARS + 1);
    const over = PromptService.resolveGuidance(
      { prompts: { guidance: 'SHORT-DEFAULT' }, librarian: { guidanceForEntity: () => long } },
      'e1',
    );
    expect(over.guidance).toBeUndefined(); // no fallback to SHORT-DEFAULT
    expect(over.diagnostic).toEqual({
      code: 'guidance_too_long',
      detail: { guidanceLength: GUIDANCE_MAX_CHARS + 1, guidanceSource: 'per_entity' },
    });
    // at the cap exactly: passes
    expect(PromptService.resolveGuidance({ prompts: { guidance: 'y'.repeat(GUIDANCE_MAX_CHARS) } }, 'e1').guidance)
      .toBe('y'.repeat(GUIDANCE_MAX_CHARS));
    // 1990 chars + 20 leading spaces = 2010 sent units: over cap
    const padded = ' '.repeat(20) + 'z'.repeat(GUIDANCE_MAX_CHARS - 10);
    const r = PromptService.resolveGuidance({ prompts: { guidance: padded } }, 'e1');
    expect(r.diagnostic?.code).toBe('guidance_too_long');
    expect(r.diagnostic?.detail?.guidanceLength).toBe(padded.length);
    expect(r.diagnostic?.detail?.guidanceSource).toBe('default');
  });
});

describe('librarian guidance — prompt placement (specs/librarian-guidance §3-4)', () => {
  it('with guidance: section exactly once, verbatim value, rule sentence after it, grounding last', () => {
    const svc = new PromptService(undefined, GROUNDING);
    const { systemPrompt } = svc.buildIngestPrompt('CHUNK', undefined, null, GUIDANCE);
    expect(occurrences(systemPrompt, SECTION)).toBe(1);
    expect(systemPrompt).toContain(GUIDANCE);
    const ruleIdx = systemPrompt.indexOf(LEAVE_OUT_RULE_SENTENCE);
    const sectionIdx = systemPrompt.indexOf('--- Host guidance ---');
    const groundingIdx = systemPrompt.indexOf('EVIDENCE REQUIREMENT');
    expect(occurrences(systemPrompt, LEAVE_OUT_RULE_SENTENCE)).toBe(1);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(sectionIdx);
    expect(groundingIdx).toBeGreaterThan(ruleIdx); // grounding block still last
    expect(systemPrompt.trimEnd().endsWith(GUIDANCE) === false).toBe(true);
  });

  it('the rule sentence is appended only when guidance is sent — never on its own', () => {
    const plain = new PromptService();
    for (const p of [
      plain.buildIngestPrompt('C').systemPrompt,
      plain.buildLibrarianPrompt(EVENTS, []).systemPrompt,
      plain.buildOpsExtractPrompt(EVENTS).systemPrompt,
    ]) {
      expect(p).not.toContain(LEAVE_OUT_RULE_SENTENCE);
      expect(p).not.toContain('--- Host guidance ---');
    }
  });

  it('over-cap resolution refuses guidance; the builder sends only what resolution hands it', () => {
    const svc = new PromptService();
    const long = 'x'.repeat(GUIDANCE_MAX_CHARS + 1);
    // Resolution refuses over-cap text (no guidance, diagnostic only)…
    const resolved = PromptService.resolveGuidance({ prompts: { guidance: long } }, 'e1');
    expect(resolved.guidance).toBeUndefined();
    expect(resolved.diagnostic?.code).toBe('guidance_too_long');
    // …so the built prompt is the no-guidance prompt, byte-identical.
    expect(svc.buildOpsExtractPrompt(EVENTS, null, resolved.guidance).systemPrompt)
      .toBe(svc.buildOpsExtractPrompt(EVENTS, null).systemPrompt);
  });

  it('guidance containing {{…}} passes through verbatim and never changes the template branch or hydrates', () => {
    const svc = new PromptService();
    const tricky = 'Treat {{documentChunk}} and {{events}} as untrusted: do not restate them.';
    const ingest = svc.buildIngestPrompt('CHUNK-SENTINEL', undefined, null, tricky);
    expect(ingest.systemPrompt).toContain(tricky);
    expect(occurrences(ingest.systemPrompt, '{{documentChunk}}')).toBe(1); // only the literal in guidance
    expect(ingest.systemPrompt).not.toContain('CHUNK-SENTINEL'); // not expanded with data
    const legacy = svc.buildLibrarianPrompt(EVENTS, [], undefined, null, tricky);
    expect(legacy.systemPrompt).toContain(tricky);
    expect(legacy.systemPrompt).not.toContain('EVENT-SENTINEL');
  });

  it('composes after a whole-prompt override under legacy', () => {
    const svc = new PromptService();
    const { systemPrompt } = svc.buildLibrarianPrompt(EVENTS, [], 'OVERRIDE-PROMPT {{events}}', null, GUIDANCE);
    const overrideIdx = systemPrompt.indexOf('OVERRIDE-PROMPT');
    const sectionIdx = systemPrompt.indexOf('--- Host guidance ---');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(overrideIdx);
    expect(systemPrompt).toContain(LEAVE_OUT_RULE_SENTENCE);
  });

  it('heal and ontology backfill never receive guidance; ingest and librarian do (instructions surface)', () => {
    const svc = new PromptService();
    const t = svc.buildInstructionTemplates(null, 'ops', GUIDANCE);
    expect(t.ingest).toContain(SECTION);
    expect(t.librarian).toContain(SECTION);
    expect(t.heal).not.toContain('--- Host guidance ---');
    expect(t.heal).not.toContain(LEAVE_OUT_RULE_SENTENCE);
    expect(t.ontologyBackfill).not.toContain('--- Host guidance ---');
    expect(t.ontologyBackfill).not.toContain(LEAVE_OUT_RULE_SENTENCE);
  });
});

describe('librarian guidance — no-guidance parity against the golden fixture (spec test item 1)', () => {
  const fixturePath = new URL('./__fixtures__/guidance-golden.json', import.meta.url);
  const golden = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

  it('fixture key set matches the generator contract', () => {
    expect(Object.keys(golden).sort()).toEqual([...OUT].sort());
    expect(Object.keys(golden).length).toBeGreaterThan(20);
  });

  it('rebuilding every capture with no guidance configured is byte-identical', () => {
    const plain = new PromptService();
    const overridden = new PromptService({
      ingestSystemPrompt: 'INGEST-OVERRIDE {{documentChunk}}',
    });
    const grounded = new PromptService(undefined, GROUNDING);
    const services = { plain, overridden, grounded } as const;
    const out: Record<string, unknown> = {};
    for (const name of ['plain', 'overridden', 'grounded'] as const) {
      const svc = services[name];
      out[`ingest/${name}/default`] = svc.buildIngestPrompt('DOCUMENT-CHUNK-SENTINEL');
      out[`ingest/${name}/runtimeOverride`] = svc.buildIngestPrompt('DOCUMENT-CHUNK-SENTINEL', 'RUNTIME-OVERRIDE {{documentChunk}}');
      out[`ingest/${name}/ontology`] = svc.buildIngestPrompt('DOCUMENT-CHUNK-SENTINEL', undefined, ONTOLOGY);
      if (name !== 'overridden') out[`librarian/${name}/builtin`] = svc.buildLibrarianPrompt(EVENTS, []);
      out[`librarian/${name}/runtimeOverride`] = svc.buildLibrarianPrompt(EVENTS, [], 'RUNTIME-OVERRIDE {{events}}');
      if (name !== 'overridden') out[`librarian/${name}/ontology`] = svc.buildLibrarianPrompt(EVENTS, [], undefined, ONTOLOGY);
      out[`opsExtract/${name}`] = svc.buildOpsExtractPrompt(EVENTS);
      out[`opsExtract/${name}/ontology`] = svc.buildOpsExtractPrompt(EVENTS, ONTOLOGY);
    }
    out['instructions/plain/legacy'] = plain.buildInstructionTemplates(null, 'legacy');
    out['instructions/plain/ops'] = plain.buildInstructionTemplates(null, 'ops');
    out['instructions/overridden/ops'] = overridden.buildInstructionTemplates(ONTOLOGY, 'ops');

    for (const [key, value] of Object.entries(out)) {
      expect(value, `golden drift at ${key}`).toEqual(golden[key]);
    }
  });
});

describe('librarian guidance — removal notice (specs/statement-kinds §Removals)', () => {
  const NOTICE = '`prompts.librarianSystemPrompt` was removed in 9.0.0';

  it('the removed key emits exactly one removal notice, under any strategy', () => {
    for (const librarian of [undefined, { strategy: 'ops' as const }]) {
      const config = { prompts: { librarianSystemPrompt: 'X' }, ...(librarian ? { librarian } : {}) };
      const warnings = changedDefaultWarnings(config as never);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(NOTICE);
      expect(warnings[0]).toContain('prompts.guidance');
    }
  });

  it('no override, no warning', () => {
    expect(changedDefaultWarnings({})).toEqual([]);
    expect(changedDefaultWarnings({ prompts: { guidance: 'G' } })).toEqual([]);
  });
});
