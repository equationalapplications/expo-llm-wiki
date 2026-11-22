import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { OPS_EXTRACT_SYSTEM_PROMPT } from '../src/prompts';
import { changedDefaultWarnings, resolveLibrarianStrategy, resolveMaintenanceMode, resolveShortlistK, resolveSystemOneTyping } from '../src/utils/engineDefaults';
import type { WikiConfig } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

describe('resolveShortlistK', () => {
  it('returns 10 for an undefined config and for an ontology section without shortlistK', () => {
    expect(resolveShortlistK(undefined)).toBe(10);
    expect(resolveShortlistK({ ontology: {} } as WikiConfig)).toBe(10);
  });

  it('returns the given finite integer >= 1', () => {
    expect(resolveShortlistK({ ontology: { shortlistK: 1 } } as WikiConfig)).toBe(1);
    expect(resolveShortlistK({ ontology: { shortlistK: 25 } } as WikiConfig)).toBe(25);
  });

  it.each([0, -1, 1.5, NaN, Infinity, '10'])('throws for %j', (bad) => {
    expect(() => resolveShortlistK({ ontology: { shortlistK: bad as never } } as WikiConfig))
      .toThrow(/^\[core-llm-wiki\]/);
  });
});

describe('unserializable invalid config values (PR #442 review)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A raw JSON.stringify throws on bigint and on circular references; config
  // arriving from an unvalidated host store can hold either, and a warning
  // must never become an exception.
  it('bigint and circular invalid values warn once without throwing and are treated as unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSystemOneTyping({ systemOne: { typing: 1n as never } })).toBe('llm');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(resolveSystemOneTyping({ systemOne: { typing: circular as never } })).toBe('llm');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[unserializable: bigint]'))).toBe(true);
  });
});

describe('8.0.0 engine defaults', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolve to ops + deferred when the host sets nothing', () => {
    expect(resolveLibrarianStrategy(undefined)).toBe('ops');
    expect(resolveLibrarianStrategy({})).toBe('ops');
    expect(resolveMaintenanceMode(undefined)).toBe('deferred');
    expect(resolveMaintenanceMode({})).toBe('deferred');
  });

  it('keep an explicit 7.x choice', () => {
    expect(resolveLibrarianStrategy({ librarian: { strategy: 'legacy' } })).toBe('legacy');
    expect(resolveMaintenanceMode({ maintenance: 'auto' })).toBe('auto');
  });

  it('write() past every default threshold makes no LLM call until the host runs maintenance', async () => {
    const generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }));
    const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText } });
    await wiki.setup();
    for (let i = 0; i < 120; i++) await wiki.write('e1', { event_type: 'observation', summary: `event ${i}` });
    await new Promise<void>((r) => setImmediate(r));
    expect(generateText).not.toHaveBeenCalled();

    const pending = await wiki.getPendingMaintenance(['e1']);
    expect(pending[0]).toMatchObject({ entityId: 'e1', pendingEvents: 120 });

    await wiki.runPendingMaintenance();
    expect(generateText).toHaveBeenCalled();
  });

  it('runLibrarian() uses the ops extract prompt by default', async () => {
    const generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }));
    const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText } });
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 'Ada wrote programs' });
    await wiki.runLibrarian('e1');
    expect(generateText.mock.calls[0][0].systemPrompt).toContain(OPS_EXTRACT_SYSTEM_PROMPT);
  });

  it('getInstructions() reports the librarian prompt the default strategy actually sends', async () => {
    const generateText = vi.fn(async () => JSON.stringify({ facts: [], tasks: [] }));
    const wiki = new WikiMemory(openTestDatabase(), { llmProvider: { generateText } });
    await wiki.setup();
    await wiki.write('e1', { event_type: 'observation', summary: 'Ada wrote programs' });
    await wiki.runLibrarian('e1');
    const instructions = await wiki.getInstructions('e1');
    expect(instructions.librarian).toBe(generateText.mock.calls[0][0].systemPrompt);
  });

  const REMOVED = { librarianSystemPrompt: 'x' } as Record<string, unknown>;
  const REMOVAL_NOTICE =
    '[core-llm-wiki] `prompts.librarianSystemPrompt` was removed in 9.0.0 and its value is ignored. '
    + 'Move the domain part of it to `prompts.guidance`, which works under both librarian strategies.';

  describe('changedDefaultWarnings', () => {
    it('is silent for a host that sets nothing or chooses explicitly', () => {
      expect(changedDefaultWarnings(undefined)).toEqual([]);
      expect(changedDefaultWarnings({})).toEqual([]);
      expect(changedDefaultWarnings({ maintenance: 'auto', autoLibrarianThreshold: 5 })).toEqual([]);
      expect(changedDefaultWarnings({ maintenance: 'deferred', autoHealThreshold: 5 })).toEqual([]);
      expect(changedDefaultWarnings({
        librarian: { strategy: 'legacy' },
        maintenance: 'auto',
      })).toEqual([]);
    });

    it('warns when auto-run thresholds would silently stop firing', () => {
      for (const config of [{ autoLibrarianThreshold: 5 }, { autoHealThreshold: 5 }, { autoLibrarianTokenThreshold: 5 }]) {
        const [warning, ...rest] = changedDefaultWarnings(config);
        expect(rest).toEqual([]);
        expect(warning).toContain("maintenance: 'auto'");
      }
    });

    it('emits one removal notice when the removed librarianSystemPrompt key is present', () => {
      for (const config of [
        { prompts: REMOVED },
        { prompts: REMOVED, librarian: { strategy: 'ops' as const } },
        { prompts: REMOVED, librarian: { strategy: 'legacy' as const }, maintenance: 'auto' as const },
      ]) {
        const [warning, ...rest] = changedDefaultWarnings(config as WikiConfig);
        expect(rest).toEqual([]);
        expect(warning).toBe(REMOVAL_NOTICE);
      }
    });

    it('warns when a legacy pin keeps only half of the 7.x behavior', () => {
      const [warning, ...rest] = changedDefaultWarnings({ librarian: { strategy: 'legacy' } });
      expect(rest).toEqual([]);
      expect(warning).toContain("'deferred'");
      expect(warning).toContain("maintenance: 'auto'");
      // With thresholds present, the thresholds warning already covers maintenance; no double warn.
      expect(changedDefaultWarnings({
        librarian: { strategy: 'legacy' },
        autoLibrarianThreshold: 5,
      })).toHaveLength(1);
    });

    it('WikiMemory logs each distinct warning once per process', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const make = (config: WikiConfig) => new WikiMemory(openTestDatabase(), {
        llmProvider: { generateText: async () => '{}' },
        config,
      });
      make({ autoLibrarianThreshold: 5 });
      expect(warn).toHaveBeenCalledTimes(1);
      make({ autoLibrarianThreshold: 5 });
      expect(warn).toHaveBeenCalledTimes(1);
      make({ prompts: REMOVED } as WikiConfig);
      expect(warn).toHaveBeenCalledTimes(2);
      make({ autoLibrarianThreshold: 5, prompts: REMOVED } as WikiConfig);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
