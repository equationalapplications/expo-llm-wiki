// MANUAL CANARY — not part of the standard CI suites (lives under specs/, not
// packages/core/__tests__/), and the root vitest include does not collect it.
// Running it in place does NOT work: packages/core/vitest.config.ts only
// includes `__tests__/**/*.test.ts`, so `--root ../..` reports "No test files
// found". Verified procedure (2026-11-18): a one-line temp wrapper whose
// import resolves this file's own relative imports, run from the repo root:
//   echo "import '../../../specs/erase-fts-remediation/canary-ac2.test';" > packages/core/__tests__/zzcanary.test.ts
//   pnpm vitest run __tests__/zzcanary.test.ts      (from packages/core)
//   rm packages/core/__tests__/zzcanary.test.ts     (never commit the wrapper)
// The suite self-skips unless the system `sqlite3` CLI exists AND lacks the
// fts5 module — it only proves something on a true module-less runtime.
//
// specs/erase-fts-remediation AC2: module-less erase → capable re-open determinism,
// for BOTH FTS surfaces (entries + source passages).
// Phase 1 (capable, real WikiMemory.setup): build a genuine FTS5 store with a
//   canary fact, a normal fact, and a canary passage.
// Phase 2 (module-less, system `sqlite3` CLI — REAL no-fts5 runtime): run
//   detach's SQL, then Path A's exact remediation SQL per surface; assert the
//   shadow DELETEs succeed (plain tables without the module) and the vtab DROP
//   fails with `no such module`, exactly as the code's swallowed-catch expects.
// Phase 3 (capable, real Fts5IndexStrategy.init): re-open and assert
//   retire-then-rebuild happens with NO shadow collision, state returns to
//   'live', canary text is unretrievable on both surfaces, and a NEW fact
//   written after the rebuild IS searchable (positive proof the index serves).
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

const NO_MODULE = /no such module/i;

/** Message plus any captured stderr of an execFileSync failure. */
function failureText(err: unknown): string {
  const e = err as { message?: string; stderr?: unknown };
  return `${e?.message ?? ''}\n${String(e?.stderr ?? '')}`;
}

/** True only when a `sqlite3` CLI exists and fails to create an fts5 table with `no such module`. */
function hasModuleLessCli(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { encoding: 'utf8' });
  } catch {
    return false; // missing binary / I/O error: SKIP
  }
  try {
    execFileSync('sqlite3', [':memory:'], { input: 'CREATE VIRTUAL TABLE tmp_fts USING fts5(x);', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return false; // module present: the canary would prove nothing
  } catch (err) {
    return NO_MODULE.test(failureText(err)); // any other failure: SKIP, not pass
  }
}

describe.skipIf(!hasModuleLessCli())('AC2 canary — module-less erase then capable re-open (manual evidence)', () => {
  it('Path A on a real module-less SQLite; capable re-open rebuilds without collision (entries + passages)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erase-canary-'));
    const file = join(dir, 'canary.db');
    const opened: Array<{ closeAsync: () => Promise<void> }> = [];
    try {
      // ── Phase 1: capable life via the real setup ──
      const db = openTestDatabase(file);
      opened.push(db);
      const wiki = new WikiMemory(db as never, { llmProvider: { generateText: async () => '{}' } } as never);
      await wiki.setup();
      await wiki.remember('e1', { title: 'Canary fact', body: `secret ${CANARY} token`, tags: [] });
      await wiki.remember('e1', { title: 'Keeper', body: 'stays searchable cedar', tags: [] });
      await wiki.storeSource('e1', { sourceRef: 's1', sourceHash: 'b5c1f2d3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d', text: `${CANARY} passage text` } as never);
      const before = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts`);
      expect(before!.n).toBeGreaterThan(0);
      await db.closeAsync();
      opened.length = 0;

      // ── Phase 2: module-less runtime (system sqlite3 CLI, no fts5 module) ──
      const sh = (sql: string) => execFileSync('sqlite3', [file], { input: sql, encoding: 'utf8' });
      const must = (sql: string) => sh(sql); // throws on failure
      must(`DROP TRIGGER IF EXISTS ${P}entries_fts_ai;\nDROP TRIGGER IF EXISTS ${P}entries_fts_au;\nDROP TRIGGER IF EXISTS ${P}entries_fts_ad;`);
      must(`DROP TABLE IF EXISTS ${P}fts_pending;\nDROP TABLE IF EXISTS ${P}fts_map;`);
      // detachFts5 also drops the passage triggers and ledgers (createIndexStrategy.ts:66-72)
      must(`DROP TRIGGER IF EXISTS ${P}source_passages_fts_ai;\nDROP TRIGGER IF EXISTS ${P}source_passages_fts_ad;`);
      must(`DROP TABLE IF EXISTS ${P}source_passages_fts_map;\nDROP TABLE IF EXISTS ${P}source_passages_fts_pending;`);
      for (const surface of ['entries_fts', 'source_passages_fts']) {
        let vtabDropFailedNoModule = false;
        try { sh(`DROP TABLE ${P}${surface};`); } catch (err) { vtabDropFailedNoModule = NO_MODULE.test(failureText(err)); }
        expect(vtabDropFailedNoModule, surface).toBe(true); // the swallowed catch in detachFts5 exists for THIS
      }
      must(`DELETE FROM ${P}entries;`);
      // erase also hard-deletes the source store before the FTS step
      must(`DELETE FROM ${P}source_passages;\nDELETE FROM ${P}source_documents;`);
      // Path A remediation SQL (exact statements from _eraseClearFtsOrphans, existence-gated), both surfaces.
      const shadows = ['_content', '_data', '_idx', '_docsize', '_config'];
      for (const surface of ['entries_fts', 'source_passages_fts']) {
        for (const sfx of shadows) {
          const name = `${P}${surface}${sfx}`;
          expect(sh(`SELECT COUNT(*) FROM sqlite_master WHERE name='${name}';`).trim(), name).toBe('1');
          // Preserve rule: _data keeps ids 1 and 10; _config untouched.
          if (sfx === '_config') continue;
          must(`DELETE FROM ${name}${sfx === '_data' ? ' WHERE id NOT IN (1, 10)' : ''};`);
          const n = sh(`SELECT COUNT(*) FROM ${name};`).trim();
          if (sfx === '_data') expect(n, name).toBe('2');
          else expect(n, name).toBe('0');
        }
      }
      must(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES ('fts5_index_state', 'detached');`);
      expect(sh(`SELECT value FROM ${P}meta WHERE key='fts5_index_state';`).trim()).toBe('detached');
      for (const surface of ['entries_fts', 'source_passages_fts']) {
        const blobs = sh(`SELECT group_concat(COALESCE(block, '')) FROM ${P}${surface}_data;`).trim();
        expect(blobs.includes(CANARY), surface).toBe(false);
      }

      // ── Phase 3: capable re-open via the repo's real init() ──
      const db2 = openTestDatabase(file);
      opened.push(db2);
      const meta = new MetadataRepository(db2 as never, P);
      const strat = new Fts5IndexStrategy(db2 as never, P, meta);
      await strat.init(); // must NOT hit an unreadable-vtab error (the pre-repair failure)
      for (let i = 0; i < 25 && (await meta.getMeta('fts5_index_state')) !== 'live'; i++) {
        await strat.drain();
      }
      expect(await meta.getMeta('fts5_index_state')).toBe('live');
      expect(await strat.search(CANARY, { entityIds: ['e1'], limit: 10 })).toEqual([]);
      expect(await strat.search('cedar', { entityIds: ['e1'], limit: 10 })).toEqual([]);
      const rebuilt = await db2.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts`);
      expect(rebuilt!.n).toBe(0);
      // Passage surface after re-open: readable (no corruption), and the canary is gone.
      await strat.drainPassages();
      const passageHits = await strat.searchPassages(CANARY, { entityIds: ['e1'], limit: 10 });
      expect(passageHits).toEqual([]);
      const passageRows = await db2.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_passages_fts`);
      expect(passageRows!.n).toBe(0);
      // Positive proof the rebuilt index serves: a NEW fact is searchable.
      const wiki2 = new WikiMemory(db2 as never, { llmProvider: { generateText: async () => '{}' } } as never);
      await wiki2.setup();
      await wiki2.remember('e1', { title: 'Fresh', body: 'zebrafish after rebuild', tags: [] });
      await strat.drain();
      const fresh = await strat.search('zebrafish', { entityIds: ['e1'], limit: 10 });
      expect(fresh.length).toBeGreaterThan(0);
      // A freshly stored source is retrievable via the rebuilt passage index.
      await wiki2.storeSource('e1', { sourceRef: 's2', sourceHash: 'b'.repeat(64), text: 'quokka freshly stored passage' } as never);
      await strat.drainPassages();
      const freshPassages = await strat.searchPassages('quokka', { entityIds: ['e1'], limit: 10 });
      expect(freshPassages.length).toBeGreaterThan(0);
    } finally {
      for (const d of opened) await d.closeAsync().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
