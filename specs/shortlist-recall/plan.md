# Plan — PR 2a: shortlist builder + `shortlist-recall` benchmark (roadmap step 7)

Spec: `specs/shortlist-recall/spec.md` (APPROVED, owner rulings folded 2026-11-21:
k = 10 confirmed; the 2b scorer is decided AFTER this PR's real run — this PR
chooses nothing; the distractor generator ships as-is). Base: `origin/main` @
`e43095c8`. Branch: `spec/shortlist-recall` (PR #439). Merge position: fourth of
the four wave-1 PRs; PR 2b wiring is a separate later PR.

All file:line pins below were re-verified against this branch 2026-11-21.

## Global constraints (every task inherits these)

- **No CI model downloads.** All unit/CLI tests use a deterministic stub embed
  function; fastembed is never imported in test paths. Both packages' vitest
  configs include ONLY `__tests__/**/*.test.ts` under the package root
  (`packages/core/vitest.config.ts:5`, same shape in
  `packages/benchmarks/vitest.config.ts`), so test files live at
  `packages/core/__tests__/shortlist.test.ts` and
  `packages/benchmarks/__tests__/shortlistRecall.test.ts` — nowhere else.
- **Zero token spend.** No LLM calls anywhere in the benchmark; the only model
  cost is the one-time local fastembed ONNX download (~150 MB, gitignored
  `.cache/`, `packages/benchmarks/src/embed.ts:17`) during the real run.
- **Gate posture: the benchmark gates nothing** (INTENT Rule 11 — measures
  only). No pass/fail threshold, no engine gate; the result file is a report.
- **Guard semantics per spec:** without `--yes` the command prints the estimate
  and exits 0; `--dry-run` additionally guarantees the embed factory is never
  called. The embedder is built LAZILY — the CLI branch passes a factory, the
  runner invokes it only after the guard passes. Do NOT copy the supersession
  branch's build-embedder-before-flags order (`cli.ts:962-985`).
- **Determinism fields recorded** in every result file: engine version, model
  id + fastembed package version, pool sizes, per-pool per-k recall per scorer,
  random baselines, per-entry hit/miss.
- **Scope fence:** 2a touches only `packages/core/src/utils/shortlist.ts`,
  `packages/core/__tests__/shortlist.test.ts`,
  `packages/benchmarks/src/shortlistRecall.ts`,
  `packages/benchmarks/__tests__/shortlistRecall.test.ts`,
  `packages/benchmarks/src/cli.ts`, one committed result file under
  `packages/benchmarks/results/`, and this spec folder. No
  `MaintenanceService.ts`, no `PromptService.ts`, no backfill prompt, no core
  package entry-point export (PR 2b owns that), no `docs/ROADMAP.md` edit.
- **Core stays pure:** `shortlist.ts` must not import fastembed or any I/O;
  lexical only in core default; embeddings enter only via the injected scorer.
- Commits: author `Tessera <tessera@equational.app>`; no merge, no undraft, no
  rebase/force-push.

## Verified anchors (single source for all tasks)

| Symbol | Location (verified) |
|---|---|
| `titleTokens(s): Set<string>` | `packages/core/src/utils/pure.ts:918` |
| `jaccardScore(a, b): number` | `packages/core/src/utils/pure.ts:922` (0/0 → 0) |
| `normalizeTitleKey(t): string` (trim + lowercase + collapse whitespace ONLY — no punctuation folding) | `packages/core/src/utils/ontology.ts:13` |
| catalog row shape / dedupe last-wins / UTF-16 sort / 200-cap / 8000-char | `packages/core/src/prompts.ts:75-98` |
| `SEED_NODES` (3 rows, `{title, type, body}`) | `packages/benchmarks/src/statementKinds/run.ts:42` |
| `TARGET_TYPES = ['area','software_application','organization']` | `packages/benchmarks/src/statementKinds/run.ts:32` |
| `parseStatementFixture` / `loadStatementFixture` | `run.ts:54` / `run.ts:69` |
| fixture (28 entries, `expected_target.{title,type}`) | `packages/benchmarks/fixtures/statement-kinds.json` |
| `cosineSimilarity(a, b)` | `packages/core/src/utils/cosine.ts:1` |
| direct core-source-import pattern | `packages/benchmarks/src/calibrate.ts:23-27` |
| `resolveOutPath(p)` (exported, `:87`); `nowStamp` (`:261`) and `defaultResultsDir` (`:266`) are PRIVATE to cli.ts; default dir `packages/benchmarks/results/raw` is gitignored (`.gitignore:2`) | `packages/benchmarks/src/cli.ts` |
| dispatch chain (fallthrough at `:1012`) + help block (`:1016+`) | `packages/benchmarks/src/cli.ts:950-1014` |
| `EMBED_MODEL = 'fastembed/BGESmallENV15'` | `packages/benchmarks/src/report.ts:37` |
| pinned `fastembed 3.0.0` | `packages/benchmarks/package.json:24` |
| `getEmbedder(): Promise<(text: string) => Promise<number[]>>` | `packages/benchmarks/src/embed.ts:26` |
| lazy-factory counterexample (builds before flags) | `cli.ts:962-985` (`supersession`, `longmemeval`) |

Note on the spec's row shape: the live catalog row is
`{ title: string; okf_type: string | null }` (`prompts.ts:76-77`). `buildShortlist`'s
row type per spec is `{ title: string; okf_type: string; body?: string }`; the
benchmark's pools always carry a string `okf_type` (from `TARGET_TYPES`), so the
narrower type holds for every 2a call site. Do not widen the catalog's own type.

---

## Task breakdown

### T1 — Core shortlist module (`spec §1`)

Files: create `packages/core/src/utils/shortlist.ts`;
create `packages/core/__tests__/shortlist.test.ts`.

Exports (exact signatures):

```ts
export type ShortlistFact = { title: string; body: string };
export type ShortlistRow = { title: string; okf_type: string; body?: string };

export function shortlistScore(factTitle: string, factBody: string, row: ShortlistRow): number;
export function buildShortlist(
  fact: ShortlistFact,
  rows: ReadonlyArray<ShortlistRow>,
  k: number,
  score?: (fact: ShortlistFact, row: ShortlistRow) => number,
): ShortlistRow[];
```

- `shortlistScore` = `jaccardScore` (`pure.ts:922`) between the fact token set
  (`titleTokens(factTitle)` ∪ `titleTokens(factBody)`; `titleTokens` already
  drops tokens < 3 chars and returns a Set, so the union is `new Set([...a, ...b])`)
  and the row token set (`titleTokens(row.title)` ∪ `titleTokens(row.body ?? '')`).
  Empty-vs-empty → 0 via `jaccardScore`'s 0/0 arm.
- `buildShortlist`: default score = `(f, r) => shortlistScore(f.title, f.body, r)`;
  dedupe by `normalizeTitleKey(row.title)` keeping the LAST row (catalog
  convention, `prompts.ts:82-90`); sort descending by score; ties break by
  `title` ascending in UTF-16 code-unit order (`<` comparison, same as
  `prompts.ts:91-94`); return first `k`. `k > rows.length` returns the whole
  deduped pool. Edge cases (documented on the export): rows with an empty
  `title` are skipped (the catalog skips empty title/type rows,
  `prompts.ts:87-88`); `k` must be a non-negative integer — `k <= 0` returns
  `[]`, a non-integer or NaN `k` throws. No imports beyond `./pure` and
  `./ontology`. No fastembed, no I/O.

Unit tests (`shortlist.test.ts`, offline, no fastembed import):
1. `shortlistScore` empty token sets both sides → 0.
2. Tokens shorter than 3 chars are dropped (e.g. a fact of only "ab cd" vs any
   row → 0).
3. Fact set = union of title and body tokens (score against a row sharing only
   body tokens > 0; sharing only title tokens > 0).
4. `buildShortlist` top-k order (higher score first).
5. Dedupe keeps the last row per `normalizeTitleKey` (two rows differing only
   in case/whitespace, e.g. `"  ACME   labs "` vs `"Acme Labs"` — the key does
   NOT fold punctuation; assert the survivor's `okf_type`).
6. Tie-break determinism: two distinct titles, equal scores → the UTF-16-earlier
   title ranks first, on both `[a, b]` and `[b, a]` input orders.
7. `k > pool size` returns the whole pool.
8. Injected `score` is used (stub scorer flips the ranking).

Acceptance: `pnpm --filter @equationalapplications/core-llm-wiki test` green;
`pnpm -r typecheck` green; `shortlist.ts` has zero imports outside
`../utils/{pure,ontology}`.

### T2 — Distractor generator + pools (`spec §2`, candidate pools)

Files: `packages/benchmarks/src/shortlistRecall.ts` (pools live in the runner
module, not cli.ts).

- Export a seeded `buildDistractorPools()` — pure as a FUNCTION (same seed ⇒
  byte-identical rows); the module does import `SEED_NODES` from
  `statementKinds/run.ts`, which transitively loads heavier modules at import
  time; that is acceptable and no ground truth is duplicated:
  - `seed` = the 3 `SEED_NODES` rows (`run.ts:42`) as `{ title, okf_type: type, body }`.
  - Distractor i (0-based): title `Distractor Node <i> <hashWordA> <hashWordB>`
    — two trailing words derived deterministically from a single fixed seed
    constant (a small FNV-1a over `"shortlist-recall-" + i` indexing two word
    lists defined in the module; same seed ⇒ same rows, byte-identical across
    runs). The word lists explicitly EXCLUDE tokens appearing in the three
    seed-node titles (so distractors don't drift toward the facts), and the
    result file records the seed constant plus a hash of both word lists as
    determinism fields. `okf_type` = `TARGET_TYPES[i % 3]`
    (`run.ts:32`). Body = one sentence containing both hash words.
  - `d50` = seed + first 47 distractors; `d200` = seed + first 197
    (distractor-200 exercises the live 200-entry cap —
    `TITLE_CATALOG_MAX_ENTRIES = 200`, `prompts.ts:75`; the spec's `:98` pin
    names the CHAR_BUDGET line — the constant lives at `:75`).
- Ground-truth containment guard: before scoring, assert every fixture
  `expected_target.title` is present in the pool under `normalizeTitleKey`;
  on a mismatch throw with the missing titles listed (fails loudly, spec step 4
  of the pool rules).

Unit tests (in `shortlistRecall.test.ts`, offline):
- Determinism: `buildDistractorPools()` called twice → deep-equal rows.
- Pool sizes 3 / 50 / 200; distractor titles are unique under
  `normalizeTitleKey`.
- Containment guard passes for the real committed fixture; a mutated fixture
  (rename one `expected_target.title` to something absent) makes the runner
  throw with the missing title in the message.

Acceptance: tests green; generator module imports nothing from `embed.ts`.

### T3 — Recall runner: scoring, recall@k, baselines, result file (`spec §2` steps 3–7)

Files: `packages/benchmarks/src/shortlistRecall.ts` (STAYS PURE — pools,
ground-truth guard, recall math, report object; no flag parsing, no file
writes, no cli.ts imports) + the exported CLI command in `cli.ts` (T4);
`packages/benchmarks/__tests__/shortlistRecall.test.ts`.

- Fact mapping: each fixture entry (`text`-only) →
  `fact = { title: '', body: entry.text }`. Both scorers see the SAME fact and
  the SAME row text: the embedding scorer embeds `entry.text` for the fact and
  `row.title + ' ' + (row.body ?? '')` per row — identical strings to what the
  lexical scorer tokenizes.
- **Embedding path is pre-embedded, then sync.** `buildShortlist`'s `score`
  parameter is sync, so the runner embeds FIRST: embed all 28 fact texts and
  every unique row text once, memoised by string (`d50` is a subset of
  `d200`, so at most ~228 embeds total — not ~7k single-text ONNX calls).
  Then the embedding ranking goes through the SAME `buildShortlist` with the
  sync closure `(f, r) => cosineSimilarity(vec(factText(f)), vec(rowText(r)))`
  (`cosine.ts:1`), so both scorers share dedupe and the UTF-16 tie-break.
  The lexical ranking uses the core default scorer, imported directly per the
  `calibrate.ts:23-27` pattern. The `embed` function comes from an injected
  async factory `embedFactory: () => Promise<(text: string) => Promise<number[]>>`
  (type of `embed.ts:26`); the runner calls the factory ONLY after the guard
  passes (T4 owns the guard).
- Recall math: expose `recallAtK(ranked, hitSet, k)` as a free function that
  accepts ANY k (so tests can exercise k = 4 and k > N directly). Hit =
  normalized `expected_target.title` equals a shortlisted title under
  `normalizeTitleKey` (case/whitespace folding only — no punctuation).
  Type equality is NOT part of the hit rule; record expected and actual
  types per entry.
- Reported k rows: the sweep is k ∈ {1, 3, 5, 10, 25}; one k row per k below
  the pool size — all five k on both distractor pools (all < 50), k = 1 only
  on the seed pool. (The spec's parenthetical "k = 5, 10, 25" conflicts with
  its own preamble; this reading keeps the full sweep and is recorded as a
  dated detail note in spec.md.)
- Random baseline per pool per k: `min(1, k / N)`, N = pool size.
- Result file: JSON written by the CLI command (not the pure module) to the
  path from `--out` (T5's real run passes
  `packages/benchmarks/results/shortlist-recall-<engineVersion>-<stamp>.json`
  explicitly — the default dir `results/raw/` is gitignored).
  Schema (determinism contract): `engineVersion` (via `engineInfo()`, as
  `cli.ts:654` does), `model` = `EMBED_MODEL` (`report.ts:37`),
  `fastembedVersion` = the pinned `3.0.0` from `packages/benchmarks/package.json`
  (both read at the CLI layer — the pure module cannot import fastembed),
  distractor seed constant + word-list hashes, pool sizes,
  `perPool: { <pool>: { size, perK: { <k>: { lexical, embedding, baseline } } } }`,
  `perEntry: [{ entryIndex, pool, expectedTitle, expectedType, hitByK, actualTypes }]`,
  and the caveat string (next bullet).
- Caveat text, printed in the summary and stored in the file: distractor rows
  are synthetic, so these numbers measure the rankers on synthetic pools of
  realistic size — they are not recall on real memories.
- Summary table printed to stdout: pool × k × scorer recall + baseline rows.
- Zero LLM calls; the runner never imports fastembed (only the factory type).

Runner unit tests (stub embed, offline — root `pnpm test` path):
- Hand-built 4-row pool with known hits: `recallAtK` exact at k = 1 and at
  k = pool size (k = 4 — tested directly on the free function, which accepts
  any k).
- Hit comparison goes through `normalizeTitleKey` (case/whitespace-variant
  ground truth still hits; punctuation variants legitimately MISS — assert
  that too, pinning the key's real behavior).
- Random baseline values + the `min(1, k/N)` clamp (k > N case, called
  directly on `recallAtK`/the baseline helper).
- Ground-truth validation failure path (shared with T2).
- Result-file schema: every determinism field present; per-entry records carry
  expected/actual types.
- Stub factory is NOT called when the runner is invoked in dry-run mode
  (dry-run short-circuits before scoring).

Acceptance:
`pnpm --filter @equationalapplications/benchmarks-llm-wiki test` green; core
suite green; `pnpm -r typecheck` green.

### T4 — CLI wiring: `shortlist-recall` dispatch branch + guards (`spec §2`, guard semantics)

Files: `packages/benchmarks/src/cli.ts` (an exported
`runShortlistRecallCommand(deps)` following the `StatementKindsDeps` pattern —
`cli.ts:587-667` — plus a dispatch branch in the hand-rolled chain at
`cli.ts:950-1014` and one help line in the help block at `cli.ts:1016+`);
`packages/benchmarks/__tests__/shortlistRecall.test.ts` (CLI tests).

- `runShortlistRecallCommand` deps: `{ argv, entries, embedFactory, engineVersion?, stdout?, stderr? }`
  (mirrors `runStatementKindsCommand`); flag parsing, guard, output-path
  resolution and the result-file write live HERE (cli.ts owns its private
  `nowStamp`/`defaultResultsDir`; `shortlistRecall.ts` stays pure — no import
  cycle).
- Dispatch branch mirrors the `statement-kinds` shape (`cli.ts:989-994`) but
  passes `embedFactory` (the lazy `() => getEmbedder()` thunk from
  `embed.ts:26`), NEVER an awaited embedder. Explicitly do NOT copy
  `supersession`/`longmemeval`, which `await getEmbedder()` before flag
  handling (`cli.ts:962-985`).
- Flag handling order inside the runner entry:
  1. Parse flags (`--yes`, `--dry-run`, `--out` via `resolveOutPath`).
  2. If `--yes` absent: print the estimate — pool sizes (3 / 50 / 200), entry
     count (28), scorer list (`lexical`, `embedding`), model download size
     (~150 MB) — then exit 0. Factory never called. (Exit 0 differs from the
     `statement-kinds` no-`--yes` exit 1 at `cli.ts:649-652` — the SPEC rules
     exit 0 here; leave a comment in the branch saying so so nobody "fixes"
     it back to match the siblings.)
  3. If `--dry-run`: print the same estimate, exit 0, factory never called.
  4. Else: call the factory (download happens here, first run only), run T3.
- Help line (descriptions start at column 34 in the existing rows, so
  `shortlist-recall [flags]` pads with 7 spaces):
  `  shortlist-recall [flags]       Measure shortlist recall@k over seed + synthetic distractor pools`

CLI tests (offline, stubbed factory passed via the exported
`runShortlistRecallCommand` deps — `main()` at `cli.ts:946` takes no deps and
is not exported, so tests target the command function, not `main`):
- The branch passes a lazy factory; asserting it is never INVOKED under
  `--dry-run` (spy factory).
- No `--yes` → estimate printed (assert pool sizes, 28, both scorers, download
  size appear on stdout), exit 0, factory spy uncalled.
- Help output lists `shortlist-recall`.
- `--out` routes through `resolveOutPath`.

Acceptance: benchmarks suite green; `grep -n "await getEmbedder" cli.ts` shows
no new pre-flag await in the 2a branch.

### T5 — Real run, determinism check, result file commit (`spec` test plan 4–5)

Files: `packages/benchmarks/results/shortlist-recall-<engineVersion>-<stamp>.json`
(one committed file), PR body numbers.

- Run `pnpm --filter @equationalapplications/benchmarks-llm-wiki bench shortlist-recall --yes
  --out packages/benchmarks/results/shortlist-recall-<engineVersion>-<stamp>.json`
  (local; first run downloads ~150 MB into the gitignored `.cache/`; zero LLM
  tokens; `--out` is REQUIRED for the committed file because the default
  results dir `results/raw/` is gitignored — same as the committed
  `statement-kinds-e1-title-catalog-2026-11-18.json`).
- Determinism check: run it a second time (default `results/raw/` destination
  is fine for this one); the two result files must carry
  identical recall values, baselines, and per-entry hit/miss (stamp/model
  fields may differ in stamp only). On disagreement: do NOT quote numbers;
  record the discrepancy in `LEDGER.md` AND in the PR body — the ledger is
  transient (deleted by the cleanup commit, `specs/README.md` lifecycle step 4),
  so the durable record of any discrepancy is the PR body.
- Commit ONE result file (the first run's); quote recall@k per pool per scorer
  and the random baselines in the PR body, with the synthetic-pool caveat
  verbatim. The numbers support no gate — say so in the PR body (INTENT Rule
  11 posture; the 2b scorer choice is made later by the owner from these
  numbers, not by this PR).
- No scorer recommendation, no k-default change, no generator extension in
  this PR (owner rulings 2026-11-21).

Acceptance: two result files exist locally with identical recall/baseline/
per-entry fields; one is committed; PR body quotes numbers + caveat; ledger
notes the run cost (tokens: 0; disk: model download).

### T6 — Spec-folder closeout (this PR's spec-side commits)

Files: `specs/shortlist-recall/plan.md`, `specs/shortlist-recall/LEDGER.md`,
`specs/shortlist-recall/spec.md` (Status line only).

- `LEDGER.md`: one checkbox per task above, evidence link per tick, "what's in
  flight" line. Transient per the house lifecycle (`specs/README.md` step 4):
  the cleanup commit deletes it with `plan.md`, so the DURABLE records — the
  review-ladder verdicts and costs, the real-run recall numbers, and any
  determinism discrepancy — live in the PR body (and, for anything that must
  outlive the PR, a dated note in `spec.md`, which is durable).
- The cleanup commit flips the spec Status `APPROVED` → `IMPLEMENTED`
  (INTENT rule 10) only after all tasks land green. No `docs/ROADMAP.md` edit
  (waits for the L2-0 roadmap amendment PR).

Acceptance: ledger boxes ticked only after verification, with evidence links;
durable copies of the ladder + run records sit in the PR body; Status flip is
in the same PR as the behavior (house rule).

---

## Execution order & review gates

T1 → T2 → T3 → T4 → T5 → T6, one commit per task, each ending green on
`pnpm -r typecheck` + both package suites. Review loop per INTENT step 2 runs
after implementation; this plan itself gets the T1.5 self-review + one paid T3
Opus review BEFORE implementation starts (plan-gate posture), with findings
folded here. The plan does not choose the 2b scorer or any k default —
everything it reports is measurement only.
