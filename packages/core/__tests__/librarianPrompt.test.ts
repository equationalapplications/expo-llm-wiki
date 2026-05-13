import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT,
  hydrateLibrarianPrompt,
  mapLibrarianOptionsToReadOptions,
  validateLibrarianPromptTemplate,
} from '../src/librarianPrompt';

describe('librarian prompt contract utilities', () => {
  it('default prompt includes the stable template variables', () => {
    expect(DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT).toContain('{{query}}');
    expect(DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT).toContain('{{context}}');
    expect(DEFAULT_LIBRARIAN_SYNTHESIS_PROMPT).toContain('{{tasks}}');
  });

  it('hydrates query, context, and tasks without changing instructions', () => {
    const prompt = hydrateLibrarianPrompt('Q: {{query}}\nC: {{context}}\nT: {{tasks}}', {
      query: 'Which source should I trust?',
      context: '- fact',
      tasks: '- task',
    });

    expect(prompt).toBe('Q: Which source should I trust?\nC: - fact\nT: - task');
  });

  it('warns when a custom prompt omits context or query', () => {
    expect(validateLibrarianPromptTemplate('Only tasks: {{tasks}}', { custom: true, taskCount: 1 }))
      .toEqual([
        'Custom Librarian systemPrompt omits {{context}}; retrieved memory will not be injected.',
        'Custom Librarian systemPrompt omits {{query}}; the original request will not be injected.',
      ]);
  });

  it('warns about omitted tasks only when tasks exist', () => {
    expect(validateLibrarianPromptTemplate('{{query}} {{context}}', { custom: true, taskCount: 2 }))
      .toEqual(['Custom Librarian systemPrompt omits {{tasks}} while retrieved tasks are available.']);
    expect(validateLibrarianPromptTemplate('{{query}} {{context}}', { custom: true, taskCount: 0 }))
      .toEqual([]);
  });

  it('maps app-facing entityWeights to read tierWeights', () => {
    expect(mapLibrarianOptionsToReadOptions({
      entityWeights: { tier_wisdom: 2 },
      includeZeroWeightEntities: true,
      temperature: 0.2,
    })).toEqual({
      tierWeights: { tier_wisdom: 2 },
      includeZeroWeightEntities: true,
    });
  });
});
