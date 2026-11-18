# expire() implementation plan (spec r5)

**Spec:** `specs/expire/spec.md` (r5, `a60146c5`, ladder converged 2026-11-17).
**Owner approval:** 2026-11-18 (chat evaluation of D1–D5 + rejected alternatives, no changes requested).
**Status:** in progress.

## Goal

Add `WikiMemory.expire(entityId, factId, options?): Promise<void>` — end a
fact's validity without a replacement. An archive, not a deletion (INTENT
rule 12). Reuses the supersede guard family and `WikiSupersedeError`.

## Architecture

- `TemporalService.expire()` opens one transaction, runs the
  `supersedeInTx` guard set in that order, then its own checks, then a
  single `setTemporal(id, entityId, { valid_to: t }, tx)`.
- Post-commit: `searchService.syncEntries(entityId, [factId])` +
  `evictCache(entityId)`. No embedding call (D4).
- `supersedeInTx` gains a `valid_to` guard (D3b) after the
  `already_superseded` check.
- Facade `WikiMemory.expire()` delegates. Core only — no wrapper (D6).

## Interfaces (cross-task contract)

```ts
// types.ts
export type WikiSupersedeReason =
  | 'not_found' | 'already_superseded' | 'immutable_target' | 'cycle'
  | 'cross_entity' | 'already_expired' | 'invalid_interval';

export class WikiSupersedeError extends Error {
  constructor(reason: WikiSupersedeReason, verb = 'supersede()');
  // message: `${verb} rejected: ${reason}`
}

// WikiMemory + TemporalService
async expire(entityId: string, factId: string, options?: { at?: number }): Promise<void>;
```

Guard order inside `expire()` (D1 + D3, mirrors `supersedeInTx` then own):
`not_found` → `cross_entity` → `already_superseded` → `immutable_target` →
`already_expired` (`valid_to != null`) → `invalid_interval`
(`at <= valid_from ?? created_at`) → write. A `changes === 0` from
`setTemporal` throws `cross_entity` (D2 backstop).

## Global constraints

- No schema migration, no wrapper exposure, no prune code changes (D5–D6).
- Version bump NOT in this PR — release is its own flow (see PR #408 pattern).
- Conventional commit titles; commit after every green test run.
- The INTENT.md sentence edit is a pre-merge obligation (D5) — T7.
- The `supersede()` lower-bound gap issue is filed at implementation time
  (D1) — T7.
- Prose in docs follows the existing docs voice; code stays natural.

## Worktree / commands

- Worktree: `/mnt/kv-work/build/worktrees/expo-llm-wiki/expire` (branch `specs/expire`).
- One test file: `pnpm --filter @equationalapplications/core-llm-wiki test -- expire`
- Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
- Build: `pnpm --filter @equationalapplications/core-llm-wiki build`
- Docs build: `pnpm --filter docs build`

## Test file scaffold (create once in T1, extend per task)

`packages/core/__tests__/expire.test.ts`:

```ts
// packages/core/__tests__/expire.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiSupersedeError } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { SQLiteAdapter } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;

async function insert(id: string, entity = 'e1', source_type = 'user_stated', created_at = 100) {
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, 'body', ?, 'certain', ?, ?)`,
    [id, entity, `title ${id}`, source_type, created_at, created_at],
  );
}
const temporal = (id: string) =>
  db.getFirstAsync<any>(`SELECT valid_from, valid_to, superseded_by, superseded_at FROM llm_wiki_entries WHERE id = ?`, [id]);

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
});

describe('expire()', () => {
  // tests land here, one task at a time
});
```

---

## T1 — widen the error type (AC8)

**Test first** (in the scaffold's `describe`, before other tests):

```ts
it('WikiSupersedeError carries the verb in its message (default unchanged)', () => {
  expect(new WikiSupersedeError('invalid_interval').message).toBe('supersede() rejected: invalid_interval');
  expect(new WikiSupersedeError('already_expired', 'expire()').message).toBe('expire() rejected: already_expired');
});
```

**Impl** — `packages/core/src/types.ts`:

```ts
export type WikiSupersedeReason = 'not_found' | 'already_superseded' | 'immutable_target' | 'cycle' | 'cross_entity' | 'already_expired' | 'invalid_interval';
```

Constructor:

```ts
constructor(reason: WikiSupersedeReason, verb = 'supersede()') {
  super(`${verb} rejected: ${reason}`);
  this.name = 'WikiSupersedeError';
  this.reason = reason;
  Object.setPrototypeOf(this, WikiSupersedeError.prototype);
}
```

**Run:** test file green. **Typecheck:** green (existing callers use the default verb — no call-site changes).
**Commit:** `feat(core): widen WikiSupersedeReason (already_expired, invalid_interval) + optional error verb`.

## T2 — expire() happy path + facade (AC1, AC3, AC6)

**Tests first:**

```ts
it('archives with valid_to only and honors asOf reads', async () => {
  await insert('f1'); // created_at 100
  await wiki.expire('e1', 'f1', { at: 5_000 });
  expect(await temporal('f1')).toEqual({ valid_from: null, valid_to: 5_000, superseded_by: null, superseded_at: null });
  const row = await db.getFirstAsync<any>(`SELECT deleted_at, body FROM llm_wiki_entries WHERE id = 'f1'`);
  expect(row.deleted_at).toBeNull();
  expect(row.body).toBe('body');
  expect((await wiki.read('e1', 'title f1', { asOf: 4_999 })).facts.map((f) => f.id)).toContain('f1');
  expect((await wiki.read('e1', 'title f1', { asOf: 5_000 })).facts.map((f) => f.id)).not.toContain('f1');
  expect((await wiki.read('e1', 'title f1')).facts.map((f) => f.id)).not.toContain('f1');
});

it('defaults at to now', async () => {
  await insert('f1');
  const before = Date.now();
  await wiki.expire('e1', 'f1');
  expect((await temporal('f1')).valid_to).toBeGreaterThanOrEqual(before);
});

it('honors an explicit past at (retro-active archive)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 500 });
  expect((await temporal('f1')).valid_to).toBe(500);
});

it('does not create a supersession link (history stays single-member)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 5_000 });
  expect((await wiki.history('e1', 'f1')).map((f) => f.id)).toEqual(['f1']);
});

it('history() still traverses through an expired member (AC6)', async () => {
  await insert('v1');
  const { newId: v2 } = await wiki.supersede('e1', 'v1', { title: 'v2', body: 'b' }, { validFrom: 200 });
  await wiki.expire('e1', v2, { at: 300 });
  expect((await wiki.history('e1', 'v1')).map((f) => f.id)).toEqual(['v1', v2]);
});
```

**Impl** — `packages/core/src/services/TemporalService.ts`, after `supersede()`:

```ts
/**
 * End `factId`'s validity without a replacement — an archive, not a
 * deletion (INTENT rule 12, spec specs/expire). Sets `valid_to` only.
 */
async expire(entityId: string, factId: string, options?: { at?: number }): Promise<void> {
  const t = options?.at === undefined ? Date.now() : assertEpochMs('options.at', options.at);
  await this.db.withTransactionAsync(async (tx) => {
    const old = await this.entryRepo.findTemporalRow(factId, tx);
    if (!old || old.deleted_at != null) throw new WikiSupersedeError('not_found', 'expire()');
    if (old.entity_id !== entityId) throw new WikiSupersedeError('cross_entity', 'expire()');
    if (old.superseded_by != null) throw new WikiSupersedeError('already_superseded', 'expire()');
    if (old.source_type === 'immutable_document') throw new WikiSupersedeError('immutable_target', 'expire()');
    if (old.valid_to != null) throw new WikiSupersedeError('already_expired', 'expire()');
    const start = old.valid_from ?? old.created_at;
    if (t <= start) throw new WikiSupersedeError('invalid_interval', 'expire()');
    const changes = await this.entryRepo.setTemporal(factId, entityId, { valid_to: t }, tx);
    if (changes === 0) throw new WikiSupersedeError('cross_entity', 'expire()');
  });
  await this.searchService.syncEntries(entityId, [factId]);
  this.searchService.evictCache(entityId);
}
```

Facade — `packages/core/src/WikiMemory.ts`, after `supersede()`:

```ts
/**
 * End `factId`'s validity without a replacement — an archive, not a
 * deletion (INTENT rule 12). Sets `valid_to` only: `superseded_by`,
 * `superseded_at` and `deleted_at` stay untouched, and an `asOf` read at
 * `T < valid_to` still returns the fact. Throws `WikiSupersedeError` for
 * a missing, foreign, already superseded, immutable-document, or already
 * expired target, and for an inverted or empty interval (`invalid_interval`).
 */
async expire(entityId: string, factId: string, options?: { at?: number }): Promise<void> {
  return this.temporalService.expire(entityId, factId, options);
}
```

**Run:** test file green (T3's guard cases may fail until T3 lands — only the
tests written so far must pass). **Typecheck:** green.
**Commit:** `feat(core): expire() — archive a fact by setting valid_to only (spec r5)`.

## T3 — guard stack + guard order (AC2)

**Tests first:**

```ts
it.each([
  ['not_found', async () => wiki.expire('e1', 'missing')],
  ['not_found', async () => { await insert('f1'); await db.runAsync(`UPDATE llm_wiki_entries SET deleted_at = 50 WHERE id = 'f1'`); return wiki.expire('e1', 'f1'); }],
  ['cross_entity', async () => { await insert('x', 'e2'); return wiki.expire('e1', 'x'); }],
  ['immutable_target', async () => { await insert('doc', 'e1', 'immutable_document'); return wiki.expire('e1', 'doc'); }],
  ['already_superseded', async () => { await insert('f1'); await wiki.supersede('e1', 'f1', { title: 't', body: 'b' }); return wiki.expire('e1', 'f1'); }],
  ['already_expired', async () => { await insert('f1'); await wiki.expire('e1', 'f1', { at: 500 }); return wiki.expire('e1', 'f1'); }],
])('rejects %s', async (reason, run) => {
  await expect(run()).rejects.toMatchObject({ name: 'WikiSupersedeError', reason });
});

it('guard order: a superseded row reports already_superseded, never already_expired', async () => {
  await insert('f1');
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_to = 50, superseded_by = 'v2', superseded_at = 60 WHERE id = 'f1'`);
  await expect(wiki.expire('e1', 'f1')).rejects.toMatchObject({ reason: 'already_superseded' });
});

it('cross_entity rejection leaves the row byte-identical and stages no outbox push', async () => {
  await insert('x', 'e2');
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 7, valid_to = 9 WHERE id = 'x'`);
  const before = await db.getFirstAsync<any>(`SELECT * FROM llm_wiki_entries WHERE id = 'x'`);
  await expect(wiki.expire('e1', 'x')).rejects.toMatchObject({ reason: 'cross_entity' });
  expect(await db.getFirstAsync<any>(`SELECT * FROM llm_wiki_entries WHERE id = 'x'`)).toEqual(before);
  expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_outbox WHERE record_id = 'x'`)).length).toBe(0);
});
```

**Impl:** none — T2 already wrote the full body. If any case fails, fix
`expire()` only (no new behavior).
**Run:** green. **Commit:** `test(core): expire() guard stack + guard-order pins (AC2)`.

## T4 — interval validation (AC3)

**Tests first:**

```ts
it('rejects an empty or inverted interval with invalid_interval (at == start included)', async () => {
  await insert('f1'); // created_at 100
  await expect(wiki.expire('e1', 'f1', { at: 100 })).rejects.toMatchObject({ reason: 'invalid_interval' });
  await expect(wiki.expire('e1', 'f1', { at: 99 })).rejects.toMatchObject({ reason: 'invalid_interval' });
  expect((await temporal('f1')).valid_to).toBeNull();
});

it('uses valid_from over created_at as the interval start', async () => {
  await insert('f1');
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 300 WHERE id = 'f1'`);
  await expect(wiki.expire('e1', 'f1', { at: 200 })).rejects.toMatchObject({ reason: 'invalid_interval' });
  await wiki.expire('e1', 'f1', { at: 301 });
  expect((await temporal('f1')).valid_to).toBe(301);
});

it('rejects a non-finite or negative at with TypeError', async () => {
  await insert('f1');
  for (const bad of [-1, NaN, Infinity]) {
    await expect(wiki.expire('e1', 'f1', { at: bad })).rejects.toBeInstanceOf(TypeError);
  }
  expect((await temporal('f1')).valid_to).toBeNull();
});
```

**Impl:** none — T2 covers it. **Run:** green.
**Commit:** `test(core): expire() interval validation pins (AC3)`.

## T5 — supersede-after-expire guard (D3b, AC2b)

**Test first:**

```ts
it('supersede() of an expired fact throws already_expired and preserves the archive date (D3b)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 500 });
  await insert('v2');
  await expect(wiki.supersede('e1', 'f1', 'v2')).rejects.toMatchObject({ name: 'WikiSupersedeError', reason: 'already_expired' });
  expect((await temporal('f1')).valid_to).toBe(500);
  expect((await temporal('f1')).superseded_by).toBeNull();
});

it('double-supersede regression: already_superseded still wins over already_expired', async () => {
  await insert('v1');
  const { newId: v2 } = await wiki.supersede('e1', 'v1', { title: 'v2', body: 'b' }, { validFrom: 200 });
  await expect(wiki.supersede('e1', 'v1', { title: 'again', body: 'b' })).rejects.toMatchObject({ reason: 'already_superseded' });
  expect((await temporal('v1')).superseded_by).toBe(v2);
});
```

**Impl** — `supersedeInTx`, insert immediately after the existing
`already_superseded` check (before `immutable_target`):

```ts
if (old.valid_to != null) throw new WikiSupersedeError('already_expired');
```

**Run:** the whole test file green — especially the pre-existing
`supersede.test.ts` suite (regression case `supersede.test.ts:64-70` must
stay green). **Typecheck:** green.
**Commit:** `feat(core): reject supersede of an expired fact — preserve the archive valid_to (D3b)`.

## T6 — outbox, events, search, prune (AC4, AC5, AC7)

**Tests first:**

```ts
it('stages exactly one UPDATE outbox row carrying id, entity_id, valid_to (AC4)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 5_000 });
  const rows = await db.getAllAsync<any>(`SELECT operation, payload FROM llm_wiki_outbox WHERE record_id = 'f1'`);
  expect(rows.length).toBe(1);
  expect(rows[0].operation).toBe('UPDATE');
  expect(JSON.parse(rows[0].payload)).toMatchObject({ id: 'f1', entity_id: 'e1', valid_to: 5_000 });
});

it('does not append to the events table (events are librarian input)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 5_000 });
  expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_events`)).length).toBe(0);
});

it('drops the fact from the FTS index (AC5)', async () => {
  await insert('f1');
  await db.execAsync(`INSERT INTO llm_wiki_entries_fts (id, entity_id, title, body, tags) VALUES ('f1', 'e1', 'title f1', 'body', '[]')`);
  await wiki.expire('e1', 'f1', { at: 5_000 });
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) AS n FROM llm_wiki_entries_fts WHERE id = 'f1'`)).n).toBe(0);
});

it('runPrune soft-deletes the expired row after the retention window (AC7)', async () => {
  const raw = openTestDatabase();
  const w = new WikiMemory(raw, { llmProvider: { generateText: async () => '{}' }, pruneSupersededAfter: 1 });
  await w.setup();
  await raw.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at) VALUES ('f1', 'e1', 't', 'body', 'user_stated', 'certain', 100, 100)`);
  await w.expire('e1', 'f1', { at: Date.now() - 2 * 86_400_000 });
  await w.runPrune('e1');
  expect((await raw.getFirstAsync<any>(`SELECT deleted_at FROM llm_wiki_entries WHERE id = 'f1'`)).deleted_at).not.toBeNull();
});

it('runPrune leaves the expired row alone with the default retention (D5: host policy)', async () => {
  await insert('f1');
  await wiki.expire('e1', 'f1', { at: 5_000 });
  await wiki.runPrune('e1');
  expect((await db.getFirstAsync<any>(`SELECT deleted_at FROM llm_wiki_entries WHERE id = 'f1'`)).deleted_at).toBeNull();
});
```

**Impl:** none expected — `setTemporal` pushes the outbox UPDATE;
`syncEntries` rebuilds the entity index from live rows; `findExpiredIds` +
`runPrune` already cover prune. If the FTS test shows the row re-indexed,
stop and re-read `SearchService.syncEntries` before touching anything —
the fix belongs there only if it indexes non-live rows for superseded
facts too.
**Run:** green. **Typecheck + build:** green.
**Commit:** `test(core): expire() outbox/search/prune integration pins (AC4, AC5, AC7)`.

## T7 — INTENT sentence, docs, supersede-gap issue (D1 note, D5, D7, AC9)

1. **INTENT.md** — locate the stale sentence:

   ```bash
   grep -n "needs a spec home" INTENT.md
   ```

   Replace it (line ~346-347) with:

   ```
   expire()'s spec home is `specs/expire/`.
   ```

   No other INTENT.md change. Commit on this branch (pre-merge obligation).

2. **`apps/docs/src/content/docs/reference/wiki-memory.md`** — add a table
   row after the `supersede` row (:34):

   ```markdown
   | `expire(entityId, factId, { at })` | `Promise<void>` | Archives a fact: sets `valid_to`, no replacement, no deletion. Throws `WikiSupersedeError`. |
   ```

3. **`apps/docs/src/content/docs/reference/errors.md`** (:36) — change the
   `WikiSupersedeError` row's description from
   `` `supersede()` was refused `` to
   `` `supersede()` or `expire()` was refused ``.

4. **`apps/docs/src/content/docs/guides/temporal-facts.md`** — in the Rules
   section (~:40-44) add the expire rules and after the supersede example
   add:

   ```markdown
   To end a fact's validity without a replacement — an archive, not a
   deletion — use `expire()`. It sets `valid_to` only: the fact stays in
   the store, `asOf` reads before that time still return it, and no
   supersession link is created.

   ```ts
   await wiki.expire(entityId, factId, { at: validUntil });
   ```

   It rejects a missing, foreign, already superseded, immutable-document,
   or already expired fact, and an `at` at or before the fact's validity
   start (`invalid_interval`).
   ```

5. **`apps/docs/src/content/docs/reference/glossary.md`** (:62-65) — replace
   `Planned, not yet released — a separate spec precedes its
   implementation.` with `Ships in this release — see [Temporal
   facts](/expo-llm-wiki/guides/temporal-facts/).`

6. **Supersede lower-bound gap issue** (D1 note): **ALREADY FILED by the
   controller as #414** (2026-11-18) — do NOT create another. Put
   "References #414" in the PR body at step 9 (not "Fixes": it stays
   open).

**Run:** `pnpm --filter docs build` green. **Commit:**
`docs(core): expire() API page, guide, errors, glossary + INTENT spec-home sentence`.

## T8 — full gate

```bash
pnpm --filter @equationalapplications/core-llm-wiki typecheck
pnpm --filter @equationalapplications/core-llm-wiki build
pnpm --filter @equationalapplications/core-llm-wiki test
pnpm --filter docs build
```

All green, worktree clean, branch pushed. Then the review loop (Step 7 of
the delivery flow), the Step 8 flip (`**Status:**` → Implemented, delete
`plan.md` + `LEDGER.md` in the same cleanup commit, BEFORE merge), and the
final PR body update (links spec + plan + issue; "Fixes #410" is NOT set —
the anchor is forget-erasure T11; the supersede-gap issue is referenced,
not closed).


## Review notes — pre-adjudicated dispositions (Tier-1.5 implementation ladder, 2026-11-18)

Reviewer instruction: weigh each disposition below and flag ONLY if you
DISAGREE (with file:line + suggested fix). Do not re-litigate what you
agree with.

1. T3/T4 added no implementation code — the guard stack and interval
   checks were written in T2 per the plan; those tasks are test-only pins.
   Their tests passing first-run is the expected outcome, not a skipped
   RED gate (the plan said so per task).
2. T6 test-side folds (no src changes): outbox/prune options live under
   `config` (source truth: WikiOptions), not top level; the AC5 search
   pin is behavioral ("read no longer returns the fact") because the FTS
   index retains non-deleted rows by design — temporal filtering is
   query-time (`liveAtSql`), so a row-count pin would be wrong.
3. The supersede-gap (no lower-bound check in supersede()) is
   intentionally OUT of this PR — filed as #414 per spec D1.
4. The expire error verbs: `WikiSupersedeError` keeps its class name and
   `code`; only the message verb changes (spec D3, owner-ratified).
5. `changes === 0` backstop throws `cross_entity` (spec D2) — defense in
   depth behind the memory-level guard, not a distinct reason.
