import type { ReadOptions } from './types';

export interface LibrarianOptions {
  /** If provided, replaces the default Librarian system instructions. */
  systemPrompt?: string;
  /** entity_id -> score multiplier, forwarded to WikiMemory.read() as tierWeights. */
  entityWeights?: Record<string, number>;
  /** Forwarded to WikiMemory.read() for zero-weight filler context. */
  includeZeroWeightEntities?: boolean;
  temperature?: number;
}

export interface LibrarianPromptVariables {
  context: string;
  tasks: string;
  query: string;
}

export const DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT = `You are a careful memory synthesis assistant.
Use only the retrieved context when answering the request.
Preserve source provenance when facts come from different entity namespaces.

Request:
{{query}}

Retrieved context:
{{context}}

Open tasks:
{{tasks}}`;

export function hydrateLibrarianPrompt(
  template: string,
  variables: LibrarianPromptVariables,
): string {
  return template
    .replace(/\{\{context\}\}/g, variables.context)
    .replace(/\{\{tasks\}\}/g, variables.tasks)
    .replace(/\{\{query\}\}/g, variables.query);
}

export function validateLibrarianPromptTemplate(
  template: string,
  options: { custom: boolean; taskCount: number },
): string[] {
  if (!options.custom) return [];

  const warnings: string[] = [];
  if (!template.includes('{{context}}')) {
    warnings.push('Custom Librarian systemPrompt omits {{context}}; retrieved memory will not be injected.');
  }
  if (!template.includes('{{query}}')) {
    warnings.push('Custom Librarian systemPrompt omits {{query}}; the original request will not be injected.');
  }
  if (options.taskCount > 0 && !template.includes('{{tasks}}')) {
    warnings.push('Custom Librarian systemPrompt omits {{tasks}} while retrieved tasks are available.');
  }
  return warnings;
}

export function mapLibrarianOptionsToReadOptions(
  options: Pick<LibrarianOptions, 'entityWeights' | 'includeZeroWeightEntities'>,
): Pick<ReadOptions, 'tierWeights' | 'includeZeroWeightEntities'> {
  const readOptions: Pick<ReadOptions, 'tierWeights' | 'includeZeroWeightEntities'> = {};
  if (options.entityWeights !== undefined) readOptions.tierWeights = options.entityWeights;
  if (options.includeZeroWeightEntities !== undefined) {
    readOptions.includeZeroWeightEntities = options.includeZeroWeightEntities;
  }
  return readOptions;
}
