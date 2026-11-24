import type {
  ClassifierQuestion,
  IngestTypingCounters,
  LLMProvider,
  OntologyManifest,
  OntologyMode,
  WikiConfig,
  WikiDiagnosticOperation,
  WikiDiagnosticTrigger,
  WikiOptions,
} from '../../types';
import { resolveSystemOneTypeOnWrite, resolveSystemOneTypeOnIngest } from '../../utils/engineDefaults';
import { classifierStateForFact, validateClassifierAnswer, type ClassifierRejection } from '../../utils/classifier';
import { callClassify } from '../../utils/llmCall';
import { isReservedAbstainSlug, resolveNodeTypeMatch, ONTOLOGY_ABSTAIN_SENTINEL } from '../../utils/ontology';
import { withConcurrency } from '../../utils/pure';
import { WikiBudgetExhausted, type UsageMeter } from '../../utils/usage';
import { isContextOverflowError } from '../BoundedLlmCall';
import { nodeTypeReceipts, shouldEmitOntologyReceipt, type WikiDiagnosticInput } from '../../utils/diagnostics';
import type { EdgeDrop } from '../../utils/ontology';
import type { ExtractedFactEdge, ExtractedFactWithOntology } from '../../types';

/**
 * Upper bound on one classifier choice question (specs/system-one-config §5):
 * manifest slugs plus the abstain sentinel. Owned here so the backfill site
 * and the write site cannot drift; `MaintenanceService` re-exports it.
 */
export const CLASSIFIER_MAX_CHOICES = 255 as const;

/**
 * True when the manifest can be asked as one `choice` question (specs/type-on-write
 * §2, condition 4): at least one node type, at most `CLASSIFIER_MAX_CHOICES - 1`
 * node types (the sentinel takes the last slot), and no slug equal to the
 * reserved abstain sentinel. Shared by the backfill classifier site and the write
 * site.
 */
export function isManifestRepresentable(manifest: OntologyManifest): boolean {
  const slugs = manifest.node_types.map((n) => n.type);
  return slugs.length > 0
    && slugs.length + 1 <= CLASSIFIER_MAX_CHOICES
    && !slugs.some((s) => isReservedAbstainSlug(s));
}

/**
 * Shared engagement predicate (specs/ingest-time-typing §2). Conditions 2-4 of
 * both sites: a `classify` function, an ontology mode other than `'off'`, and a
 * representable manifest, after the site's own key resolved to `'auto'`. Kept
 * in one place so the three sites (librarian, ingest, `getInstructions`) cannot
 * drift.
 */
function typingEngages(
  site: 'auto' | 'llm',
  provider: Pick<LLMProvider, 'classify'>,
  mode: OntologyMode,
  manifest: OntologyManifest,
): boolean {
  return site === 'auto'
    && typeof provider.classify === 'function'
    && mode !== 'off'
    && isManifestRepresentable(manifest);
}

/**
 * Write-time typing engagement (specs/type-on-write §2). Pure. All four must
 * hold: `typeOnWrite: 'auto'`, a `classify` function, an ontology mode other
 * than `'off'`, and a representable manifest.
 */
export function canEngageWriteTyping(
  config: WikiConfig | undefined,
  provider: Pick<LLMProvider, 'classify'>,
  mode: OntologyMode,
  manifest: OntologyManifest,
): boolean {
  return typingEngages(resolveSystemOneTypeOnWrite(config), provider, mode, manifest);
}

/** Ingest-time typing engagement (specs/ingest-time-typing §2): same rule, `typeOnIngest` key. */
export function canEngageIngestTyping(
  config: WikiConfig | undefined,
  provider: Pick<LLMProvider, 'classify'>,
  mode: OntologyMode,
  manifest: OntologyManifest,
): boolean {
  return typingEngages(resolveSystemOneTypeOnIngest(config), provider, mode, manifest);
}

/**
 * The classifier's node-type question: a `choice` over the manifest slugs plus
 * the reserved abstain sentinel (specs/system-one-config §5). One text for the
 * backfill and the write site. Manifest descriptions are host-authored
 * vocabulary, not fact content.
 */
export function buildTypingQuestion(manifest: OntologyManifest): ClassifierQuestion {
  return {
    kind: 'choice',
    options: [...manifest.node_types.map((n) => n.type), ONTOLOGY_ABSTAIN_SENTINEL],
    instructions:
      'Choose the ontology node type that best describes this fact, or choose '
      + `"${ONTOLOGY_ABSTAIN_SENTINEL}" if none of the listed types fits.\n`
      + manifest.node_types.map((n) => `- ${n.type}: ${n.description}`).join('\n'),
  };
}

/** One outcome per asked fact (specs/type-on-write §3). */
export type TypingOutcome =
  | { kind: 'accepted'; okfType: string; confidence: number }
  | { kind: 'abstain' }
  | { kind: 'low_confidence' }
  | { kind: 'invalid'; reason: ClassifierRejection }
  | { kind: 'threw' }
  | { kind: 'overflow_skip' }
  | { kind: 'unattempted' };

export interface TypingFactInput {
  title: string;
  body: string;
  tags: string[];
}

export interface TypingCallContext {
  entityId: string;
  trigger: WikiDiagnosticTrigger;
  meter?: UsageMeter;
  /** `'librarian'` at the write door; ingest passes `'ingest'` (specs/ingest-time-typing §3). */
  operation: WikiDiagnosticOperation;
}

/**
 * True when a candidate's own `okf_type` already resolves against the manifest:
 * a valid model-supplied slug stands and the fact is not asked (§3 skip rule).
 */
export function volunteeredTypeResolves(rawOkfType: unknown, manifest: OntologyManifest): boolean {
  return typeof rawOkfType === 'string' && resolveNodeTypeMatch(rawOkfType, manifest) !== null;
}

/**
 * Ask the host classifier to type each fact (specs/type-on-write §3). One
 * `callClassify` per fact, metered through `ctx.meter`, under the
 * `chunkConcurrency` rule (`opts.concurrency`, when given, replaces the config
 * read: ingest passes its call's resolved value). Makes no database write. `WikiBudgetExhausted`
 * marks that fact and every not-yet-started fact `unattempted`; the step
 * stops asking and never throws for budget.
 */
export async function classifyFactsForWrite(
  options: WikiOptions,
  ctx: TypingCallContext,
  facts: readonly TypingFactInput[],
  manifest: OntologyManifest,
  floor: number,
  opts?: { concurrency?: number },
): Promise<TypingOutcome[]> {
  const question = buildTypingQuestion(manifest);
  const rawConcurrency = opts?.concurrency ?? options.config?.chunkConcurrency ?? 1;
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;
  let stopped = false;
  return withConcurrency<TypingOutcome>(
    facts.map((fact) => async (): Promise<TypingOutcome> => {
      if (stopped) return { kind: 'unattempted' };
      let response;
      try {
        response = await callClassify(
          options,
          { operation: ctx.operation, entityId: ctx.entityId, trigger: ctx.trigger, meter: ctx.meter },
          { state: classifierStateForFact(fact), questions: { okf_type: question } },
        );
      } catch (err) {
        if (err instanceof WikiBudgetExhausted) {
          stopped = true;
          return { kind: 'unattempted' };
        }
        if (isContextOverflowError(err)) return { kind: 'overflow_skip' };
        return { kind: 'threw' };
      }
      const checked = validateClassifierAnswer(response, 'okf_type', question);
      if (!checked.ok) return { kind: 'invalid', reason: checked.reason };
      if (checked.answer.kind !== 'choice') return { kind: 'invalid', reason: 'kind_mismatch' };
      // Sentinel before floor: an abstain at any confidence is a decline.
      if (isReservedAbstainSlug(checked.answer.choice)) return { kind: 'abstain' };
      if (checked.answer.confidence < floor) return { kind: 'low_confidence' };
      return { kind: 'accepted', okfType: checked.answer.choice, confidence: checked.answer.confidence };
    }),
    concurrency,
  );
}

/** Per-pass typing counters (specs/type-on-write §8). Internal: the librarian's report carries them. */
export interface TypingCounters {
  asked: number;
  typed: number;
  abstained: number;
  lowConfidence: number;
  invalid: number;
  skipped: number;
  unattempted: number;
}

/** The public ingest shape: the same counters without the always-zero `unattempted` (ingest has no budget). */
export function toIngestCounters(c: TypingCounters): IngestTypingCounters {
  const { unattempted: _unattempted, ...rest } = c;
  return rest;
}

export function emptyTypingCounters(): TypingCounters {
  return { asked: 0, typed: 0, abstained: 0, lowConfidence: 0, invalid: 0, skipped: 0, unattempted: 0 };
}

/**
 * Fold one outcome into the counters. `asked` counts calls attempted (not
 * `unattempted`); `typed` is incremented by the caller only when the accepted
 * type actually reached the row (a slug that missed the in-transaction manifest
 * is not typed). `skipped` counts overflow skips; `invalid` includes thrown
 * classify calls.
 */
export function tallyTypingOutcome(c: TypingCounters, o: TypingOutcome): void {
  switch (o.kind) {
    case 'unattempted': c.unattempted++; return;
    case 'accepted': c.asked++; return;
    case 'abstain': c.asked++; c.abstained++; return;
    case 'low_confidence': c.asked++; c.lowConfidence++; return;
    case 'invalid': case 'threw': c.asked++; c.invalid++; return;
    case 'overflow_skip': c.asked++; c.skipped++; return;
  }
}

/**
 * The §8 receipt table as a pure mapping for the NON-accepted outcomes. An
 * accepted outcome's receipt (`node_type_assigned` or the door's
 * `node_type_dropped`) depends on the in-transaction re-validation and is
 * produced at the insert site. `unattempted` has no per-fact receipt.
 */
export function typingOutcomeReceipt(
  base: { entityId: string; operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger },
  factId: string,
  outcome: TypingOutcome,
): WikiDiagnosticInput | null {
  switch (outcome.kind) {
    case 'abstain':
      return { ...base, code: 'classification_abstained', detail: { factId, writer: 'classifier' } };
    case 'low_confidence':
      return { ...base, code: 'classification_low_confidence', detail: { factId, reason: 'below_threshold' } };
    case 'invalid':
      return { ...base, code: 'classification_invalid', detail: { factId, reason: outcome.reason } };
    case 'threw':
      return { ...base, code: 'classification_invalid', detail: { factId, reason: 'classify_threw' } };
    case 'overflow_skip':
      return { ...base, code: 'context_overflow_skipped', detail: { factId } };
    default:
      return null;
  }
}

/** The slice of `OntologyService` the write door needs; keeps this module free of a class import. */
export interface WriteNormalizer {
  validateAndNormalizeFact(
    fact: ExtractedFactWithOntology,
    manifest: OntologyManifest,
    opts?: { strict?: boolean; entityId?: string; drops?: EdgeDrop[] },
  ): {
    okf_type: string | null;
    edges: ExtractedFactEdge[];
    match?: { raw: string; canonical: string; via: 'exact' | 'normalize' };
  };
}

/**
 * Normalize one inserted fact at the write door (specs/type-on-write §4, §8),
 * shared by both strategies. The first normalization is today's, on the
 * candidate's own `okf_type`. When it misses and the classifier accepted a
 * type for the candidate, the row is normalized a second time with
 * `{ okf_type: accepted, edges: [] }` against the in-transaction manifest
 * (`edges: []`: edges the model volunteered without a type were already
 * dropped by the first pass and are never revived, step-10 OQ6).
 *
 * Returns the normalization to store, the edge drops, the door receipts (all
 * gated by `shouldEmitOntologyReceipt(mode)`), and whether the classifier's
 * type reached the row.
 */
export function normalizeForWrite(
  ontology: WriteNormalizer | undefined,
  fact: ExtractedFactWithOntology,
  manifest: OntologyManifest,
  mode: OntologyMode,
  outcome: TypingOutcome | undefined,
  base: { entityId: string; operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger },
  factId: string,
): {
  normalized: { okf_type: string | null; edges: ExtractedFactEdge[] };
  drops: EdgeDrop[];
  receipts: WikiDiagnosticInput[];
  typedByClassifier: boolean;
} {
  const drops: EdgeDrop[] = [];
  const receipts: WikiDiagnosticInput[] = [];
  const emit = shouldEmitOntologyReceipt(mode);
  let normalized: { okf_type: string | null; edges: ExtractedFactEdge[]; match?: { raw: string; canonical: string; via: 'exact' | 'normalize' } }
    = ontology?.validateAndNormalizeFact(fact, manifest, { strict: false, drops }) ?? { okf_type: null, edges: [] };
  if (emit) {
    receipts.push(...nodeTypeReceipts(
      base, factId, typeof fact.okf_type === 'string' ? fact.okf_type : '', normalized.okf_type, normalized.match,
    ));
  }
  let typedByClassifier = false;
  // In-transaction mode 'off' (a flip after the engagement check): a stored 'off'
  // row keeps its manifest, so the slug would still resolve; the door therefore
  // checks the mode itself and does not apply the classifier's type (spec §4).
  if (!normalized.okf_type && outcome?.kind === 'accepted' && mode !== 'off') {
    const second = ontology?.validateAndNormalizeFact(
      { ...fact, okf_type: outcome.okfType, edges: [] }, manifest, { strict: false },
    ) ?? { okf_type: null, edges: [] };
    if (emit) {
      // A slug that no longer resolves in-transaction surfaces as the door's own
      // `node_type_dropped`; no new code path.
      receipts.push(...nodeTypeReceipts(base, factId, outcome.okfType, second.okf_type, second.match));
    }
    normalized = { okf_type: second.okf_type, edges: [] };
    if (second.okf_type) {
      typedByClassifier = true;
      if (emit) {
        receipts.push({
          ...base, code: 'node_type_assigned',
          detail: { factId, okfType: second.okf_type, writer: 'classifier', confidence: outcome.confidence },
        });
      }
    }
  } else if (normalized.okf_type) {
    // Generative-typed fact at the write door (OQ4): the audit's third leg.
    if (emit) {
      receipts.push({ ...base, code: 'node_type_assigned', detail: { factId, okfType: normalized.okf_type, writer: 'llm' } });
    }
  }
  // A decline receipt only when the door did not type the row (a model slug that
  // resolved in-transaction beats a non-accepted outcome; no contradictory pair).
  if (outcome && outcome.kind !== 'accepted' && emit && !normalized.okf_type) {
    const r = typingOutcomeReceipt(base, factId, outcome);
    if (r) receipts.push(r);
  }
  return { normalized, drops, receipts, typedByClassifier };
}
