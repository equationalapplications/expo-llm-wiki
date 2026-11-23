# Recognize llama.rn "Context is full" as context overflow

**Status:** Implemented (2026-11-23, PR #467)
**Date:** 2026-11-23
**Branch:** `spec/context-is-full-overflow`
**Issue:** #437
**Intent check:** Checked against `INTENT.md`. This spec widens one error-classification regex so an existing, already-specified recovery path (split, then skip with cooldown and a `context_overflow_skipped` diagnostic) fires for one more provider. It adds no spend, changes no defaults, and touches no stored data. No INTENT amendment is needed.

**Delivery:** one PR, draft until implemented, per `specs/README.md`. Commit type `fix(core):`, so semantic-release cuts a patch. Nobody edits `CHANGELOG.md` or any `"version"` field, and no `BREAKING CHANGE` footer.

---

## 1. Problem

Since 9.3.0, `BoundedLlmCall.runBatched` handles input-context overflow: it splits the batch, then skips the item with a cooldown and emits a `context_overflow_skipped` diagnostic. A consumer on llama.rn never reaches that path. llama.rn's overflow error is not classified as overflow, so heal follows the pre-9.3.0 behavior: it rethrows at batch size above 1 and records a `call_error` skip at size 1. The host sees a failed maintenance run where it should see a clean skip.

Reported in issue #437, found in a consumer review (curated-journal PR #131, engine 9.2.0 to 9.5.3).

## 2. Root cause

llama.rn 0.12.9 throws when the prompt fills the context and `ctx_shift` is off (the default):

- `cpp/jsi/RNLlamaJSI.cpp:1114`: `throw std::runtime_error("Context is full");`, verified by grep in an installed copy (curated-journal `node_modules/llama.rn`, version 0.12.9).
- Per the issue, the check sits at `RNLlamaJSI.cpp:1112-1114` (prompt at least `n_ctx`), the default at `common.h:571`, and the JS side surfaces it as `new Error("Context is full")` (`JSIUtils.cpp:107`).

The exact message is `Context is full`.

`isContextOverflowError` (`packages/core/src/services/BoundedLlmCall.ts:91-98`) tests the message against `CONTEXT_OVERFLOW_PATTERNS` (`BoundedLlmCall.ts:68-84`). None of the nine patterns matches "Context is full": they need "maximum context length", "context length exceeded", "prompt is too long", "input token count", "exceeds the context", "context limit", and so on. It also matches no truncation pattern. The classifier is called from `BoundedLlmCall.ts:315,332,344` (`runBatched`), `librarian/ops/resolve.ts:203`, and `MaintenanceService.ts:1917,2515,2769`, so all of them miss.

## 3. Change

Add one pattern to `CONTEXT_OVERFLOW_PATTERNS`, with a comment naming the provider:

```ts
// llama.rn (RNLlamaJSI.cpp): prompt >= n_ctx with ctx_shift off
/\bcontext is full\b/i,
```

Nothing else changes. The ordering rules (rate-limit guard first, overflow before truncation and config) are untouched.

### False-positive check

The pattern is word-bounded (`/\bcontext is full\b/i`), so it requires the literal words "context is full" and does not match "context is fully cached" or "Context is fully loaded". Checked against the existing `NOT_OVERFLOW` corpus (5xx, auth, truncated output, `max_tokens` config, validation wording, JSON parse error, three 429 bodies): none contains "context is full". `RATE_LIMIT_PATTERN` runs first and still wins for any 429 body. Wording that could match elsewhere ("disk is full", "queue is full", "buffer is full") lacks "context". A wiki write path that logs "context is full" for a non-LLM reason does not go through this classifier; it reads only errors thrown by the host's LLM callback. A false positive would cost one wasted batch split plus a cooldown, which is the same price the other patterns accept.

## 4. Files touched

- `packages/core/src/services/BoundedLlmCall.ts`: add the pattern.
- `packages/core/__tests__/services/context-overflow.test.ts`: add llama.rn's exact message to `OVERFLOW_MESSAGES`, plus negative cases.
- `apps/docs/src/content/docs/guides/diagnostics.md` (line 55, `context_overflow_skipped` row): no change needed, since it describes the behavior and lists no provider messages. A grep of `apps/docs` for "maximum context length" finds no page that lists recognized messages. If implementation finds one, update it in the same PR.

## 5. Test plan

- Add `"Context is full"` (llama.rn 0.12.9, `RNLlamaJSI.cpp:1114`) to `OVERFLOW_MESSAGES`. The existing tests then assert that it classifies as overflow and is neither truncation- nor config-error-shaped.
- Add case-variant and wrapped forms (`new Error('Context is full')` and a message with a prefix such as `llama.rn: Context is full`) as overflow.
- Add to `NOT_OVERFLOW`: `Disk is full` and `Request queue is full, retry later`.
- Optionally one `runBatched` test: a callback throwing `Error('Context is full')` at batch size above 1 splits instead of rethrowing.

Verification: build, typecheck, `pnpm test`.

## 6. Semver

`fix(core):` means a patch release. No public API, type, or default changes.
