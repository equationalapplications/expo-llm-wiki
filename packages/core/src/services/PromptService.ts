import {
  INGEST_SYSTEM_PROMPT,
  LIBRARIAN_SYSTEM_PROMPT,
  HEAL_SYSTEM_PROMPT,
  ONTOLOGY_BACKFILL_SYSTEM_PROMPT,
} from '../prompts';
import type { DegradedRecord, PromptOverrides, OntologyPromptContext } from '../types';
import {
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_MAX_ANCHORS,
  HEAL_MAX_FACT_BODY_CHARS_L3,
} from '../utils/healConstants';
import { safeSlice } from '../utils/pure';

export class PromptService {
  constructor(private globalOverrides?: PromptOverrides) {}

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
        systemPrompt: this.buildSystemPrompt(template, { documentChunk }, ontologyContext),
        userPrompt: hasDocumentChunk ? 'Please extract the facts.' : `Document Chunk:\n${documentChunk}`,
      };
    }
    return {
      systemPrompt: this.appendOntology(template, ontologyContext),
      userPrompt: `Document Chunk:\n${documentChunk}`,
    };
  }

  buildLibrarianPrompt(
    events: unknown[],
    currentFacts: unknown[],
    runtimeOverride?: string,
    ontologyContext?: OntologyPromptContext | null,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT;
    const hasEvents = /\{\{\s*events\s*\}\}/.test(template);
    const hasCurrentFacts = /\{\{\s*currentFacts\s*\}\}/.test(template);
    if (hasEvents || hasCurrentFacts || this.hasOntologyPlaceholders(template)) {
      return {
        systemPrompt: this.buildSystemPrompt(template, { events, currentFacts }, ontologyContext),
        userPrompt: (hasEvents || hasCurrentFacts)
          ? 'Please synthesize the context.'
          : `Events:\n${JSON.stringify(events, null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`,
      };
    }
    return {
      systemPrompt: this.appendOntology(template, ontologyContext),
      userPrompt: `Events:\n${JSON.stringify(events, null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`,
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
  ): { prompts: { systemPrompt: string; userPrompt: string }; degraded: DegradedRecord[] } {
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

    // L3: truncate each candidate's body independently. A fact whose body
    // is already <= bodyTruncationChars passes through unchanged; the
    // caller sees that fact is absent from `degraded` and can treat the
    // result as if no truncation had occurred.
    const { shapedCandidates, degraded } = applyBodyTruncation(
      healCandidates,
      attemptLevel,
      bodyTruncationChars,
    );

    const template = runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
    if (
      /\{\{\s*healCandidates\s*\}\}/.test(template) ||
      /\{\{\s*documentAnchors\s*\}\}/.test(template) ||
      /\{\{\s*allTasks\s*\}\}/.test(template) ||
      /\{\{\s*recentEvents\s*\}\}/.test(template)
    ) {
      return {
        prompts: {
          systemPrompt: this.hydrate(template, {
            healCandidates: shapedCandidates,
            documentAnchors: effectiveAnchors,
            allTasks: effectiveTasks,
            recentEvents: effectiveEvents,
          }),
          userPrompt: 'Please heal the memory graph.',
        },
        degraded,
      };
    }
    return {
      prompts: {
        systemPrompt: template,
        userPrompt: `Heal Candidates:\n${JSON.stringify(shapedCandidates, null, 2)}\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(effectiveAnchors, null, 2)}\nAll Tasks:\n${JSON.stringify(effectiveTasks, null, 2)}\nRecent Events:\n${JSON.stringify(effectiveEvents, null, 2)}\nThe following document anchors are provided for contradiction detection only. Do not include them in \`downgraded\`, \`deleted\`, or \`newFacts\`.`,
      },
      degraded,
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
}

/**
 * Truncate candidate bodies at L3 only. Each fact is sliced independently;
 * a fact whose body is at or below the cap passes through unchanged. The
 * trailing marker is what the post-reconcile log line references — an
 * operator scanning the log sees the truncation magnitude without
 * re-querying the fact.
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
    const originalBodyChars = body.length;
    // `safeSlice` (utils/pure) keeps the boundary inside a UTF-16 surrogate
    // pair intact — a bare `String.prototype.slice` can land mid-codepoint and
    // emit a lone high surrogate that JSON.stringify turns into U+FFFD. The
    // same hazard is handled for `formatSkipError` log lines in
    // MaintenanceService. Bodies can be emoji-heavy.
    const truncated = `${safeSlice(body, 0, bodyTruncationChars)}…[truncated at ${bodyTruncationChars} chars, original was ${originalBodyChars}]`;
    shapedCandidates.push({ ...fact, body: truncated });
    if (typeof fact.id === 'string') {
      degraded.push({ id: fact.id, originalBodyChars, truncatedBodyChars: bodyTruncationChars });
    }
  }
  return { shapedCandidates, degraded };
}
