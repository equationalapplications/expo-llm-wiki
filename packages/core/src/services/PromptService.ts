import {
  INGEST_SYSTEM_PROMPT,
  LIBRARIAN_SYSTEM_PROMPT,
  HEAL_SYSTEM_PROMPT,
  ONTOLOGY_BACKFILL_SYSTEM_PROMPT,
  groundingEvidenceBlock,
} from '../prompts';
import type { DegradedRecord, PromptOverrides, OntologyPromptContext, WikiInstructions } from '../types';
import {
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_ANCHOR_BODY_CHARS,
  HEAL_MAX_ANCHORS,
  HEAL_MAX_FACT_BODY_CHARS_L3,
} from '../utils/healConstants';
import { safeSlice } from '../utils/pure';
import {
  buildGroundingCorpus,
  type GroundingWriter,
  type ResolvedGrounding,
} from '../utils/grounding';

export class PromptService {
  constructor(
    private globalOverrides?: PromptOverrides,
    private grounding: ResolvedGrounding | null = null,
  ) {}

  /** The resolved grounding config when `writer` is in `grounding.writers`; otherwise null (spec §6.2). */
  groundingFor(writer: GroundingWriter): ResolvedGrounding | null {
    return this.grounding?.writers.has(writer) ? this.grounding : null;
  }

  /** Appended after any override and after ontology context, so it is always last. */
  private appendGrounding(systemPrompt: string, writer: GroundingWriter): string {
    const cfg = this.groundingFor(writer);
    return cfg ? `${systemPrompt}\n\n${groundingEvidenceBlock(writer, cfg)}` : systemPrompt;
  }

  private hydrate(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
      const value = variables[key];
      if (value === undefined) return _match;
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    });
  }

  private hasOntologyPlaceholders(template: string): boolean {
    return /\{\{\s*ontology(?:Manifest|ModeInstructions)\s*\}\}/.test(template);
  }

  private buildSystemPrompt(
    template: string,
    variables: Record<string, unknown>,
    ontologyContext: OntologyPromptContext | null | undefined,
  ): string {
    const shouldHydrate = Object.keys(variables).some((key) =>
      new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(template),
    ) || (ontologyContext != null && this.hasOntologyPlaceholders(template));

    const hydrated = shouldHydrate
      ? this.hydrate(template, { ...variables, ...(ontologyContext ?? {}) })
      : template;

    return this.hasOntologyPlaceholders(template)
      ? (ontologyContext != null
          ? hydrated
          : hydrated.replace(/\{\{\s*ontology(?:Manifest|ModeInstructions)\s*\}\}/g, ''))
      : this.appendOntology(hydrated, ontologyContext);
  }

  private appendOntology(systemPrompt: string, ctx: OntologyPromptContext | null | undefined): string {
    if (!ctx) return systemPrompt;
    return `${systemPrompt}\n\n${ctx.ontologyModeInstructions}`;
  }

  buildIngestPrompt(
    documentChunk: string,
    runtimeOverride?: string,
    ontologyContext?: OntologyPromptContext | null,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT;
    const hasDocumentChunk = /\{\{\s*documentChunk\s*\}\}/.test(template);
    if (hasDocumentChunk || this.hasOntologyPlaceholders(template)) {
      return {
        systemPrompt: this.appendGrounding(this.buildSystemPrompt(template, { documentChunk }, ontologyContext), 'ingest'),
        userPrompt: hasDocumentChunk ? 'Please extract the facts.' : `Document Chunk:\n${documentChunk}`,
      };
    }
    return {
      systemPrompt: this.appendGrounding(this.appendOntology(template, ontologyContext), 'ingest'),
      userPrompt: `Document Chunk:\n${documentChunk}`,
    };
  }

  buildLibrarianPrompt(
    events: unknown[],
    currentFacts: unknown[],
    runtimeOverride?: string,
    ontologyContext?: OntologyPromptContext | null,
  ): { systemPrompt: string; userPrompt: string; groundingCorpus?: string[] } {
    const template = runtimeOverride ?? this.globalOverrides?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT;
    const hasEvents = /\{\{\s*events\s*\}\}/.test(template);
    const hasCurrentFacts = /\{\{\s*currentFacts\s*\}\}/.test(template);
    // grounding: spec §6.3, event summaries only — the "Current Facts" shown
    // beside them are excluded so a new inference cannot be grounded by an
    // earlier one. A template that places {{currentFacts}} without {{events}}
    // never shows the events, so they are not in the corpus either.
    const eventsShown = hasEvents || !hasCurrentFacts;
    const corpusField = this.groundingFor('librarian')
      ? { groundingCorpus: buildGroundingCorpus(eventsShown ? events.map(summaryOf) : []) }
      : {};
    if (hasEvents || hasCurrentFacts || this.hasOntologyPlaceholders(template)) {
      return {
        systemPrompt: this.appendGrounding(this.buildSystemPrompt(template, { events, currentFacts }, ontologyContext), 'librarian'),
        userPrompt: (hasEvents || hasCurrentFacts)
          ? 'Please synthesize the context.'
          : `Events:\n${JSON.stringify(events, null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`,
        ...corpusField,
      };
    }
    return {
      systemPrompt: this.appendGrounding(this.appendOntology(template, ontologyContext), 'librarian'),
      userPrompt: `Events:\n${JSON.stringify(events, null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`,
      ...corpusField,
    };
  }

  /**
   * Heal-prompt level interpretation for the `attemptLevel` ladder.
   *
   * Caller contract: `documentAnchors` may be a slice sized for `batch.length`
   * or a larger set (e.g. a cache hit from `_selectHealAnchors`). This function
   * applies the prompt-side anchor cap `min(HEAL_MAX_ANCHORS=50, batch.length
   * * HEAL_ANCHORS_PER_CANDIDATE=4)` so the rendered prompt is bounded
   * regardless of caller input. `HEAL_MAX_ANCHORS` and
   * `HEAL_ANCHORS_PER_CANDIDATE` live here too — keeping the formula
   * co-located with its application avoids a "MaintenanceService policy"
   * import cycle (`PromptService` is constructed before `MaintenanceService`
   * exists) and makes the cap testable without a `MaintenanceService`
   * instance. Task 3 exports the same two constants from `MaintenanceService`
   * for caller-side overfetch sizing; the values must match.
   *
   * Level semantics:
   * - L0: allTasks + recentEvents + full candidate bodies; anchors re-capped
   * - L1: drop allTasks; recentEvents present; candidate bodies full
   * - L2: drop allTasks and recentEvents; candidate bodies full
   * - L3: drop allTasks and recentEvents; truncate each candidate body to
   *   `bodyTruncationChars` and emit a `degraded` record per truncated fact
   */
  buildHealPrompt(
    healCandidates: unknown[],
    documentAnchors: unknown[],
    allTasks: unknown[],
    recentEvents: unknown[],
    runtimeOverride: string | undefined,
    attemptLevel: 0 | 1 | 2 | 3,
    bodyTruncationChars: number = HEAL_MAX_FACT_BODY_CHARS_L3,
  ): { prompts: { systemPrompt: string; userPrompt: string }; degraded: DegradedRecord[]; groundingCorpus?: string[] } {
    // L0: all context. L1: drop allTasks. L2: also drop recentEvents.
    const effectiveTasks = attemptLevel >= 1 ? [] : allTasks;
    const effectiveEvents = attemptLevel >= 2 ? [] : recentEvents;

    // L0 anchor cap: min(HEAL_MAX_ANCHORS, batch.length * HEAL_ANCHORS_PER_CANDIDATE).
    // The caller is responsible for sizing the documentAnchors slice; we re-cap
    // here in case the caller passed a superset (e.g. from _selectHealAnchors
    // cache). Constants live in utils/healConstants so PromptService and
    // MaintenanceService cannot drift apart (spec: "values must match").
    const maxAnchors = Math.max(1, Math.min(HEAL_MAX_ANCHORS, healCandidates.length * HEAL_ANCHORS_PER_CANDIDATE));
    const effectiveAnchors = documentAnchors.slice(0, maxAnchors);

    const template = runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
    const hasRecentEvents = /\{\{\s*recentEvents\s*\}\}/.test(template);
    const hasDocumentAnchors = /\{\{\s*documentAnchors\s*\}\}/.test(template);
    const usesPlaceholders =
      /\{\{\s*healCandidates\s*\}\}/.test(template) ||
      hasDocumentAnchors ||
      /\{\{\s*allTasks\s*\}\}/.test(template) ||
      hasRecentEvents;

    // grounding: only when heal is a grounding writer do anchors show a
    // clipped body, and the corpus is built from exactly what this prompt
    // shows (spec §6.3, rev 7). A placeholder template shows a source only
    // when it places that source's placeholder. lifecycle_status decides
    // corpus membership but is never shown to the model.
    const healGrounding = this.groundingFor('heal');
    const promptAnchors = healGrounding ? effectiveAnchors.map(toGroundingAnchor) : effectiveAnchors;
    const eventsShown = !usesPlaceholders || hasRecentEvents;
    const anchorsShown = !usesPlaceholders || hasDocumentAnchors;
    const groundingCorpus = healGrounding
      ? buildGroundingCorpus([
          ...(eventsShown ? effectiveEvents.map(summaryOf) : []),
          ...(anchorsShown
            ? effectiveAnchors
                .map((a, i) => ({ status: (a as { lifecycle_status?: unknown } | null)?.lifecycle_status, shown: promptAnchors[i] }))
                .filter((x) => x.status !== 'draft')
                .map((x) => (x.shown as { body?: unknown } | null)?.body)
            : []),
        ])
      : null;

    // L3: truncate each candidate's body independently. A fact whose body
    // is already <= bodyTruncationChars passes through unchanged; the
    // caller sees that fact is absent from `degraded` and can treat the
    // result as if no truncation had occurred.
    const { shapedCandidates, degraded } = applyBodyTruncation(
      healCandidates,
      attemptLevel,
      bodyTruncationChars,
    );
    const corpusField = groundingCorpus !== null ? { groundingCorpus } : {}; // grounding

    if (usesPlaceholders) {
      return {
        prompts: {
          systemPrompt: this.appendGrounding(this.hydrate(template, {
            healCandidates: shapedCandidates,
            documentAnchors: promptAnchors,
            allTasks: effectiveTasks,
            recentEvents: effectiveEvents,
          }), 'heal'),
          userPrompt: 'Please heal the memory graph.',
        },
        degraded,
        ...corpusField,
      };
    }
    return {
      prompts: {
        systemPrompt: this.appendGrounding(template, 'heal'),
        userPrompt: `Heal Candidates:\n${JSON.stringify(shapedCandidates, null, 2)}\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(promptAnchors, null, 2)}\nAll Tasks:\n${JSON.stringify(effectiveTasks, null, 2)}\nRecent Events:\n${JSON.stringify(effectiveEvents, null, 2)}\nThe following document anchors are provided for contradiction detection only. Do not include them in \`downgraded\`, \`deleted\`, or \`newFacts\`.`,
      },
      degraded,
      ...corpusField,
    };
  }

  buildOntologyBackfillPrompt(
    facts: unknown[],
    runtimeOverride?: string,
    ontologyContext?: OntologyPromptContext | null,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.ontologyBackfillSystemPrompt ?? ONTOLOGY_BACKFILL_SYSTEM_PROMPT;
    const hasFacts = /\{\{\s*facts\s*\}\}/.test(template);
    if (hasFacts || this.hasOntologyPlaceholders(template)) {
      return {
        systemPrompt: this.buildSystemPrompt(template, { facts }, ontologyContext),
        userPrompt: hasFacts ? 'Please classify the facts.' : `Facts:\n${JSON.stringify(facts, null, 2)}`,
      };
    }
    return {
      systemPrompt: this.appendOntology(template, ontologyContext),
      userPrompt: `Facts:\n${JSON.stringify(facts, null, 2)}`,
    };
  }

  /**
   * The system prompt each writer would send, without hydrating data (spec
   * §8.3). `buildSystemPrompt` with no variables hydrates only ontology
   * placeholders and leaves data placeholders verbatim; heal never receives
   * ontology context, matching `buildHealPrompt`.
   */
  buildInstructionTemplates(ontologyContext: OntologyPromptContext | null): WikiInstructions {
    const o = this.globalOverrides;
    return {
      ingest: this.appendGrounding(this.buildSystemPrompt(o?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT, {}, ontologyContext), 'ingest'),
      librarian: this.appendGrounding(this.buildSystemPrompt(o?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT, {}, ontologyContext), 'librarian'),
      heal: this.appendGrounding(o?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT, 'heal'),
      ontologyBackfill: this.buildSystemPrompt(o?.ontologyBackfillSystemPrompt ?? ONTOLOGY_BACKFILL_SYSTEM_PROMPT, {}, ontologyContext),
    };
  }
}

/**
 * Truncate candidate bodies at L3 only. Each fact is sliced independently;
 * a fact whose body is at or below the cap passes through unchanged. The
 * trailing marker is what the post-reconcile log line references — an
 * operator scanning the log sees the truncation magnitude without
 * re-querying the fact.
 *
 * A candidate that needs truncation but lacks a string id passes through
 * untruncated: the upstream contract (`WikiFact.id` is a `TEXT PRIMARY KEY`)
 * guarantees string ids in practice, and truncating without an id would
 * emit a body the model can verdict under but with no DegradedRecord for
 * `MaintenanceService.doRunHeal` to reconcile — violating the
 * degraded ⊥ skipped invariant on id.
 */
function applyBodyTruncation(
  candidates: unknown[],
  attemptLevel: 0 | 1 | 2 | 3,
  bodyTruncationChars: number,
): { shapedCandidates: unknown[]; degraded: DegradedRecord[] } {
  if (attemptLevel < 3) {
    return { shapedCandidates: candidates, degraded: [] };
  }
  const shapedCandidates: unknown[] = [];
  const degraded: DegradedRecord[] = [];
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) {
      shapedCandidates.push(c);
      continue;
    }
    const fact = c as { id?: unknown; body?: unknown };
    const body = typeof fact.body === 'string' ? fact.body : '';
    if (body.length <= bodyTruncationChars) {
      shapedCandidates.push(c);
      continue;
    }
    // A candidate that needs L3 truncation must carry a string id so
    // doRunHeal can reconcile the truncation back to the source row
    // (`HealResult.degraded` is keyed by id, and degraded ⊥ skipped on id).
    // Without one the candidate passes through untruncated — the invariant
    // "every truncated candidate has a DegradedRecord" holds, and the
    // upstream contract (WikiFact.id is a TEXT PRIMARY KEY) means this
    // branch is defensive against future schema drift, not a happy path.
    if (typeof fact.id !== 'string') {
      shapedCandidates.push(c);
      continue;
    }
    const originalBodyChars = body.length;
    // `safeSlice` (utils/pure) keeps the boundary inside a UTF-16 surrogate
    // pair intact — a bare `String.prototype.slice` can land mid-codepoint and
    // emit a lone high surrogate that JSON.stringify turns into U+FFFD. The
    // same hazard is handled for `formatSkipError` log lines in
    // MaintenanceService. Bodies can be emoji-heavy. The returned prefix may
    // be one or two chars shorter than `bodyTruncationChars` when the cut
    // backs off the surrogate boundary, so `truncatedBodyChars` reads from
    // `prefix.length` rather than the requested limit.
    const prefix = safeSlice(body, 0, bodyTruncationChars);
    const truncatedBodyChars = prefix.length;
    const truncated = `${prefix}…[truncated at ${truncatedBodyChars} chars, original was ${originalBodyChars}]`;
    shapedCandidates.push({ ...fact, body: truncated });
    degraded.push({ id: fact.id, originalBodyChars, truncatedBodyChars });
  }
  return { shapedCandidates, degraded };
}

/** An event's `summary` — the only event field that enters a grounding corpus (spec §6.3). */
function summaryOf(event: unknown): unknown {
  return (event as { summary?: unknown } | null)?.summary;
}

/** Prompt shape of a heal anchor when heal is a grounding writer: body clipped, lifecycle_status hidden. */
function toGroundingAnchor(anchor: unknown): unknown {
  if (typeof anchor !== 'object' || anchor === null) return anchor;
  const a = anchor as { id?: unknown; title?: unknown; source_ref?: unknown; body?: unknown };
  return {
    id: a.id,
    title: a.title,
    source_ref: a.source_ref,
    body: typeof a.body === 'string' ? safeSlice(a.body, 0, HEAL_ANCHOR_BODY_CHARS) : '',
  };
}
