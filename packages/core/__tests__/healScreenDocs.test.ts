import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const doc = readFileSync(
  new URL('../../../apps/docs/src/content/docs/reference/configuration.md', import.meta.url), 'utf8');

describe('heal screen docs (spec §7, item 11)', () => {
  it.each([
    'orphanAfterDays', 'staleInferredAfterDays', 'pruneEventsAfter', 'pruneRetainSoftDeletedFor', 'pruneSupersededAfter',
  ])('documents the %s clock knob', (knob) => {
    expect(doc).toContain(`\`${knob}\``);
  });

  it.each(['systemOne.healScreen', 'systemOne.minConfidence.healScreen'])('documents %s', (key) => {
    expect(doc).toContain(`\`${key}\``);
  });

  it('carries the heal-may-forget ruling line', () => {
    expect(doc).toContain('Heal may forget when the host runs it');
    expect(doc).toContain('not written to the event table');
    expect(doc).toContain("keeps the events heal reviewed (not heal's moves or receipts)");
    expect(doc).toContain('receipts survive only as long as your `onDiagnostic` sink stores them');
  });
});
