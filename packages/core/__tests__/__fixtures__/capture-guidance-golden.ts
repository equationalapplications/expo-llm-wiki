/**
 * Golden-string capture for specs/librarian-guidance (spec test item 1).
 *
 * Run against the UNMODIFIED builders to commit the pre-change oracle:
 *   pnpm exec tsx __fixtures__/capture-guidance-golden.ts
 * (cwd: packages/core, or pass an absolute out path as argv[2]).
 *
 * After the guidance change, re-running this must diff EMPTY for any
 * host with no guidance configured — a difference is a defect, not an
 * update. The fixture is also loaded by librarianGuidance.test.ts as
 * the parity oracle.
 */
import { writeFileSync } from 'node:fs';
import { PromptService } from '../../src/services/PromptService';
import type { OntologyPromptContext } from '../../src/types';
import type { ResolvedGrounding } from '../../src/utils/grounding';
import type { LabeledEvent } from '../../src/services/librarian/ops/text';

const ONTOLOGY: OntologyPromptContext = {
  ontologyModeInstructions: 'ONTOLOGY-MODE-INSTRUCTIONS-SENTINEL',
} as unknown as OntologyPromptContext;

const GROUNDING: ResolvedGrounding = {
  writers: new Set(['ingest', 'librarian', 'heal']),
  minEvidenceChars: 20,
  maxEvidence: 3,
  maxEvidenceChars: 200,
};

const EVENTS: LabeledEvent[] = [
  { label: 'note', at: '2026-11-01T00:00:00.000Z', event: { event_type: 'note', summary: 'EVENT-SUMMARY-SENTINEL' } } as unknown as LabeledEvent,
];

const CHUNK = 'DOCUMENT-CHUNK-SENTINEL';

function captures(): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const plain = new PromptService();
  const overridden = new PromptService({
    ingestSystemPrompt: 'INGEST-OVERRIDE {{documentChunk}}',
  });
  const grounded = new PromptService(undefined, GROUNDING);

  for (const [name, svc] of [['plain', plain], ['overridden', overridden], ['grounded', grounded]] as const) {
    out[`ingest/${name}/default`] = svc.buildIngestPrompt(CHUNK);
    out[`ingest/${name}/runtimeOverride`] = svc.buildIngestPrompt(CHUNK, 'RUNTIME-OVERRIDE {{documentChunk}}');
    out[`ingest/${name}/ontology`] = svc.buildIngestPrompt(CHUNK, undefined, ONTOLOGY);
    if (name !== 'overridden') out[`librarian/${name}/builtin`] = svc.buildLibrarianPrompt(EVENTS, []);
    out[`librarian/${name}/runtimeOverride`] = svc.buildLibrarianPrompt(EVENTS, [], 'RUNTIME-OVERRIDE {{events}}');
    if (name !== 'overridden') out[`librarian/${name}/ontology`] = svc.buildLibrarianPrompt(EVENTS, [], undefined, ONTOLOGY);
    out[`opsExtract/${name}`] = svc.buildOpsExtractPrompt(EVENTS);
    out[`opsExtract/${name}/ontology`] = svc.buildOpsExtractPrompt(EVENTS, ONTOLOGY);
  }

  out['instructions/plain/legacy'] = plain.buildInstructionTemplates(null, 'legacy');
  out['instructions/plain/ops'] = plain.buildInstructionTemplates(null, 'ops');
  out['instructions/overridden/ops'] = overridden.buildInstructionTemplates(ONTOLOGY, 'ops');

  return out;
}

const outPath = process.argv[2] ?? new URL('./guidance-golden.json', import.meta.url).pathname;
writeFileSync(outPath, `${JSON.stringify(captures(), null, 2)}\n`);
console.log(`wrote ${outPath}`);
