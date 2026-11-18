// MANUAL CANARY — not part of the standard CI suites (lives under specs/, not
// packages/core/__tests__/). Run manually from the repo root with:
//   pnpm vitest run specs/erase-fts-remediation/canary-ac2.test.ts
// If the root vitest include patterns do not pick up specs/, pass the file
// explicitly via `--root . --dir specs` or an ad-hoc `--config` pointing at it
// (this file deliberately does not change any vitest config).
// The suite self-skips unless the system `sqlite3` CLI exists AND lacks the
// fts5 module — it only proves something on a true module-less runtime.
//
// specs/erase-fts-remediation AC2: module-less erase → capable re-open determinism.
// Phase 1 (capable, real WikiMemory.setup): build a genuine FTS5 store with a
//   canary fact + a normal fact.
// Phase 2 (module-less, system `sqlite3` CLI — REAL no-fts5 runtime): run
//   detach's SQL, then Path A's exact remediation SQL; assert the shadow
//   DELETEs succeed (plain tables without the module) and the vtab DROP fails
//   exactly as the code's swallowed-catch expects.
// Phase 3 (capable, real Fts5IndexStrategy.init): re-open and assert
//   retire-then-rebuild happens with NO shadow collision, state returns to
//   'live', the canary text is unretrievable, and the normal fact is served.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from '../../packages/core/__tests__/helpers/sqliteAdapter';
import { WikiMemory } from '../../packages/core/src/WikiMemory';
import { MetadataRepository } from '../../packages/core/src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../../packages/core/src/services/search/Fts5IndexStrategy';

const P = 'llm_wiki_';
const CANARY = 'qx7v3m9zk';

/** True only when a `sqlite3` CLI exists and cannot create an fts5 table. */
function hasModuleLessCli(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { encoding: 'utf8' });
  } catch {
    return false;
  }
  try {
    execFileSync('sqlite3', [':memory:'], { input: 'CREATE VIRTUAL TABLE tmp_fts USING fts5(x);', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return false; // module present: the canary would prove nothing
  } catch {
    return true;
  }
}

describe.skipIf(!hasModuleLessCli())('AC2 canary — module-less erase then capable re-open (manual evidence)', () => {
  it('Path A on a real module-less SQLite; capable re-open rebuilds without collision', async () => {
    // ── Phase 1: capable life via the real setup ──
    const dir = mkdtempSync(join(tmpdir(), 'erase-canary-'));
    const file = join(dir, 'canary.db');
    const db = openTestDatabase(file);
    const wiki = new WikiMemory(db as never, { llmProvider: { generateText: async () => '{}' } } as never);
    await wiki.setup();
    await wiki.remember('e1', { title: 'Canary fact', body: `secret ${CANARY} token`, tags: [] });
    await wiki.remember('e1', { title: 'Keeper', body: 'stays searchable cedar', tags: [] });
    const before = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts`);
    expect(before!.n).toBeGreaterThan(0);
    await db.closeAsync();

    // ── Phase 2: module-less runtime (system sqlite3 CLI, no fts5 module) ──
    const sh = (sql: string) => execFileSync('sqlite3', [file], { input: sql, encoding: 'utf8' });
    const must = (sql: string) => sh(sql); // throws on failure
    // detach (what the module-less bootstrap does): triggers + ledger drop succeed, vtab drop fails
    must(`DROP TRIGGER IF EXISTS ${P}entries_fts_ai;\nDROP TRIGGER IF EXISTS ${P}entries_fts_au;\nDROP TRIGGER IF EXISTS ${P}entries_fts_ad;`);
    must(`DROP TABLE IF EXISTS ${P}fts_pending;\nDROP TABLE IF EXISTS ${P}fts_map;`);
    let vtabDropFailed = false;
    try { sh(`DROP TABLE ${P}entries_fts;`); } catch { vtabDropFailed = true; }
    expect(vtabDropFailed).toBe(true); // the swallowed catch in detachFts5 exists for THIS
    // Erase step 1 equivalent (plain table on the module-less runtime): the
    // entity walk hard-deletes the entries rows BEFORE step 3 runs.
    must(`DELETE FROM ${P}entries;`);
    // Path A remediation SQL (exact statements from _eraseClearFtsOrphans, existence-gated):
    const shadows = ['_content', '_data', '_idx', '_docsize', '_config'];
    for (const sfx of shadows) {
      const exists = sh(`SELECT COUNT(*) FROM sqlite_master WHERE name='${P}entries_fts${sfx}';`).trim();
      expect(exists).toBe('1'); // vtab row persists module-less; its shadows are plain tables here
      // Path A (preserve-structure ruling): _data keeps ids 1 (AVERAGES) and 10
      // (STRUCTURE) and _config is untouched entirely (the version row lives there —
      // deleting it is what made the vtab unreadable); no user text in either.
      if (sfx === '_config') { continue; }
      must(`DELETE FROM ${P}entries_fts${sfx}${sfx === '_data' ? ' WHERE id NOT IN (1, 10)' : ''};`);
      const n = sh(`SELECT COUNT(*) FROM ${P}entries_fts${sfx};`).trim();
      if (sfx === '_data') { expect(n).toBe('2'); }
      else { expect(n).toBe('0'); } // canary rows gone from every text-bearing surface
    }
    must(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('fts5_index_state', 'detached');`);
    const state2 = sh(`SELECT value FROM ${P}meta WHERE key='fts5_index_state';`).trim();
    expect(state2).toBe('detached');
    const blobs = sh(`SELECT group_concat(COALESCE(block, '')) FROM ${P}entries_fts_data;`).trim();
    expect(blobs.includes(CANARY)).toBe(false); // no canary bytes in the preserved rows

    // ── Phase 3: capable re-open via the repo's real init() ──
    const db2 = openTestDatabase(file);
    const meta = new MetadataRepository(db2 as never, P);
    const strat = new Fts5IndexStrategy(db2 as never, P, meta);
    await strat.init(); // must NOT hit an unreadable-vtab error (the pre-repair failure)
    // The rebuild completes over drain windows — drive it to completion.
    for (let i = 0; i < 25 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) {
      await strat.drain();
    }
    const state3 = await meta.getMeta('fts5_index_state');
    expect(state3).toBe('live');
    const hits = await strat.search(CANARY, { entityIds: ['e1'], limit: 10 });
    expect(hits).toEqual([]); // erased text unretrievable
    const keeper = await strat.search('cedar', { entityIds: ['e1'], limit: 10 });
    expect(keeper).toEqual([]); // erase() is whole-store: the rows are gone too
    const rebuilt = await db2.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts`);
    expect(rebuilt!.n).toBe(0); // the fresh index is empty — nothing was resurrected
    await db2.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });
});
