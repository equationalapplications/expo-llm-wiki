import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLiteAdapter } from '../src/types';
import { upcomingDefaultsWarning } from '../src/utils/upgradeNotice';

const llmProvider = { generateText: async () => '{}' };
const fakeDb = {} as SQLiteAdapter;

describe('upcomingDefaultsWarning', () => {
  it('names both options and their 8.0.0 defaults when nothing is set', () => {
    for (const config of [undefined, {}]) {
      const message = upcomingDefaultsWarning(config);
      expect(message).toContain('8.0.0');
      expect(message).toContain("`librarian.strategy` (default becomes 'ops')");
      expect(message).toContain("`maintenance` (default becomes 'deferred')");
      expect(message).toContain('auto-run thresholds');
      expect(message).toContain('runPendingMaintenance()');
      expect(message).toContain("librarian: { strategy: 'legacy' }");
      expect(message).toContain("maintenance: 'auto'");
    }
  });

  it('names only maintenance when the strategy is set', () => {
    const message = upcomingDefaultsWarning({ librarian: { strategy: 'legacy' } });
    expect(message).toContain('`maintenance`');
    expect(message).toContain('auto-run thresholds');
    expect(message).toContain("maintenance: 'auto'");
    expect(message).not.toContain('`librarian.strategy`');
    expect(message).not.toContain('librarian: {');
  });

  it('names only the strategy when maintenance is set, without the deferred note', () => {
    const message = upcomingDefaultsWarning({ maintenance: 'auto' });
    expect(message).toContain('`librarian.strategy`');
    expect(message).toContain("librarian: { strategy: 'legacy' }");
    expect(message).not.toContain('auto-run thresholds');
    expect(message).not.toContain('`maintenance`');
  });

  it('treats a librarian object without a strategy as unset', () => {
    expect(upcomingDefaultsWarning({ librarian: { gate: { k: 3 } }, maintenance: 'auto' }))
      .toContain('`librarian.strategy`');
  });

  it('is silent when both are set, whichever values they hold', () => {
    expect(upcomingDefaultsWarning({ librarian: { strategy: 'legacy' }, maintenance: 'auto' })).toBeNull();
    expect(upcomingDefaultsWarning({ librarian: { strategy: 'ops' }, maintenance: 'deferred' })).toBeNull();
  });
});

describe('WikiMemory construction', () => {
  // Fresh module registry per test: the once-per-process guard is module state.
  async function freshWikiMemory() {
    vi.resetModules();
    return (await import('../src/WikiMemory')).WikiMemory;
  }

  let warn: ReturnType<typeof vi.spyOn>;
  const upgradeWarnings = () =>
    warn.mock.calls.filter(([message]: unknown[]) => String(message).includes('8.0.0'));

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once across repeated constructions', async () => {
    const WikiMemory = await freshWikiMemory();
    new WikiMemory(fakeDb, { llmProvider });
    new WikiMemory(fakeDb, { llmProvider, config: {} });
    expect(upgradeWarnings()).toHaveLength(1);
  });

  it('still warns for a different unset combination in the same process', async () => {
    const WikiMemory = await freshWikiMemory();
    new WikiMemory(fakeDb, { llmProvider });
    new WikiMemory(fakeDb, { llmProvider, config: { maintenance: 'auto' } });
    expect(upgradeWarnings()).toHaveLength(2);
  });

  it('does not warn a host that sets both options', async () => {
    const WikiMemory = await freshWikiMemory();
    new WikiMemory(fakeDb, { llmProvider, config: { librarian: { strategy: 'legacy' }, maintenance: 'auto' } });
    expect(upgradeWarnings()).toHaveLength(0);
  });

  it('does not warn when construction is rejected for a bad tablePrefix', async () => {
    const WikiMemory = await freshWikiMemory();
    expect(() => new WikiMemory(fakeDb, { llmProvider, config: { tablePrefix: 'bad prefix' } })).toThrow();
    expect(upgradeWarnings()).toHaveLength(0);
  });
});
