import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
describe('benchmarks scaffold', () => {
  it('imports core from source', () => { expect(typeof WikiMemory).toBe('function'); });
});
