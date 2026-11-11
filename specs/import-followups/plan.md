# Import follow-ups — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #367 (unguarded hook in `importDump`), #366 (ops default `valid_from`) and #365 (deterministic ids for id-less OKF log events), plus the plain-summary unescape defect (§3.6).

**Architecture:** Three independent changes in three commit groups, in spec §4 order. #365 adds a hand-written SHA-256 and `deriveEventId` to `core-okf`, and `parseOkfBundle` in `core` calls it.

**Tech Stack:** TypeScript, vitest, pnpm workspace, tsup.

**Spec:** `specs/import-followups/spec.md`. Test numbers below (for example "§1 T1") are the numbered items in that section's test plan; the spec holds their exact inputs and expectations.

## Global Constraints

- pnpm only; no new dependency anywhere (INTENT rule 8). `core-okf` keeps zero runtime dependencies.
- `core-okf` builds with `lib: ["ES2020"]`: no `TextEncoder`, no `crypto` in `packages/okf/src`.
- `core` tests import `core-okf` from its `dist`. After any `packages/okf/src` change run `pnpm --filter @equationalapplications/core-okf build` before `core` tests.
- Never edit `CHANGELOG.md` or a `"version"` field; no `BREAKING CHANGE` footer; no line starting with that phrase.
- Docs make no accuracy or cost claim (INTENT rule 11).
- Status notes on older specs are appended and dated, never replacing text.
- Conventional commits name the spec section, e.g. `fix(core): … (spec §1)`.

## Review Focus

1. A hook that throws for **every** fact in a multi-entity dump: all entities still import, one `hook_failed` per fact. Pin in Task 1 (extend §1 T1 with a second variant where the hook always throws).
2. A batch where every event has `occurred_at` in the future: default is exactly the mocked now, not the smallest future date. Pin in Task 2 (extend §2 T5).
3. A summary with a non-BMP character (emoji) and a lone surrogate hashed through `deriveEventId`: no throw, stable id. Covered by §3.3 vector 5 and §3 T2; add a lone-surrogate summary case to Task 4.
4. A plain summary ending in a single backslash (`C:\`) round-trips unchanged through export and import. Pin in Task 5 (add to §3 T18).
5. A log with an id-less line whose summary is empty after trim: does not parse (no event, no occurrence used), as today. Pin in Task 5 (part of §3 T16).

---

### Task 1: #367 guard the no-vector hook call in `importDump` (spec §1)

**Files:**
- Modify: `packages/core/src/services/ImportExportService.ts:521-523`
- Test: `packages/core/__tests__/diagnosticsEmbedding.test.ts`

- [ ] **Step 1:** Add tests §1 T1–T5 to the `embedding diagnostics` describe, using `makeDiagnosticWiki`, `ofCode`, `expectNoContent`. Hooks go in `extra.vectorRanker` as the existing test at `:55` does. Build dumps directly as `MemoryDump` objects (facts with no `embedding_blob`). T1's `hook_failed` must equal exactly `[{ operation: 'importDump', trigger: 'call', entityId: 'e1', detail: { factId: 'X', reason: 'on_embedding_persisted' } }]` (use `objectContaining` for the envelope). Add Review Focus 1 as a T1 variant.
- [ ] **Step 2:** Run `pnpm --filter @equationalapplications/core exec vitest run __tests__/diagnosticsEmbedding.test.ts`. Expected: T1–T4 FAIL (`importDump` rejects); T5 passes.
- [ ] **Step 3:** Wrap the call in `try/catch (hookErr)`: `console.warn` in the same shape as the preserved-blob loop below it, then `this.embeddingService.reportHookFailed({ operation: 'importDump', trigger: 'call' }, entityId, fact.id)`.
- [ ] **Step 4:** Re-run the file. Expected: all PASS.
- [ ] **Step 5:** Commit `fix(core): importDump reports a throwing no-vector hook as hook_failed (spec §1, #367)`.

### Task 2: #366 default `valid_from` is the newest date, capped at now (spec §2)

**Files:**
- Modify: `packages/core/src/services/librarian/ops/extract.ts:74,85`
- Test: `packages/core/__tests__/opsExtract.test.ts`, `packages/core/__tests__/opsLibrarian.test.ts`
- Docs: `apps/docs/src/content/docs/guides/temporal-facts.md`, `docs/superpowers/specs/2026-09-29-competitive-memory-design.md`

- [ ] **Step 1:** Add §2 T1, T3, T4, T5 to `opsExtract.test.ts` (`runExtract` describe, `mk()`'s `ev(id, created_at, summary, occurred_at)`). Mock now with `vi.spyOn(Date, 'now')`. Add Review Focus 2 to T5.
- [ ] **Step 2:** Add §2 T6 and T7 to `opsLibrarian.test.ts` using that file's existing full-pass helpers.
- [ ] **Step 3:** Run both files. Expected: T1, T5, T6, T7 FAIL on main; existing `:37-58` passes.
- [ ] **Step 4:** Replace `newestAt` with `defaultValidFrom = Math.min(<max of batch[i].at by loop/reduce>, Date.now())`; use it at `:85`. No spread into `Math.max`.
- [ ] **Step 5:** Re-run both files. Expected: PASS.
- [ ] **Step 6:** Add the one guide sentence (spec §2 Files touched) and the dated Status note on the competitive-memory design recording the cap.
- [ ] **Step 7:** Commit code+tests as `fix(core): ops default valid_from is the newest batch date, never later than now (spec §2, #366)`; docs as a separate `docs:` commit.

### Task 3: `core-okf` SHA-256 and UTF-8 encoder (spec §3.3, §3.4)

**Files:**
- Create: `packages/okf/src/sha256.ts` (internal, not exported from `index.ts`)
- Test: `packages/okf/__tests__/sha256.test.ts`

**Interfaces — Produces:** `export function utf8Encode(s: string): Uint8Array` (lone surrogate → `EF BF BD`); `export function sha256(bytes: Uint8Array): Uint8Array` (32 bytes).

- [ ] **Step 1:** Write §3 T1 (FIPS 180-4: `''` → `e3b0c442…b855`, `'abc'` → `ba7816bf…15ad`, the 56-byte `abcdbcde…nopq` → `248d6a61…06c1`, full hex in test) and §3 T2 (compare with `new TextEncoder().encode` for ASCII, `é`, `☕`, `😀`, `'\uD800'`, `'a\uDC00b'`).
- [ ] **Step 2:** Run `pnpm --filter @equationalapplications/core-okf exec vitest run __tests__/sha256.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement both with 32-bit integer ops only (`>>> 0`, `Math.imul` not required).
- [ ] **Step 4:** Re-run; then `pnpm --filter @equationalapplications/core-okf typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5:** Commit with Task 4 (one `feat(okf)` commit).

### Task 4: `deriveEventId` (spec §3.2–§3.4)

**Files:**
- Create: `packages/okf/src/event-id.ts`
- Modify: `packages/okf/src/index.ts` (export `deriveEventId`), `packages/okf/README.md`, `apps/docs/src/content/docs/packages/core-okf.md`
- Test: `packages/okf/__tests__/event-id.test.ts`

**Interfaces:**
- Consumes: `utf8Encode`, `sha256` (Task 3).
- Produces: `export function deriveEventId(input: { entityId: string; date: string; eventType: string; summary: string; occurrence: number }): string` — returns `'evt_okf1_' + first 32 hex chars`; `TypeError` unless `Number.isInteger(occurrence) && occurrence >= 0`.

- [ ] **Step 1:** Write §3 T3–T6. T3 uses the six rows of the §3.3 table verbatim; also assert the encoded bytes of row 1 equal the §3.3 `bytes:` line (export a non-public `encodeEventIdInput` from `event-id.ts` only if needed for this; do not add it to `index.ts`). Add Review Focus 3 (lone surrogate in summary: no throw, equals the id for `'\uFFFD'`).
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement: fields in order `llm-wiki/event-id/1`, entityId, date, eventType, summary, `String(occurrence)`; each `<utf8 byte length>:<bytes>,`; SHA-256; lowercase hex.
- [ ] **Step 4:** Re-run the okf suite: `pnpm --filter @equationalapplications/core-okf test` and `typecheck`. Expected: PASS.
- [ ] **Step 5:** Add the primitive to the okf README and the core-okf docs page (one short entry each).
- [ ] **Step 6:** Commit Tasks 3–4 as `feat(okf): deriveEventId for id-less log events (spec §3.3, §3.4, #365)`.

### Task 5: `parseOkfBundle` derives ids and unescapes plain summaries (spec §3.1, §3.6)

**Files:**
- Modify: `packages/core/src/utils/parseOkfBundle.ts:182` (plain unescape), `:514-540` (occurrence map + `deriveEventId`)
- Test: `packages/core/__tests__/parseOkfBundle.test.ts`, `packages/core/__tests__/okfProfileConformance.test.ts`

**Interfaces — Consumes:** `deriveEventId` from `@equationalapplications/core-okf` (Task 4; rebuild okf dist first).

- [ ] **Step 1:** Write §3 T7, T9–T18 in `parseOkfBundle.test.ts`; update the `evt_generated` expectations (T8, e.g. `:436`) to the derived id computed by calling `deriveEventId` in the test. T17: spy `ids.generateId` and assert no call with `'evt_'`. Add Review Focus 4 to T18 and Review Focus 5 to T16.
- [ ] **Step 2:** Write §3 T19 (exact ids `evt_okf1_02dd42bf329719f258ab93b373f44506` and `evt_okf1_9a70e3a388247f9c27f96fc3855b3975`, in file order) and T20 in `okfProfileConformance.test.ts`.
- [ ] **Step 3:** Build okf dist, run both files. Expected: T7, T8, T10–T19 FAIL on main.
- [ ] **Step 4:** Implement: plain branch returns `unescapeLogSummary(plainSummary.trim())`; keep `Map<string, number>` keyed by a length-prefixed or JSON-array key of `[date, event_type, summary]`; take and increment the count only after the line parsed **and** `created_at` is finite, and only when `eventId` is undefined. `generateId` import stays (edges).
- [ ] **Step 5:** Re-run both files, then `pnpm --filter @equationalapplications/core test` and `typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit `fix(core): parseOkfBundle derives stable ids for id-less log lines and unescapes plain summaries (spec §3.1, §3.6, #365)`.

### Task 6: Re-import behaviour against a real store (spec §3 T21–T26)

**Files:**
- Create: `packages/core/__tests__/okfReimport.test.ts`

- [ ] **Step 1:** Write T21–T26 using `openTestDatabase`, `WikiMemory`, `parseOkfBundle`, `formatOkfBundle`, with a mocked `generateText` counting calls. T25 inserts one row with a random id via `importDump` of a hand-built dump before importing the parsed log. T26 uses the existing prune path the import-past-dated-events tests use.
- [ ] **Step 2:** Confirm T21 and T22 fail without the fix: temporarily put `generateId('evt_')` back at the derived-id line, run the file, record the failure in the ledger, restore the line.
- [ ] **Step 3:** Run the file with the fix. Expected: PASS.
- [ ] **Step 4:** Commit `test(core): OKF re-import is a no-op while events are stored (spec §3, #365)`.

### Task 7: Profile and docs (spec §3.7, §4)

**Files:**
- Modify: `docs/okf-profile.md` §7 (dated amendment, new subsection with §3.2/§3.3 and vectors, round-trip row, Changelog line), `apps/docs/src/content/docs/guides/okf.md` ("Event ids" section: skipped only while earlier events are stored; no cost claim; note the one-time duplicate of §3.5), `specs/import-past-dated-events/spec.md` and `docs/superpowers/specs/2026-07-05-okf-profile-design.md` (dated Status notes).

- [ ] **Step 1:** Write the edits. Copy vectors from spec §3.3 exactly.
- [ ] **Step 2:** `pnpm --filter docs build` (or the docs app's build script) passes.
- [ ] **Step 3:** Commit `docs(okf): profile §7 derived event ids; guide and status notes (spec §3.7, §4)`.

### Task 8: Whole-branch verification and cleanup

- [ ] **Step 1:** Root `pnpm test`, `pnpm -r typecheck`, `pnpm lint` if present. Expected: all green.
- [ ] **Step 2:** Whole-branch review; fix findings.
- [ ] **Step 3:** Final cleanup commit: spec Status → Implemented, delete `plan.md` and `LEDGER.md`. Then `gh pr ready 371`.
