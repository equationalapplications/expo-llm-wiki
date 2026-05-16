import { INGEST_SYSTEM_PROMPT, LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT } from '../prompts';
import type { PromptOverrides } from '../types';

export class PromptService {
  constructor(private globalOverrides?: PromptOverrides) {}

  private hydrate(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
      const value = variables[key];
      if (value === undefined) return `{{${key}}}`;
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    });
  }

  buildIngestPrompt(
    documentChunk: string,
    runtimeOverride?: string,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT;
    if (template.includes('{{documentChunk}}')) {
      return {
        systemPrompt: this.hydrate(template, { documentChunk }),
        userPrompt: 'Please extract the facts.',
      };
    }
    return {
      systemPrompt: template,
      userPrompt: `Document Chunk:\n${documentChunk}`,
    };
  }

  buildLibrarianPrompt(
    events: unknown[],
    currentFacts: unknown[],
    runtimeOverride?: string,
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT;
    if (template.includes('{{events}}') || template.includes('{{currentFacts}}')) {
      return {
        systemPrompt: this.hydrate(template, { events, currentFacts }),
        userPrompt: 'Please synthesize the context.',
      };
    }
    return {
      systemPrompt: template,
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
      template.includes('{{healCandidates}}') ||
      template.includes('{{documentAnchors}}') ||
      template.includes('{{allTasks}}') ||
      template.includes('{{recentEvents}}')
    ) {
      return {
        systemPrompt: this.hydrate(template, { healCandidates, documentAnchors, allTasks, recentEvents }),
        userPrompt: 'Please heal the memory graph.',
      };
    }
    return {
      systemPrompt: template,
      userPrompt: `Heal Candidates:\n${JSON.stringify(healCandidates, null, 2)}\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(documentAnchors, null, 2)}\nAll Tasks:\n${JSON.stringify(allTasks, null, 2)}\nRecent Events:\n${JSON.stringify(recentEvents, null, 2)}`,
    };
  }
}
