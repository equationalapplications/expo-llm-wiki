# supersede(): reject an inverted or empty validity interval — plan

Spec: `specs/supersede-lower-bound/spec.md` (Status: Reviewed — owner
ratified 2026-11-18, msg `1572645718122954859`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `supersedeInTx` rejects a supersede at or before the old fact's
validity start with `WikiSupersedeError('invalid_interval')`, with tests
and docs, per the spec.

**Architecture:** one guard line pair in `TemporalService.supersedeInTx`,
placed after the existing guard stack and immediately before the writes
(D1/D2 of the spec). Tests first (RED), then the guard (GREEN), then docs.

**Tech Stack:** TypeScript, vitest, pnpm workspaces, Astro docs.

## Global Constraints

- Lower bound expression, verbatim: `old.valid_from ?? old.created_at`.
- Reject condition, verbatim: `if (t <= start) throw new WikiSupersedeError('invalid_interval');`
  (no second constructor argument — the default verb is `'supersede()'`).
- Guard order (D2): the check sits after the `cycle` checks and before
  the `setTemporal` writes in `supersedeInTx`. Do not reorder existing guards.
- No type widening: `invalid_interval` already exists in
  `WikiSupersedeReason` (`packages/core/src/types.ts:1614`).
- Conventional commits name the spec section they fulfill.
- Tick a LEDGER box only after its verification passes.

## Preflight (do first, every fresh checkout)

- [ ] `pnpm install`
- [ ] `pnpm -r --filter './packages/*' build` — core-okf has no `dist`;
      without this, typecheck and vitest fail on missing workspace builds.
- [ ] Baseline: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
      and `pnpm --filter @equationalapplications/core-llm-wiki test` are green.
      Record the baseline in the LEDGER before touching anything.

---

### Task 1: RED — all regression tests, core + ops path

**Files:**
- Modify: `packages/core/__tests__/supersede.test.ts` (suite `supersede()`)
- Modify: `packages/core/__tests__/opsLibrarian.test.ts` (ops-path case)

**Interfaces:**
- Consumes: `WikiMemory.supersede(entityId, oldId, replacement, options?)`,
  `insert(id, entity?, source_type?, created_at?)` helper (existing, defaults
  `created_at` to 100), `temporal(id)` helper, `wiki.remember`/`runLibrarian`
  helpers used by the existing `already_expired` ops test
  (`opsLibrarian.test.ts:135`).
- Produces: test names the later tasks rely on staying green.

- [ ] **Step 1: Write the core RED cases** in `packages/core/__tests__/supersede.test.ts`,
      inside `describe('supersede()')`:

```ts
it('rejects an empty interval with invalid_interval (t == start)', async () => {
  await insert('seattle'); // created_at defaults to 100
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 100 }))
    .rejects.toMatchObject({ reason: 'invalid_interval' });
  const t = await temporal('seattle');
  expect(t.valid_to).toBeNull();
  expect(t.superseded_by).toBeNull();
});

it('rejects an inverted interval with invalid_interval (t < start)', async () => {
  await insert('seattle');
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 99 }))
    .rejects.toMatchObject({ reason: 'invalid_interval' });
});

it('uses valid_from over created_at as the start', async () => {
  await insert('seattle'); // created_at 100
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 500 WHERE id = 'seattle'`);
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 400 }))
    .rejects.toMatchObject({ reason: 'invalid_interval' });
  const { newId } = await wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 600 });
  const t = await temporal('seattle');
  expect(t.valid_to).toBe(600);
  expect(t.superseded_by).toBe(newId);
});

it('reports already_expired before invalid_interval (guard order, spec D2)', async () => {
  await insert('seattle'); // created_at 100
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_to = 50 WHERE id = 'seattle'`);
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 40 }))
    .rejects.toMatchObject({ reason: 'already_expired' });
});

it('rejects a default validFrom on a future-dated fact until its start', async () => {
  await insert('seattle'); // created_at 100
  await db.runAsync(`UPDATE llm_wiki_entries SET valid_from = 9999999999999 WHERE id = 'seattle'`);
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }))
    .rejects.toMatchObject({ reason: 'invalid_interval' });
});

it('leaves no partial writes when the interval rejects', async () => {
  await insert('seattle');
  await expect(wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b' }, { validFrom: 50 }))
    .rejects.toMatchObject({ reason: 'invalid_interval' });
  const rows = await db.getAllAsync<any>(`SELECT id FROM llm_wiki_entries`);
  expect(rows.map((r) => r.id)).toEqual(['seattle']);
  const t = await temporal('seattle');
  expect(t.superseded_by).toBeNull();
});

it('still allows an explicit early valid_from on the replacement (scope boundary, spec D3.3)', async () => {
  await insert('seattle'); // created_at 100
  const { newId } = await wiki.supersede('e1', 'seattle', { title: 'SF', body: 'b', valid_from: 50 }, { validFrom: 200 });
  const fresh = await temporal(newId);
  expect(fresh.valid_from).toBe(50);
  const t = await temporal('seattle');
  expect(t.valid_to).toBe(200);
});
```

- [ ] **Step 2: Write the ops-path RED case** in `packages/core/__tests__/opsLibrarian.test.ts`,
      modeled on the `already_expired` ops test at :135 (same `mk` helper
      shape, target `created_at` 1, event time 100):

```ts
it('SUPERSEDE whose time is at or before the target start is rejected as invalid_interval and leaves both facts live', async () => {
  // Target created_at = 1; the candidate event carries time 1 (via its
  // source_event label), so supersedeFrom = 1 == the target's start, and
  // the op must reject instead of linking an empty window. Ops target the
  // neighbour alias, not the raw row id — use 'n1' like every existing test.
  const { db, wiki, diagnostics } = mk([
    () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
    () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }),
  ]);
  await wiki.setup();
  await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
    VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
  await wiki.runReembed();
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',1)`);
  await wiki.runLibrarian('u');
  const rejected = ofCode(diagnostics, 'librarian_op_rejected');
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as any).detail.reason).toBe('invalid_interval');
  // Both facts stay live and retrievable (spec D3.4).
  const old = await db.getFirstAsync<any>(`SELECT valid_to, superseded_by, valid_from FROM llm_wiki_entries WHERE id='seattle'`);
  expect(old.valid_to).toBeNull();
  expect(old.superseded_by).toBeNull();
  const fresh = await db.getFirstAsync<any>(`SELECT id, valid_to, superseded_by, valid_from FROM llm_wiki_entries WHERE id != 'seattle'`);
  expect(fresh.valid_to).toBeNull();
  expect(fresh.superseded_by).toBeNull();
  expect(fresh.valid_from).toBe(1);
  const read = await wiki.read('u', 'where does the user live');
  expect(read.facts.length).toBe(2);
  const asOfRead = await wiki.read('u', 'where does the user live', { asOf: 1 });
  expect(asOfRead.facts.length).toBe(2);
});
```

  **Executor note:** before writing this test, read the existing
  `already_expired` ops test (:135-170) and the `mk` helper, and mirror
  their exact fixture mechanics — the event insertion shape, the
  `ofCode` import, and how `source_event` maps the candidate's time via
  `extract.ts:116` (the op object carries no `valid_from`; the event
  time IS the supersede time). If `read()`'s result shape differs,
  assert on its actual shape; the pin is "both facts come back, default
  and asOf", not a specific field list.

- [ ] **Step 3: Run the RED check**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/supersede.test.ts __tests__/opsLibrarian.test.ts`
Expected: the four guard cases and the ops case FAIL for the right reason
(no `invalid_interval` thrown — today the calls succeed or link corruptly).
The scope-boundary case and the existing suite PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/supersede.test.ts packages/core/__tests__/opsLibrarian.test.ts
git commit -m "test(core): supersede lower-bound RED cases (spec D1, D2, D3.3, D3.4)"
```

### Task 2: GREEN — the guard in supersedeInTx

**Files:**
- Modify: `packages/core/src/services/TemporalService.ts:44-51`
  (inside `supersedeInTx`, after the `cycle` checks, before the writes)

**Interfaces:**
- Consumes: nothing new — `WikiSupersedeError` is already imported.
- Produces: the rejection contract every later task documents.

- [ ] **Step 1: Insert the guard** between the `predecessors.some(...)`
      cycle check and the first `setTemporal` call:

```ts
const start = old.valid_from ?? old.created_at;
if (t <= start) throw new WikiSupersedeError('invalid_interval');
```

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/supersede.test.ts __tests__/opsLibrarian.test.ts __tests__/expire.test.ts`
Expected: all green — new cases pass, expire() untouched, existing
supersede suite (including "no gap") untouched.

- [ ] **Step 3: Run the full core suite** (the guard touches a shared
      service; ingest, forgetChain, migration suites exercise supersede)

Run: `pnpm --filter @equationalapplications/core-llm-wiki test`
Expected: green. If a suite fails because IT relied on a corrupt
pre-start supersede, stop and surface the failure to the owner — do not
weaken the guard or edit the test to pass silently.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/services/TemporalService.ts
git commit -m "fix(core): reject inverted/empty supersede intervals (spec D1, D2)"
```

### Task 3: Docs — JSDoc and guide

**Files:**
- Modify: `packages/core/src/WikiMemory.ts:1174-1178` (`supersede()` JSDoc)
- Modify: `apps/docs/src/content/docs/guides/temporal-facts.md` (`## Rules`)

**Interfaces:**
- Consumes: the shipped guard from Task 2.
- Produces: user-facing documentation the release notes cite.

- [ ] **Step 1: Amend the `supersede()` JSDoc throws sentence** to read
      like `expire()`'s (:1188-1196): add "and for an inverted or empty
      interval (`invalid_interval`)" after the existing target list.

- [ ] **Step 2: Add the guide paragraph** in `temporal-facts.md`, after
      the "when the target:" bullet list in `## Rules`, as its own
      paragraph (spec D4):

```markdown
`supersede()` also rejects a `validFrom` at or before the target's validity
start (`invalid_interval`). An omitted `validFrom` applies the same rule to
the current time, so a fact whose validity starts in the future rejects
until that start. An explicit early `valid_from` on the replacement fact is
not validated against the target.
```

- [ ] **Step 3: Verify the docs build**

Run: `pnpm --filter docs build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/WikiMemory.ts apps/docs/src/content/docs/guides/temporal-facts.md
git commit -m "docs(core): supersede invalid_interval reason (spec D4)"
```

### Task 4: Full gate + ledger reconcile

- [ ] **Step 1:** `pnpm --filter @equationalapplications/core-llm-wiki typecheck` — green.
- [ ] **Step 2:** `pnpm --filter @equationalapplications/core-llm-wiki test` — green.
- [ ] **Step 3:** `pnpm --filter docs build` — green.
- [ ] **Step 4:** Reconcile `LEDGER.md` against the disk; every ticked
      box carries its evidence link.

### Task 5: Review ladder, cleanup, ready flip (same session as Task 4)

- [ ] **Step 1:** Tier-3 Opus + Tier-4 Fable reviews on the implemented
      PR; convergence cycles until both APPROVE (fold nits same-hour).
- [ ] **Step 2:** Cleanup commit on the same PR: flip the spec Status to
      **Implemented**, delete `plan.md` and `LEDGER.md` (specs/README
      step 4 — never a separate cleanup PR).
- [ ] **Step 3:** `gh pr ready`; bot reviews fire on the flip.
- [ ] **Step 4:** Merge after CI green + reviews converged; record the
      lane in the vault session record.
