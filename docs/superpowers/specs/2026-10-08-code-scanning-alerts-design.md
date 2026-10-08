# Spec: Close the Open CodeQL Code-Scanning Alerts

**Date:** 2026-10-08
**Status:** Draft

---

## Problem

The CodeQL workflow (`.github/workflows/codeql.yml`, `security-extended` suite, `javascript-typescript`) has 22 open alerts. They fall into five groups:

| # | Group | Rule(s) | Alerts | Severity | Ships to users? |
|---|---|---|---|---|---|
| A | ReDoS in OKF parsers | `js/redos`, `js/polynomial-redos` | #1–#10 | high | **Yes**: `core-okf`, `core-llm-wiki` |
| B | Incomplete placeholder strip | `js/incomplete-multi-character-sanitization` | #11 | high | **Yes**: `core-llm-wiki` |
| C | Check-then-write race | `js/file-system-race` | #13–#17 | high | No (private packages) |
| D | Insecure temp file | `js/insecure-temporary-file` | #12 | high | No |
| E | Network data written to disk | `js/http-to-file-access` | #18–#22 | medium | No |

Groups A and B are in published library code. The OKF parsers read Markdown that comes from ingest and import, so a crafted `index.md`, `log.md`, related section or frontmatter scalar can pin the CPU of the MCP server or any host process. Groups C–E are in `@equationalapplications/benchmarks-llm-wiki` and `@equationalapplications/integration-llm-wiki`. Both are `private: true` and run only on developer machines.

### Alert inventory

| Alert | File:line | Pattern / call |
|---|---|---|
| #9 | `packages/okf/src/entity-index-md.ts:7` | `INDEX_ENTRY`: `(?:\\.\|[^\]])*` overlaps on `\`, so it backtracks exponentially |
| #4 | `packages/okf/src/entity-index-md.ts:73` | `INDEX_ENTRY`: `\s+-\s+(.*)$` overlaps, so it is polynomial |
| #2, #3 | `packages/okf/src/entity-index-md.ts:43,65` | `SECTION_HEADING`: `^##\s+(.+)\s*$` |
| #10 | `packages/okf/src/related-section.ts:52` | `linkPattern` (global, unanchored), same escape overlap as #9 |
| #7 | `packages/okf/src/frontmatter.ts:236` | number scalar: `\d+\.?\d*` is ambiguous |
| #5 | `packages/okf/src/log-md.ts:35` | `EVENT_ID_COMMENT`: unanchored `\s*<!--…-->\s*$` |
| #6 | `packages/okf/src/log-md.ts:62` | `BULLET`: `^-\s+(.*)$` |
| #8 | `packages/core/src/utils/parseOkfBundle.ts:167` | `LOG_LINE_PATTERN`: escape overlap |
| #1 | `packages/core/src/utils/parseOkfBundle.ts:174` | `LOG_LINE_PATTERN`: `\s*(?:…\|(.+))$` |
| #11 | `packages/core/src/services/PromptService.ts:70` | single-pass `replace` of `{{ontologyManifest}}` / `{{ontologyModeInstructions}}` |
| #13 | `packages/benchmarks/src/longmemeval/dataset.ts:83` | cache `writeFileSync` after an existence check |
| #14, #15, #17 | `packages/integration/scripts/fetch-scifact.ts:63,84,102` | `existsSync` then `writeFileSync` |
| #16 | `packages/integration/scripts/fetch-financebench.ts:114` | same |
| #12 | `packages/benchmarks/src/cli.ts:727` | `compare --out` `writeFileSync`; the taint sources are `tmpdir()` paths in `__tests__/cli.test.ts` |
| #18–#22 | dataset.ts:83, cli.ts:412, fetch-scifact.ts:63,102, fetch-financebench.ts:121 | fetched data reaches `writeFileSync` |

## Goals

1. Close every listed alert by changing code, not by dismissing it. The one exception is the fallback in §E, which applies only if hardening does not satisfy the query.
2. Keep the **round-trip contract**: everything `buildIndexMd`, `buildLogMd`, `appendRelatedSection`, `formatOkfBundle` and the frontmatter serializer emit parses back to the same values.
3. Every rewritten regex runs in time linear in its input. Tests check this with adversarial inputs.

## Non-goals

- Keeping exact accept/reject behavior on inputs no builder emits. **Decision (brainstorm Q2):** malformed or hand-edited edge cases may parse differently, for example an unescaped `[` inside a link label, or a `##` heading with only whitespace after it. A security fix is expected to change behavior on pathological input.
- Adding a lint rule for regex complexity. The CodeQL PR check already guards new code.
- Excluding paths from CodeQL with `paths-ignore`. **Decision (brainstorm Q1):** fix everything and don't use dismissals.

## Design

The approach is a hybrid (brainstorm Q3). Simple patterns get linear regex rewrites. Small hand-rolled helpers are used only where a regex would be hard to read. Each rewritten site gets a one-line comment naming the alert it closes, for example `// linear: closes CodeQL #9`.

### Escaping fact the design relies on

All four label/summary escapers (`index-md.ts` `renderEntry.esc`, `related-section.ts` `escapeLinkLabel`, `formatOkfBundle.ts` log summaries, `frontmatter.ts`) escape `\` → `\\`, `[` → `\[`, `]` → `\]`, and fold `\r?\n` into a space. An emitted label therefore never contains a bare `\`, `[` or `]`. That is what lets the escape group drop the overlap.

### A. ReDoS rewrites

**A1. Escaped-label group** (#8, #9, #10). Replace `(?:\\.|[^\]])*` with

```
(?:\\.|[^\[\]\\])*
```

The two alternatives no longer overlap: `\` can only start `\\.`. `[` is excluded too, so the **unanchored global** `linkPattern` in `related-section.ts` stops each attempt at the next `[`, and a run of `[[[[…` costs linear time in total rather than quadratic. Apply it in:

- `entity-index-md.ts` `INDEX_ENTRY`
- `related-section.ts` `linkPattern`
- `parseOkfBundle.ts` `LOG_LINE_PATTERN`

Tightening: a hand-written label with an unescaped `[`, or a trailing lone `\`, no longer matches as a link. The index entry is skipped. The log line falls back to the plain-summary branch, as it already does for any non-link text.

**A2. `INDEX_ENTRY` description tail** (#4). Replace `(?:\s+-\s+(.*))?$` with `(?:\s+-(\s.*)?)?$` and set `description = m[3]?.trimStart() || undefined`. The `\s+` / `-` / `\s` pieces are disjoint. This accepts and captures the same entries as today, including `* [a](p) -   ` (description `undefined`).

Full pattern:

```
/^\*\s+\[((?:\\.|[^\[\]\\])*)\]\(([^)]+)\)(?:\s+-(\s.*)?)?$/
```

**A3. Heading and bullet shapes** (#2, #3, #6). Make the capture start on a non-space so it cannot trade characters with the preceding `\s+`:

- `SECTION_HEADING`: `/^##\s+(\S.*)$/`. It captures what `(.+)` captured today, trailing whitespace included. The only change is that `##` followed by nothing but whitespace no longer counts as a heading.
- `log-md.ts` `BULLET`: `/^-\s+(\S.*)?$/`, text `= m[1] ?? ''`. This matches the same lines and captures the same text.
- Apply the same `BULLET` form to the `^-\s+(.*)$` bullet in `related-section.ts:49` for consistency, though it is not flagged.
- `TOP_LEVEL_H1` (`^#\s+.+\s*$`) is only ever tested against `.trim()`ed lines. Change it to `/^#\s+\S/` for consistency. It is not flagged.

**A4. `EVENT_ID_COMMENT`** (#5). Replace the unanchored regex with a hand-rolled helper:

1. `t = text.trimEnd()`. If `t` does not end with `-->`, return `{ text }`.
2. `open = t.lastIndexOf('<!--')`. If it is `-1`, return `{ text }`.
3. `inner = t.slice(open + 4, -3).trim()`. It must start with `id:`. `eventId = inner.slice(3).trim()`, which must be non-empty and contain no whitespace. Otherwise return `{ text }`.
4. `stripped = t.slice(0, open).trimEnd()`. Then apply the existing `/^[A-Za-z0-9._-]+$/` id check without changing it.

`lastIndexOf` gives the same result as today's leftmost-matching regex: an earlier `<!--` cannot match, because `\S+` cannot span the whitespace before the next `<!--`.

**A5. Frontmatter number scalar** (#7). Replace `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` with

```
/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
```

`\d+(?:\.\d*)?` describes the same language as `\d+\.?\d*` but has only one way to match a run of digits. Accept/reject behavior is **identical**, so no tightening. This is simpler than the char-scanner floated during the brainstorm, so the scanner is dropped.

**A6. `LOG_LINE_PATTERN`** (#1). The input is already `text.trim()`ed. Make the plain-summary branch start on a non-space so it cannot trade with `\s*`:

```
/^\(([^)]+)\)\s*(?:\[((?:\\.|[^\[\]\\])*)\]\(([^)]+)\)|(\S.*))$/
```

`(type)` with nothing after it still fails to match, as it does today.

### B. PromptService placeholder strip (#11)

When there is no `ontologyContext`, `buildSystemPrompt` strips ontology placeholders from the **hydrated** output in a single `replace` pass. That has two problems:

1. A nested form (`{{{{ontologyManifest}}ontologyManifest}}`) leaves a live placeholder behind. That is the alert.
2. It also strips placeholder-looking text out of **variable values** substituted during hydration, such as document content. That is a correctness bug: user content gets changed.

Fix: strip from the **template**, before hydration, in a loop that runs until nothing changes (it terminates, because each pass shortens the string). Extract a `stripOntologyPlaceholders(template)` helper. Concretely, when `ontologyContext == null && hasOntologyPlaceholders(template)`, hydrate `stripOntologyPlaceholders(template)` and drop the post-hydration `replace`. `shouldHydrate` and `appendOntology` behave as before.

### C + D. Benchmark and fixture file writes (#12–#17)

Add `writeFileAtomic(path, data)` in each private package, at `packages/benchmarks/src/fsSafe.ts` and `packages/integration/scripts/fsSafe.ts`. Each is about 15 lines, and duplicating it is cheaper than a shared package:

1. `mkdirSync(dirname(path), { recursive: true })`
2. Write to `${path}.${process.pid}.${randomUUID()}.tmp` with `{ flag: 'wx', mode: 0o600 }`. The `wx` flag refuses an existing file or symlink. `0o600` satisfies `js/insecure-temporary-file`.
3. `renameSync(tmp, path)`, which is atomic on the same filesystem. On error, `rmSync(tmp, { force: true })` and rethrow.

Use it at every alerted write: `cli.ts` (sample `--out`, `compare --out`, and the report/result writes that share `ensureDir` + `writeFileSync`), `longmemeval/dataset.ts`, `fetch-scifact.ts` ×3, `fetch-financebench.ts` ×3.

**Removing the check in check-then-write** (#13–#17). The scripts use `existsSync(p)` to mean "already fetched, skip". Replace it with a helper that does not split the check from the use:

- Where the cached content is needed (`qrels` in scifact, the longmemeval cache), use `readCached(p)`: `try { return readFileSync(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }`.
- Where only presence matters (scifact corpus and queries), use the same `readCached` and ignore the content. The files are fixture-sized, so the extra read is acceptable.

The atomic rename means a crash during a fetch no longer leaves a truncated file for the next run to "skip". That was an actual reliability bug.

### E. Network data written to disk (#18–#22)

These scripts exist to write fetched data to disk. Hardening:

1. **Never write raw response text.** Parse it, validate it against the expected row shape with a small hand-written type guard per dataset (`LmeQuestion`, scifact corpus/qrels/query rows, financebench rows), and write `JSON.stringify` of the **validated fields only**. `dataset.ts` currently writes `text` verbatim. It changes to writing the re-serialized validated array.
2. **HTTPS only.** Fetch helpers reject non-`https:` URLs. That includes `BENCH_LONGMEMEVAL_URL` and `deps.url` overrides.
3. **Fixed destinations.** Output paths come from constants (`FIXTURES`, `REPO_ROOT`, cache dir) or the user's own `--out` flag, never from response data. This is already true and gets a test.

**Fallback.** CodeQL's `js/http-to-file-access` may not model hand-written type guards as sanitizers, so these alerts could survive the hardening. If they do, dismiss each surviving alert as *won't fix* with the reason "dev-only private fixture fetcher; response validated and re-serialized, HTTPS-only, fixed destination: see docs/superpowers/specs/2026-10-08-code-scanning-alerts-design.md §E". This is the only dismissal the spec allows, and it requires the hardening to have landed first.

## Testing

**Round-trip** (okf and core): for each builder, build output from fixtures that contain `\`, `[`, `]`, `<!-- id: … -->`, descriptions, numbers in every accepted form (`1`, `-1.`, `.5`, `+2e10`), and multi-line text, then assert that parsing reproduces the input. Extend the existing tests in `packages/okf/__tests__/{entity-index-md,log-md,related-section,frontmatter}.test.ts` and `packages/core/__tests__/parseOkfBundle.test.ts`.

**Adversarial, bounded time:** one test per alert, using the attack string CodeQL reports (for example `'* [' + '\\\\'.repeat(50_000)`, `'## ' + ' '.repeat(100_000) + '\r'`, `'9'.repeat(100_000) + 'x'`, `'<!--id:'.repeat(20_000)`, `'['.repeat(100_000)`) at n = 50k–100k. Assert each parse finishes in under **500 ms** (`performance.now()`). The vulnerable patterns take seconds to forever at these sizes, and linear ones take single-digit milliseconds, so the margin absorbs CI noise.

**Tightening pinned:** add explicit tests for the accepted behavior changes in Non-goals: an unescaped-`[` label is skipped, and a whitespace-only `##` is not a heading.

**PromptService:** (a) a nested placeholder in an override template leaves no `{{ontology…}}` in the output; (b) a variable value containing the literal `{{ontologyManifest}}` survives hydration unchanged; (c) existing ontology-context cases still pass.

**File writes:** `writeFileAtomic` refuses to follow a pre-planted symlink at the tmp path, leaves no `.tmp` behind on success or on a thrown write, and an interrupted write (simulated with a mocked `renameSync` that throws) does not leave a file at the destination. Type guards reject malformed rows, and the fetch helper rejects `http:` URLs.

**Acceptance:** the PR's CodeQL run reports alerts #1–#17 as fixed, and #18–#22 as fixed or dismissed per the §E fallback. `npm test` passes across the workspace.

## Rollout

Separate commits for spec and code. Code commits are grouped A, B, C+D, E, so each group can be reviewed on its own. Use `fix(okf)`, `fix(core)` and `fix(benchmarks)` / `fix(integration)` conventional types. The okf and core changes are user-visible patch fixes, so semantic-release cuts a patch. No footer marks a breaking change. The tightening only affects input that no builder emits.

## Risks

| Risk | Mitigation |
|---|---|
| A hand-edited OKF file with an unescaped `[` in a label loses that index entry or related link on import | Accepted (Non-goals). The builders always escape, and the behavior change is pinned by a test |
| CodeQL still flags a rewritten pattern it does not consider linear | The PR's CodeQL run is the acceptance gate. Iterate on the pattern rather than dismiss |
| Timing tests are flaky on slow CI | 500 ms bound against single-digit-ms expected cost, roughly 100× margin |
| §E fallback seen as a loophole | Limited to `js/http-to-file-access` in private packages, applied only after hardening lands, with the reason recorded per alert |
