import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { OPS_EXTRACT_SYSTEM_PROMPT } from '../src/prompts';
import { changedDefaultWarnings, resolveLibrarianStrategy, resolveMaintenanceMode } from '../src/utils/engineDefaults';
import { openTestDatabase } from './helpers/sqliteAdapter';

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

  describe('changedDefaultWarnings', () => {
    it('is silent for a host that sets nothing or chooses explicitly', () => {
      expect(changedDefaultWarnings(undefined)).toEqual([]);
      expect(changedDefaultWarnings({})).toEqual([]);
      expect(changedDefaultWarnings({ maintenance: 'auto', autoLibrarianThreshold: 5 })).toEqual([]);
      expect(changedDefaultWarnings({ maintenance: 'deferred', autoHealThreshold: 5 })).toEqual([]);
      expect(changedDefaultWarnings({
        librarian: { strategy: 'legacy' },
        prompts: { librarianSystemPrompt: 'x' },
      })).toEqual([]);
    });

    it('warns when auto-run thresholds would silently stop firing', () => {
      for (const config of [{ autoLibrarianThreshold: 5 }, { autoHealThreshold: 5 }, { autoLibrarianTokenThreshold: 5 }]) {
        const [warning, ...rest] = changedDefaultWarnings(config);
        expect(rest).toEqual([]);
        expect(warning).toContain("maintenance: 'auto'");
      }
    });

    it('warns when a custom librarian prompt would silently stop applying', () => {
      const [warning, ...rest] = changedDefaultWarnings({ prompts: { librarianSystemPrompt: 'x' } });
      expect(rest).toEqual([]);
      expect(warning).toContain("strategy: 'legacy'");
    });

    it('WikiMemory logs each warning at construction', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      new WikiMemory(openTestDatabase(), {
        llmProvider: { generateText: async () => '{}' },
        config: { autoLibrarianThreshold: 5, prompts: { librarianSystemPrompt: 'x' } },
      });
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
