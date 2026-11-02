# Ledger: forget-pre-v9

In flight: whole-PR review (Sonnet 5.5, high), then cleanup commit.

- [x] T1 v8 fixture helper — fixture test green (`forgetPreV9.test.ts` "fixture: …")
- [x] T2 failing tests — RED on baseline: 5 failed / 2 passed (B, C, 4 → `no such table: llm_wiki_source_ref_index`; A → old message; 5b → `Transaction failed`); commit "test(core): pre-v9 forget…"
- [x] T3 forget() guard — 6/7 green, only the message test red
- [x] T4 v9 message — `forgetPreV9` + `migration9` 13/13 green; `migration9.test.ts` unmodified
- [x] T5 docs — `pnpm --dir apps/docs build` OK (51 pages)
- [x] T6 full verification — `pnpm install` (no lockfile diff), `pnpm typecheck` 0, `pnpm build` 0, `pnpm test` 0 (core 189 files / 2062 tests)
- [ ] T7 PR + review + cleanup

## Log

- 2026-11-01 plan review (Fable) adopted: test 4 uses a genuinely never-set-up instance instead of re-dropping the table; legacy `docs/superpowers/specs/2026-08-07-…:174` left untouched (shipped record); guard placed right after sourceHash validation; no `!` assertion.
- 2026-11-01 first `pnpm test` failed only on mcp-server `stdio.test.ts` ("build first … dist/cli.js missing"): pre-existing build-order requirement (CI runs `pnpm run build` before `pnpm test`). Green after `pnpm build`.
