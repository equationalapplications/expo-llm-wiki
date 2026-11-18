# erase() FTS orphan remediation — implementation plan (spec r5)

**Spec:** `specs/erase-fts-remediation/spec.md` (r5, `ed8f2751`, ladder converged 2026-11-17).
**Owner approval:** 2026-11-18 (chat evaluation of D1/D2/D3/D5 + explicit-Unavailable + allowlist points, no changes requested).
**Status:** in progress.

## Goal

On a runtime without the FTS5 module — or configured to MiniSearch —
`erase()` currently always stops at `erase_orphaned_fts_content`. This
plan adds the remediation that clears orphaned FTS5 surfaces so erasure
completes verified, with honest failures for the states it does not cover
(INTENT rule 13).

## Architecture

- New private step `MaintenanceService._eraseClearFtsOrphans(report)`,
  called from `_eraseDrainPassages` inside the existing
  `!hasStrictDrain()` branch, BEFORE the pending-ledger throw loop (D4).
  The old probe-and-throw orphan block is deleted (replaced).
- Per surface (`entries_fts`, `source_passages_fts`): existence gate
  (vtab OR any shadow) → strategy check → vtab probe → path body
  (A/B/C) → companions → `FTS5_STATE_KEY = 'detached'` → pending
  re-check (D1, D4).
- `EraseReport` gains `ftsOrphansCleared: string[]`; the `failedStep`
  union gains `'fts_orphan_clear'` (D3). Probe failures keep
  `failedStep 'index_sync'`.
- Diagnostic `erase_fts_orphan_cleared` per cleared table (D3, AC10).

## Interfaces (cross-task contract)

```ts
// MaintenanceService (new step; called only from _eraseDrainPassages)
async _eraseClearFtsOrphans(report: EraseReport): Promise<void>

// EraseReport additions (D3)
ftsOrphansCleared: string[];
failedStep: ... | 'fts_orphan_clear' | null;

// SearchService (new introspection, needed because `indexStrategy` is private)
usesMiniSearchIndex(): boolean   // this.indexStrategy instanceof MiniSearchIndexStrategy
isIndexUnavailable(): boolean    // this.indexStrategy instanceof UnavailableIndexStrategy
```

New error codes: `erase_fts_orphan_probe_failed` (failedStep
`index_sync`), `erase_fts_index_unavailable` (failedStep `index_sync`),
`erase_fts_orphan_clear` (failedStep `fts_orphan_clear`). The existing
`erase_orphaned_fts_content` stays for a probed surface that is missing
but undeletable.

## Global constraints

- Exact-name allowlist only — no pattern SQL (D2). Every name gated on
  `sourceTableExists`.
- No reuse of `FTS5_RETIRED_TABLES_KEY`; no `ALTER TABLE` renames; no
  vtab DROP unless the strategy is positively `MiniSearchIndexStrategy`
  (D1, D2).
- The strict-drain branch and `canReclaimRetired()` machinery are
  untouched byte-for-byte (D4).
- No schema migration, no INTENT change, no wrapper changes (D6).
- MINOR release; no version bump in this PR (release is its own flow).
- Conventional commit titles; commit after every green test run.

## Worktree / commands

- Worktree: `/mnt/kv-work/build/worktrees/expo-llm-wiki/erase-fts-remediation` (branch `specs/erase-fts-remediation`).
- Preflight (once): `pnpm install --frozen-lockfile && pnpm -r --filter './packages/*' build`
- Targeted test (from `packages/core/`): `pnpm vitest run __tests__/eraseFtsSurfaces.test.ts`
- Typecheck (from `packages/core/`): `pnpm typecheck`
- Docs build: `pnpm --filter docs build`
- Package manager: pnpm ONLY. npm/npx/yarn are NOT granted.

---

## E1 — report shape + strategy introspection (AC scaffolding)

**Test:** none of its own (type-level); `pnpm typecheck` is the gate, and
the existing suites must stay green.

**Impl 1** — `packages/core/src/services/MaintenanceService.ts`, extend
`EraseReport` (after `retiredUndroppable`, ~:238):

```ts
  /** FTS5 orphan surfaces cleared by the step-3 remediation (specs/erase-fts-remediation D3). Each name is pushed only after that surface fully clears. */
  ftsOrphansCleared: string[];
```

and the `failedStep` union (~:243) gains `'fts_orphan_clear'`:

```ts
  failedStep: 'secure_delete' | 'vacuum' | 'checkpoint' | 'prune' | 'registry_sweep' | 'passage_drain' | 'retired_reclaim' | 'index_sync' | 'optimize' | 'rebuild' | 'tombstone_gate' | 'fts_orphan_clear' | null;
```

In `erase()`'s report literal (~:571) add `ftsOrphansCleared: [],` after
`retiredUndroppable: [],`.

**Impl 2** — extend the fts5Sql import (~:33):

```ts
import { FTS5_RETIRED_TABLES_KEY, FTS5_STATE_KEY, isRetiredTableName, fts5LedgerDropSql, passageFtsTriggerNames } from './search/fts5Sql';
```

**Impl 2b** — `packages/core/src/types.ts`, `WikiDiagnosticCode` union
(~:890, next to `erase_retired_vtab_undroppable`) — the new diagnostic
code must be a member or `emitDiagnostic` fails to typecheck:

```ts
  | 'erase_fts_orphan_cleared'
```

**Impl 3** — `packages/core/src/services/SearchService.ts`, add two
public introspection methods next to `hasStrictDrain()`:

```ts
  /** True when the active strategy is positively the config-chosen MiniSearch one (erase orphan remediation, specs/erase-fts-remediation D1). */
  usesMiniSearchIndex(): boolean {
    return this.indexStrategy instanceof MiniSearchIndexStrategy;
  }

  /** True when the active strategy is the transient outage placeholder (erase orphan remediation, D1: never drop under it). */
  isIndexUnavailable(): boolean {
    return this.indexStrategy instanceof UnavailableIndexStrategy;
  }
```

(`MiniSearchIndexStrategy` / `UnavailableIndexStrategy` are already
imported there — verify; add the import only if missing.)
**Run:** `pnpm typecheck` green; `pnpm vitest run __tests__/eraseFtsSurfaces.test.ts`
green. **Commit:** `feat(core): EraseReport ftsOrphansCleared + strategy introspection for orphan remediation`.

## E2 — `_eraseClearFtsOrphans` implementation (D1–D4)

Add to `MaintenanceService`, directly above `_eraseDrainPassages`:

```ts
  private static readonly FTS_SHADOW_SUFFIXES = ['_content', '_data', '_idx', '_docsize', '_config'] as const;

  /**
   * Step 3 remediation (specs/erase-fts-remediation): on a runtime without
   * usable strict drains, clear orphaned FTS5 surfaces so erasure can
   * complete verified. Per surface: existence gate (vtab OR any shadow) →
   * strategy check → vtab probe → path body → companions → state write.
   * Dispatch order is D4; exact-name allowlist interpolation is D2.
   */
  async _eraseClearFtsOrphans(report: EraseReport): Promise<void> {
    const surfaces = [`${this.prefix}entries_fts`, `${this.prefix}source_passages_fts`] as const;
    let remediationRequired = false;
    const pathBTargets: string[] = [];
    try {
      for (const surface of surfaces) {
        const vtabExists = await this.sourceTableExists(surface);
        const shadows: string[] = [];
        for (const sfx of MaintenanceService.FTS_SHADOW_SUFFIXES) {
          const name = `${surface}${sfx}`;
          if (await this.sourceTableExists(name)) shadows.push(name);
        }
        if (!vtabExists && shadows.length === 0) continue; // never saw FTS5 or fully detached: no gate, no entry
        remediationRequired = true;
        // Honest failure first (D1): an Unavailable strategy is a transient
        // outage that preserves a healthy index — never drop or clear under it.
        if (this.searchService.isIndexUnavailable()) {
          report.failedStep = 'index_sync';
          throw new EraseStepError('erase_fts_index_unavailable', 'erase stopped at step 3: the index strategy is unavailable and orphaned FTS surfaces remain; erasure is unverified', report);
        }
        let moduleLess = false;
        if (vtabExists) {
          try {
            await this.db.getFirstAsync(`SELECT 1 AS x FROM ${surface} LIMIT 1`);
          } catch (err) {
            if (!/no such module/i.test(err instanceof Error ? err.message : String(err))) {
              report.failedStep = 'index_sync';
              throw new EraseStepError('erase_fts_orphan_probe_failed', `erase stopped at step 3: could not classify orphaned vtab ${surface}`, report, err);
            }
            moduleLess = true; // Path A: the vtab row is inert
          }
        }
        if (vtabExists && !moduleLess) {
          if (!this.searchService.usesMiniSearchIndex()) {
            report.failedStep = 'index_sync';
            throw new EraseStepError('erase_fts_index_unavailable', `erase stopped at step 3: ${surface} is live and queryable but the strategy cannot DROP it; erasure is unverified`, report);
          }
          pathBTargets.push(surface); // Path B: defer DROPs to after the per-surface loop
          continue;
        }
        // Path A / Path C: the shadows are plain tables here — empty them.
        const cleared: string[] = [];
        for (const name of shadows) {
          await this.db.runAsync(`DELETE FROM ${name}`);
          cleared.push(name);
        }
        for (const name of cleared) {
          if (!report.ftsOrphansCleared.includes(name)) report.ftsOrphansCleared.push(name);
          emitDiagnostic(this.options, { code: 'erase_fts_orphan_cleared', operation: 'erase', trigger: 'call', entityId: '' });
        }
      }
      if (!remediationRequired) return;
      // Plain companions that can hold text and have no drain on this runtime (D1, existence-gated).
      for (const companion of [`${this.prefix}fts_pending`, `${this.prefix}fts_map`, `${this.prefix}source_passages_fts_pending`, `${this.prefix}source_passages_fts_map`] as const) {
        if (await this.sourceTableExists(companion)) {
          await this.db.runAsync(`DELETE FROM ${companion}`);
          if (!report.ftsOrphansCleared.includes(companion)) report.ftsOrphansCleared.push(companion);
          emitDiagnostic(this.options, { code: 'erase_fts_orphan_cleared', operation: 'erase', trigger: 'call', entityId: '' });
        }
      }
      // Path B body (after the surface loop, D4): DROP the queryable vtabs and
      // the FTS triggers, mirroring detachFts5's effects.
      for (const surface of pathBTargets) {
        await this.db.execAsync(`DROP TABLE IF EXISTS ${surface}`);
        emitDiagnostic(this.options, { code: 'erase_fts_orphan_cleared', operation: 'erase', trigger: 'call', entityId: '' });
        if (!report.ftsOrphansCleared.includes(surface)) report.ftsOrphansCleared.push(surface);
      }
      if (pathBTargets.length > 0) {
        const [ai, ad] = passageFtsTriggerNames(this.prefix);
        await this.db.execAsync(fts5LedgerDropSql(this.prefix) + `\nDROP TRIGGER IF EXISTS ${ai};\nDROP TRIGGER IF EXISTS ${ad};`);
      }
      // Deterministic state (D1/D5): the next capable open must take resetAndRearm, not a corruption path.
      if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY)) !== 'detached') {
        await this.db.withTransactionAsync(async (tx) => {
          await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'detached', tx);
        });
      }
    } catch (err) {
      if (err instanceof EraseStepError) throw err;
      report.failedStep = 'fts_orphan_clear';
      throw new EraseStepError('erase_fts_orphan_clear', 'erase stopped at step 3: clearing an orphaned FTS surface failed; erasure is unverified', report, err);
    }
  }
```

Then rewire `_eraseDrainPassages` — inside `if (!this.searchService.hasStrictDrain()) {`:

1. FIRST line of the branch becomes:

```ts
      await this._eraseClearFtsOrphans(report);
```

2. Keep the pending-ledger throw loop exactly as-is (it re-checks after
   the remediation — D4: leftovers still throw honestly).
3. DELETE the whole orphan probe-and-throw `for (const suffix of ['entries_fts_content', 'source_passages_fts_content'])` block
   (~:799-811) — replaced by the remediation.

**Run:** existing suites green (`eraseFtsSurfaces.test.ts`,
`eraseVacuumCheckpoint.test.ts` — the F-MAJOR-1 test now FAILS because
erase no longer throws; that flip is E3's first test).
**Typecheck:** green. **Commit:**
`feat(core): erase() clears orphaned FTS5 surfaces on module-less and MiniSearch runtimes (spec D1-D4)`.

## E3 — Path C tests + F-MAJOR-1 flip + never-FTS clean (AC9)

**In `packages/core/__tests__/eraseFtsSurfaces.test.ts`:**

Flip the test `step 3: strategy without strict drain refuses on orphaned
FTS content tables (F-MAJOR-1)` (~:166-179) to:

```ts
  it('step 3: strategy without strict drain CLEARS orphaned FTS content tables (F-MAJOR-1 flipped, Path C)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      await t.raw.execAsync(`CREATE TABLE ${P}entries_fts${sfx} (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts${sfx} VALUES (1, 'CANARY-forgotten-text');`);
    }
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts${sfx}`))!.n, sfx + JSON.stringify(report)).toBe(0);
    }
    expect(report.ftsOrphansCleared).toEqual([
      `${P}entries_fts_content`, `${P}entries_fts_data`, `${P}entries_fts_idx`, `${P}entries_fts_docsize`, `${P}entries_fts_config`,
      `${P}fts_pending`, `${P}fts_map`, `${P}source_passages_fts_pending`, `${P}source_passages_fts_map`,
    ]);
    expect(report.failedStep).toBeNull();
  });
```

NOTE (controller ruling 2026-11-18, E3 resume): D1 clears the plain
companions too and D3 lists every cleared table, so the expectation
INCLUDES the companions that exist in the fixture (`fts_pending`,
`fts_map`, `source_passages_fts_pending`, `source_passages_fts_map`, in
that order, after the five shadows). A companion absent from the fixture
store is absent from the expectation — check `sqlite_master` first.

Add:

```ts
  it('Path C / never-FTS: a module-less DB that never had FTS tables proceeds with no probe and no entry (AC9)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    expect(report.ftsOrphansCleared).toEqual([]);
    expect(report.failedStep).toBeNull();
  });

  it('full erase(): Path C completes verified (AC9 via pipeline)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY-forgotten-text');`);
    const report = await maint(t.wiki).erase();
    expect(report.verified).toBe(true);
    expect(report.ftsOrphansCleared).toContain(`${P}entries_fts_content`);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts_content`))!.n).toBe(0);
  });
```

**Run:** targeted test green. **Commit:**
`test(core): Path C orphan clear — F-MAJOR-1 flip + never-FTS clean (AC9)`.

## E4 — Path A tests + honest failures (AC1, AC4, AC5, AC6)

**Add to `eraseFtsSurfaces.test.ts`** (a real FTS5 store then a
module-less classification via the probe stub; stand-in shadows carry the
canary rows — the stand-in proves the DELETE SQL per spec test 1):

```ts
  it('Path A: module-less probe empties shadows + companions and forces detached state (AC1/AC2 stand-in)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    // Real FTS5 tables + rows (canary), then simulate the module-less vtab probe.
    await t.raw.withTransactionAsync(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'CANARY-secret-' || ?, '[]', 1, 1)`, [`r${i}`, `cedar ${i}`, String(i)]);
      }
    });
    await search(t.wiki).syncEntries('e1', ['r0', 'r1', 'r2']);
    await t.raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'r0')`);
    const probeError = new Error('no such module: fts5');
    const probe = vi.spyOn(t.raw, 'getFirstAsync').mockRejectedValue(probeError);
    // sourceTableExists must still work: it uses its own query path — restore for non-probe calls.
    probe.mockImplementation(async (sql: string) => {
      if (/FROM ${P}entries_fts LIMIT|FROM ${P}source_passages_fts LIMIT/.test(sql)) throw probeError;
      return openTestDatabase().prototype; // never reached; replaced below
    });
    probe.mockRestore();
    const realGet = t.raw.getFirstAsync.bind(t.raw);
    vi.spyOn(t.raw, 'getFirstAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (new RegExp(`FROM ${P}(entries_fts|source_passages_fts) LIMIT`).test(sql)) throw probeError;
      return realGet(sql as never, params as never);
    });
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts${sfx}`))!.n).toBe(0);
    }
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}fts_pending`))!.n).toBe(0);
    const meta = new MetadataRepository(t.raw, P);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('detached');
    expect(report.failedStep).toBeNull();
  });
```

NOTE for the implementer: the exact stubbing shape above may need a small
adjustment to match how `sourceTableExists` queries (read
`MaintenanceService.ts:871` first). The contract to hold: the vtab probe
(`SELECT 1 AS x FROM <vtab> LIMIT 1`) rejects with `no such module`,
while `sourceTableExists`'s own sqlite_master query still works. If the
adapter funnels both through `getFirstAsync`, discriminate on the SQL
text exactly as shown; if not, stub the narrower seam.

```ts
  it('probe failure honesty: a non-module probe error fails as erase_fts_orphan_probe_failed (AC5)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    const realGet = t.raw.getFirstAsync.bind(t.raw);
    vi.spyOn(t.raw, 'getFirstAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (new RegExp(`FROM ${P}(entries_fts|source_passages_fts) LIMIT`).test(sql)) throw new Error('disk I/O error');
      return realGet(sql as never, params as never);
    });
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_orphan_probe_failed' });
    expect(report.failedStep).toBe('index_sync');
    expect(report.verified).toBe(false);
  });

  it('clear failure honesty: a failing DELETE fails as erase_fts_orphan_clear and the surface is not reported cleared (AC6)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    const realRun = t.raw.runAsync.bind(t.raw);
    vi.spyOn(t.raw, 'runAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith(`DELETE FROM ${P}entries_fts_content`)) throw new Error('database is locked');
      return realRun(sql as never, params as never);
    });
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_orphan_clear' });
    expect(report.failedStep).toBe('fts_orphan_clear');
    expect(report.ftsOrphansCleared).not.toContain(`${P}entries_fts_content`);
  });
```

**Manual canary (controller-run, spec test 1's real-module-less slot):**
run `specs/forget-erasure/canary-repro.cjs` against a SQLite build
without FTS5 if one is available locally; record the outcome honestly in
the run record and the PR body. If no module-less build exists in this
environment, state that in the PR body — the stand-in tests prove the
DELETE SQL and the stub proves the classification, and the real
module-less run stays an open verification item.

**Run:** targeted test green. **Commit:**
`test(core): Path A orphan clear + probe/clear/unavailable honesty branches (AC1, AC4-AC6)`.

## E5 — Path B tests (AC3) + N2 variant

**Add to `eraseFtsSurfaces.test.ts`** (F1 pattern: a real config-minisearch
store; its vtabs are present and queryable only if a prior FTS5 life left
them — construct that by creating the vtab with the module, as `forceRetired`
does):

```ts
  it('Path B: minisearch store with queryable orphan vtabs drops them and forces detached (AC3)', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm, config: { indexStrategy: 'minisearch' } } as WikiOptions);
    await wiki.setup();
    vi.spyOn(search(wiki), 'hasStrictDrain').mockReturnValue(false);
    // Orphaned-but-queryable vtabs from an earlier FTS5 life:
    await raw.execAsync(`CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61'); INSERT INTO ${P}entries_fts (id, entity_id, title, body, tags) VALUES ('x', 'e1', 'CANARY', 'CANARY-body', '[]');`);
    await raw.execAsync(`CREATE VIRTUAL TABLE ${P}source_passages_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tokenize = 'porter unicode61');`);
    expect(search(wiki).usesMiniSearchIndex()).toBe(true);
    const report = newReport();
    await maint(wiki)._eraseDrainPassages(report);
    const names = (await raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('${P}entries_fts', '${P}source_passages_fts')`)).map((r) => r.name);
    expect(names).toEqual([]);
    const meta = new MetadataRepository(raw, P);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('detached');
    expect(report.ftsOrphansCleared).toContain(`${P}entries_fts`);
    expect(report.failedStep).toBeNull();
  });

  it('Unavailable honesty: duck-typed unavailable strategy with orphan surfaces refuses to touch tables (AC4)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    vi.spyOn(search(t.wiki), 'isIndexUnavailable').mockReturnValue(true);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    const before = (await t.raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts%'`)).map((r) => r.name);
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_index_unavailable' });
    expect(report.failedStep).toBe('index_sync');
    const after = (await t.raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts%'`)).map((r) => r.name);
    expect(after).toEqual(before);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts_content`))!.n).toBe(1);
  });
```

**`eraseVacuumCheckpoint.test.ts`** — read the N2 fixture (~:115-138,
`{ name: 'unavailable' }` stub) first. If the harness composes with
`config: { indexStrategy: 'minisearch' }` cheaply, add the Path-B variant
(erase on a minisearch store after a vacuum/checkpoint cycle completes
verified); if it does not compose cheaply, note the skip + reason in the
child report. Do NOT force the fixture.

**Run:** targeted tests green. **Commit:**
`test(core): Path B vtab drop on minisearch + Unavailable no-touch (AC3, AC4)`.

## E6 — determinism + pending-ledger cover (AC2, AC8)

**Add to `eraseFtsSurfaces.test.ts`:**

```ts
  it('AC2: after Path A the next capable open rebuilds via resetAndRearm and serves queries', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    // Module-capable builds protect a LIVE vtab's shadow tables, and the probe
    // only throws no-such-module when the module is absent (in which case the
    // shadows are plain tables) — so mirror the other Path A fixtures: drop the
    // vtab, create plain-table stand-ins with canary text, keep the entries row.
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      await t.raw.execAsync(`CREATE TABLE ${P}entries_fts${sfx} (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts${sfx} VALUES (1, 'CANARY-stale');`);
    }
    await t.raw.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES ('r0', 'e1', 'cedar', 'body', '[]', 1, 1)`);
    const meta = new MetadataRepository(t.raw, P);
    const realGet = t.raw.getFirstAsync.bind(t.raw);
    vi.spyOn(t.raw, 'getFirstAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (new RegExp(`FROM ${P}(entries_fts|source_passages_fts) LIMIT`).test(sql)) throw new Error('no such module: fts5');
      return realGet(sql as never, params as never);
    });
    await maint(t.wiki)._eraseClearFtsOrphans(newReport());
    vi.restoreAllMocks();
    // Reopen with the real (capable) strategy: the hollowed vtab renames to retired and rebuilds.
    const { Fts5IndexStrategy } = await import('../src/services/search/Fts5IndexStrategy');
    await new Fts5IndexStrategy(t.raw, P, meta).init();
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('live');
    const hits = await search(t.wiki).search('cedar', { entityIds: ['e1'] } as never);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('AC8: pending rows clear under Path A before the pending throw re-runs; uncovered leftovers still throw', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    await t.raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'r0')`);
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}fts_pending`))!.n).toBe(0);
    expect(report.failedStep).toBeNull();
  });
```

NOTE (controller ruling 2026-11-18, E6 second resume — supersedes the
automated AC2 test): the AC2 automated test is NOT buildable in this
environment. The real erased state on a module-less runtime keeps the
vtab ROW (detach's `DROP TABLE` fails without the module and is
swallowed), with emptied but structurally-intact plain shadows — so a
capable re-open takes `retireFtsTable` (RENAME vtab + shadows, no
collision) and never the create path; the create-path collision the
fixture hit is unreachable in reality. A module-capable build cannot
hold the real state. Therefore: DELETE the AC2 test from the test file —
AC2's determinism promise is verified by the MANUAL canary run against a
real module-less SQLite build before merge and recorded honestly in the
PR body. Buildable automated coverage: AC8 plus E4's Path A pins. Do not
replace AC2 with a weaker pin.

NOTE for the implementer: adapt the AC2 test's search call to the real
`SearchService.search` signature (read it first); the assertion to hold is
"the rebuilt index serves a query for the pre-existing row". If
`Fts5IndexStrategy.init()`'s constructor signature differs, match it.

**Run:** targeted tests green, then the FULL core suite:
`pnpm vitest run` — AC7 (the strict-drain erase suite stays green
untouched) is this run. **Commit:**
`test(core): Path A determinism + pending-ledger cover (AC2, AC7, AC8)`.

## E7 — docs (AC11) + diagnostics check (AC10)

1. `apps/docs/src/content/docs/guides/deleting-data.md` — in the
   module-less paragraph added in #404, add one sentence:
   `On runtimes without FTS5, erase() now clears the orphaned index tables itself and completes verified.`
2. AC10 is already pinned by the `erase_fts_orphan_cleared` diagnostic
   assertions in E4/E5's tests — if any path test lacks the diagnostic
   assertion, add:
   `expect(t.diagnostics.some((d) => d.code === 'erase_fts_orphan_cleared')).toBe(true);`
   (the `make()` helper already collects diagnostics).
3. **Run:** `pnpm --filter docs build` green.
   **Commit:** `docs: erase() completes verified on module-less runtimes (spec r5)`.

## E8 — full gate

From the repo root:

```bash
pnpm --filter @equationalapplications/core-llm-wiki typecheck
pnpm --filter @equationalapplications/core-llm-wiki build
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter docs build
```

All green, worktree clean, branch pushed. Then: implementation review
loop (Step 7), the Step 8 flip (`**Status:**` → Implemented, delete
`plan.md` + `LEDGER.md` in the same cleanup commit, BEFORE merge), and
the PR body update ("Fixes #407"; links spec + plan; notes the
manual canary outcome from E4 honestly).


## Review notes — pre-adjudicated dispositions (Tier-1.5 implementation ladder, 2026-11-18)

Reviewer instruction: weigh each disposition below and flag ONLY if you
DISAGREE (with file:line + suggested fix). Do not re-litigate what you
agree with.

1. The automated AC2 test was removed (E6): the module-less erased state
   keeps the vtab ROW with emptied plain shadows — a state a
   module-capable build cannot hold — so AC2 is verified by the manual
   canary against the real module-less `sqlite3` CLI. N2 variant (E5)
   skipped per the plan's explicit conditional.
2. The F-MAJOR-1 flip (E3) is sanctioned by this spec — the old
   probe-and-throw block it replaced is gone by design.
3. Diagnostic-table entries for `erase_fts_orphan_cleared` were added in
   `src/utils/diagnostics.ts` (severity + message records) — part of E2's
   union work, not scope creep.
4. Companion tables are cleared AND listed in `ftsOrphansCleared` (E3
   ruling): D1 clears them, D3 lists every cleared table.
5. The step-3 remediation runs BEFORE the pending-ledger throw loop (D4
   order), so leftovers still throw honestly — the loop is retained
   unchanged.
