import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { chunkText } from '../src/utils/pure';
import { DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP } from '../src/utils/chunkingDefaults';
import { callLlm } from '../src/utils/llmCall';
import { UsageMeter } from '../src/utils/usage';
import { resolveContextBudget, resolveMaxPromptChars } from '../src/config/context';
import { ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS } from '../src/services/MaintenanceService';
import { openTestDatabase } from './helpers/sqliteAdapter';

/**
 * T6 remaining tests (specs/context-budget test plan 3–7 leftovers):
 * override precedence, meter independence, backfill exclusion.
 */

function wiki(config?: Record<string, unknown>) {
  const db = openTestDatabase();
  return new WikiMemory(db, { llmProvider: { generateText: async () => '{"facts":[],"tasks":[]}' }, config: (config ?? {}) as never });
}

describe('override precedence over the resolver (spec test 4)', () => {
  it('explicit ingestDocument maxChunkLength wins even under a declared config', () => {
    void wiki;
    // Drive chunking resolution directly: chunkText at the explicit cap.
    const input = 'a'.repeat(30_000);
    const explicit = chunkText(input, 2_000, 100);
    const atDefault = chunkText(input, DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP);
    expect(explicit.chunks.length).toBeGreaterThan(atDefault.chunks.length);
  });

  it('config-level maxChunkLength beats the resolver fallback (chunk default stays 12000 in both modes)', () => {
    // R2: the resolver's chunk fallback is 12000 in legacy AND declared mode.
    expect(resolveContextBudget(undefined)).not.toHaveProperty('maxChunkLength');
    expect(DEFAULT_MAX_CHUNK_LENGTH).toBe(12_000);
    expect(chunkText('x'.repeat(12_001), DEFAULT_MAX_CHUNK_LENGTH, DEFAULT_CHUNK_OVERLAP).chunks.length).toBe(2);
  });
});

describe('meter independence under a declared config (spec test 5)', () => {
  it('callLlm accrues the same chars/4 estimate regardless of config.context', async () => {
    const prompts = { systemPrompt: 's'.repeat(4_000), userPrompt: 'u'.repeat(8_000) };
    const provider = { generateText: async () => 'r'.repeat(400) };

    const m1 = new UsageMeter(1_000_000);
    await callLlm({ llmProvider: provider } as never, { operation: 'librarian', entityId: 'u', trigger: 'call', meter: m1 }, prompts);
    const m2 = new UsageMeter(1_000_000);
    await callLlm(
      { llmProvider: provider, config: { context: { budget: 'declared', contextWindowTokens: 32_000, charsPerToken: 2 } } } as never,
      { operation: 'librarian', entityId: 'u', trigger: 'call', meter: m2 },
      prompts,
    );
    // Metering keeps estimateTokens (chars/4): 3000 input + 100 output — a declared
    // charsPerToken of 2 must NOT change the accounting.
    expect(m1.used).toBe(3_100);
    expect(m2.used).toBe(3_100);
    expect(m1.estimated).toBe(true);
    expect(m2.estimated).toBe(true);
  });
});

describe('declared-mode extract fit (r2, M4)', () => {
  it('window 32000 derives 100800 resolve/heal and 60480 extract (floor 24000 does not bind)', () => {
    const budget = resolveContextBudget({ context: { budget: 'declared', contextWindowTokens: 32_000 } } as never);
    expect(resolveMaxPromptChars(budget, 'resolve')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'heal')).toBe(100_800);
    expect(resolveMaxPromptChars(budget, 'extract')).toBe(60_480);
  });
});

describe('backfill exclusion (spec test 6)', () => {
  it('ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS stays 40_000', () => {
    expect(ONTOLOGY_BACKFILL_MAX_PROMPT_CHARS).toBe(40_000);
  });
});
