import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiOptions } from '../src/types';

const PREFIX = 'llm_wiki_';

function makeWiki(autoLibrarianThreshold?: number) {
  const db = openTestDatabase();
  const options: WikiOptions = {
    llmProvider: { generateText: async () => '{}' },
    ...(autoLibrarianThreshold !== undefined
      ? { config: { autoLibrarianThreshold } }
      : {}),
  };
  return { wiki: new WikiMemory(db, options), db };
}

describe('write() — atomic event+checkpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back event insert when updateCheckpoint throws inside transaction', async () => {
    const { wiki } = makeWiki(1);
    await wiki.setup();

    vi.spyOn((wiki as any).metadataRepo, 'updateCheckpoint').mockRejectedValueOnce(
      new Error('db fail'),
    );

    await expect(
      wiki.write('user-1', { event_type: 'observation', summary: 'rollback test' }),
    ).rejects.toThrow('db fail');

    const count = await (wiki as any).eventRepo.count('user-1');
    expect(count).toBe(0);
  });
});

describe('write() — librarian trigger suppression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes event but skips librarian when forget is active for entity', async () => {
    const { wiki } = makeWiki(1);
    await wiki.setup();

    (wiki as any).jobManager.activeMaintenanceJobs.add(`${PREFIX}:user-1:forget`);
    const librarianSpy = vi.spyOn(wiki.__testAccess.maintenanceService, 'doRunLibrarian');

    await wiki.write('user-1', { event_type: 'observation', summary: 'no librarian' });

    const count = await (wiki as any).eventRepo.count('user-1');
    expect(count).toBe(1);

    await new Promise(r => setTimeout(r, 0));
    expect(librarianSpy).not.toHaveBeenCalled();
  });

  it('writes event but skips librarian when prune is active for entity', async () => {
    const { wiki } = makeWiki(1);
    await wiki.setup();

    (wiki as any).jobManager.activeMaintenanceJobs.add(`${PREFIX}:user-1:prune`);
    const librarianSpy = vi.spyOn(wiki.__testAccess.maintenanceService, 'doRunLibrarian');

    await wiki.write('user-1', { event_type: 'observation', summary: 'no librarian prune' });

    const count = await (wiki as any).eventRepo.count('user-1');
    expect(count).toBe(1);

    await new Promise(r => setTimeout(r, 0));
    expect(librarianSpy).not.toHaveBeenCalled();
  });
});
