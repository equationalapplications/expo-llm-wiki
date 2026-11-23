import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// specs/type-on-write Test plan 16: the disclosure ships with the code.
const guide = readFileSync(join(__dirname, '../../../apps/docs/src/content/docs/guides/ontologies.md'), 'utf8');

describe('ontologies guide: Type on write disclosures', () => {
  it('names the opt-in key and the three §10 disclosures', () => {
    expect(guide).toContain('### Type on write');
    expect(guide).toContain('systemOne.typeOnWrite');
    expect(guide).toContain('No manifest-drawn edges.');
    expect(guide).toContain('Extraction quality is unmeasured.');
    expect(guide).toContain('Cost is unmeasured.');
  });
});
