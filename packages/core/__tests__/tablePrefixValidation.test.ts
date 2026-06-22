import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import type { WikiOptions } from '../src/types';

const stubOptions = (tablePrefix?: string): WikiOptions => ({
  llmProvider: { generateText: async () => '{}' },
  ...(tablePrefix !== undefined ? { config: { tablePrefix } } : {}),
});

describe('WikiMemory tablePrefix validation', () => {
  it('accepts the default prefix when none is configured', () => {
    expect(() => new WikiMemory({} as any, stubOptions())).not.toThrow();
  });

  it.each([
    'llm_wiki_',
    'a_',
    'Tenant1_Data_',
    'A' + 'b'.repeat(30) + '_',
  ])('accepts valid prefix %s', (prefix) => {
    expect(() => new WikiMemory({} as any, stubOptions(prefix))).not.toThrow();
  });

  it.each([
    'x; DROP TABLE users;-- ',
    '123_',
    'no_trailing_underscore',
    "' OR 1=1 --",
    'A' + 'b'.repeat(31) + '_', // 33 chars, exceeds the 31-char cap
    '',
  ])('rejects invalid prefix %j', (prefix) => {
    expect(() => new WikiMemory({} as any, stubOptions(prefix))).toThrow(/Invalid tablePrefix/);
  });
});
