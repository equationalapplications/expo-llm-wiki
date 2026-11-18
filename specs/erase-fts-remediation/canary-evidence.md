# AC2 manual canary — 2026-11-18 (controller-run)

Runtime found: system `sqlite3` CLI has NO fts5 module (`no such module: fts5`) — a true
module-less runtime. node:sqlite also lacks fts5. better-sqlite3 (capable) for phases 1/3.

Sequence: real WikiMemory.setup store (canary fact `qx7v3m9zk` + keeper) → detach SQL +
Path A remediation SQL via the module-less CLI (shadow DELETEs SUCCEED — plain tables there;
vtab DROP fails as the code's swallow expects; state key = detached) → capable re-open via
real `Fts5IndexStrategy.init()`.

RESULT: **init FAILS.** resetAndRearm → retireFtsTable: RENAME throws
`SqliteError: invalid fts5 file format (found 0, expected 4 or 5) - run 'rebuild'`
(Path A's row-DELETE removed fts5's internal format/structure rows — corrupt-by-design);
`isTransientOrTxFatal` false → DROP fallback ALSO throws the same error (DROP must read the
corrupt vtab). resetAndRearm fails; createIndexStrategy retries then falls back to
UnavailableIndexStrategy → store usable but keyword search PERMANENTLY dead (every open
retries the same corrupt vtab).

Spec D5 promise ("predictably hit the resetAndRearm corruption recovery path") is violated
on the true module-less→capable path. Proposed repair (controller draft): in
retireFtsTable's corruption branch, when RENAME and DROP both fail with fts5 corruption,
unregister the vtab via the documented writable_schema emergency procedure
(`PRAGMA writable_schema=ON; DELETE FROM sqlite_schema WHERE name=...; OFF`) and drop the
now-plain shadow tables by name, so the rearm's CREATE builds fresh. Same corrupt-DROP
likely bites _eraseReclaimRetired's retired-table DROP on a capable open (needs review).

> Historical (pre-repair) finding. The shipped repair differs: writable_schema surgery was
> impossible (better-sqlite3 and the SQLite 3.53 CLI refuse sqlite_schema DML), so Path A now
> preserves `%_data` ids 1 (AVERAGES) and 10 (STRUCTURE) and the `%_config` table; the canary
> (`canary-ac2.test.ts`, this dir) asserts the repaired behavior.
