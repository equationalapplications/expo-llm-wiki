import { describe, it, expect } from 'vitest';
import { buildOntologyPromptAppendix } from '@equationalapplications/core-llm-wiki';
import { schemaSoftwareOrgManifest } from '../src/index';

describe('ontology prompt plumbing', () => {
  const { ontologyManifest, ontologyModeInstructions } = buildOntologyPromptAppendix(
    'strict',
    JSON.stringify(schemaSoftwareOrgManifest),
  );

  it.each([
    'A situation, and what to do in it.',
    'What was chosen, what was rejected, and why.',
    'What went wrong, and what to do differently.',
    'A likely wrong assumption, and the fact that corrects it.',
  ])('carries kind definition: %s', (text) => {
    expect(ontologyManifest).toContain(text);
    expect(ontologyModeInstructions).toContain(text);
  });

  it('carries the abstract-statement line', () => {
    expect(ontologyManifest).toContain('never as `statement`');
    expect(ontologyModeInstructions).toContain('never as `statement`');
  });

  it('carries the attachment sentence', () => {
    expect(ontologyManifest).toContain('attach with `about`');
    expect(ontologyModeInstructions).toContain('attach with `about`');
  });
});
