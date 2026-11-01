# LEDGER — mcp-server spec cycle (PR #305)

## Plan tasks

- [x] Task 1: Package skeleton, build, and first test — commit `238238c`; vitest green, tsup build DTS ok
- [x] Task 2: Contract table from the vendored OpenAPI subset with D3 guards — commit `65185a3`; guard tests green
- [x] Task 3: Error types and tool-error text mapping — commit `7725e34`; mapping tests green
- [x] Task 4: Contract-driven HTTP client — commit `7d951c2`; retry/idempotency/timeout tests green
- [x] Task 5: Credentials and configuration files — commit `3dcac90`; atomic-write and precedence tests green
- [x] Task 6: The eight memory tools with the request-fidelity guard — commit `645dbf4`; conformance tests green
- [x] Task 7: MCP server registering the eight tools — commit `96c2d02`; in-memory transport tests green
- [x] Task 8: auth.md registration state machine — commit `6c434f3`; scripted-flow tests green
- [x] Task 9: CLI with serve, auth, status, config; stdio smoke test — commit `fe6a781`; stdio test green
- [x] Task 10: README, gated live test, release wiring — commit `66cb196`; **wiring portion superseded**: the three repo edits were reverted in `207c298` by owner ruling (deferred to a follow-up PR after spec §0 gates close)

## Review evidence

- SoR full coverage (176/176 clusters) + Tier-1.5 ladder (haiku low/medium/high/xhigh, sonnet-5.5 high) — findings fixed across commits `8e31500..63c7284`, `94cd21d`, `ca3390d`, `2dbdc6b`..`5101a50`; verdict JSONs archived in the session workspace (CI-external), summaries in the PR description's review-convergence section
- CodeRabbit rounds 1–3 — all actionable comments fixed (`2af930f`, `efeafe0`, `2068ba3`)
- CI green 5/5 (test, rust-test, Analyze, CodeQL, CodeRabbit) on `2068ba3` and later
- Tier-4 Fable review (35 turns, $4.40) — REQUEST CHANGES; blockers/major resolved in the post-review commits (audit reconciliation with #307, spec status/move, poll-interval clamp, key-source precedence warn, grant shape check, INTENT amendment entry)

## What's in flight

PR #305 ready for merge after CI on the post-Fable commit; follow-ups: release-wiring PR (after §0 gates), contract regeneration after SynapseTree #139, issue #142 whoami change, body-parser age-gate waiver pending Kurt's written approval, `mcp-server` bin-alias ruling before first publish.
