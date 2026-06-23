import { INGEST_SYSTEM_PROMPT, LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT } from '../prompts';
import type { PromptOverrides, OntologyPromptContext } from '../types';

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

  buildHealPrompt(
    healCandidates: unknown[],
    documentAnchors: unknown[],
    allTasks: unknown[],
    recentEvents: unknown[],
    runtimeOverride?: string,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
    if (
      /\{\{\s*healCandidates\s*\}\}/.test(template) ||
      /\{\{\s*documentAnchors\s*\}\}/.test(template) ||
      /\{\{\s*allTasks\s*\}\}/.test(template) ||
      /\{\{\s*recentEvents\s*\}\}/.test(template)
    ) {
      return {
        systemPrompt: this.hydrate(template, { healCandidates, documentAnchors, allTasks, recentEvents }),
        userPrompt: 'Please heal the memory graph.',
      };
    }
    return {
      systemPrompt: template,
      userPrompt: `Heal Candidates:\n${JSON.stringify(healCandidates, null, 2)}\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(documentAnchors, null, 2)}\nAll Tasks:\n${JSON.stringify(allTasks, null, 2)}\nRecent Events:\n${JSON.stringify(recentEvents, null, 2)}\nThe following document anchors are provided for contradiction detection only. Do not include them in \`downgraded\`, \`deleted\`, or \`newFacts\`.`,
    };
  }
}
