# GoatCounter analytics tag — implementation plan

Spec: `specs/goatcounter-analytics-tag/spec.md` (rev 7, Reviewed — approved by Kurt 2026-11-06).
Branch: `spec/goatcounter-analytics-tag` (this PR carries spec + plan + implementation; draft until implemented).

## Preconditions

- Branch synced against `origin/main` before Task 1 (`git fetch && git merge origin/main` — merge commit fine, no force-push).
- Working tree clean except this plan/LEDGER addition.
- Evidence on hand: live count.js sha256 `030ad75a7c80a04107a9b91f79e4b1572da0a583a80a9b67e111b310da11cbe9` (== upstream v2.7.0 `public/count.js`, diff-empty, verified 2026-11-06).

## Tasks (ordered; one logical change per commit)

### Task 1 — Vendor the tracking script
- Copy the live stats-host script verbatim to `apps/docs/public/count.js`.
- Verify BEFORE committing: `sha256sum apps/docs/public/count.js` equals the recorded hash; `diff` against the tag-cloned upstream v2.7.0 `public/count.js` is empty (from the 2026-11-06 clone under /tmp — re-fetch only if /tmp copy is gone).
- Commit: `chore(docs): vendor GoatCounter count.js (spec: Proposed change)` — NON-releasable type: this repo's semantic-release has no scope filter, `feat:`/`fix:` anywhere cuts an unintended npm release (implementation-review BLOCKER, adjudicated by commit reword).
- Tests: sha256 + diff checks above (read real output, paste into LEDGER evidence).

### Task 2 — Head entries in astro.config.mjs
- Append the two entries to the starlight `head` array after the Bing meta, in order: inline `window.goatcounter` config script (`content`, NOT `children`), then the count.js tag (`attrs.async: true`, `src: '/expo-llm-wiki/count.js'`, `data-goatcounter: 'https://stats.equationalapplications.com/count'`).
- Commit: `chore(docs): add GoatCounter head tag with host-prefix path callback (spec: Proposed change)` — non-releasable type (same constraint).
- Tests: `pnpm --filter docs build` exits 0; on built dist — `data-goatcounter` present on every generated page EXCEPT `dist/googleff7d7181e1455d40.html`; ordering assertion `html.index('location.host') < html.index('count.js')` holds per file (same exclusion); no file outside `apps/docs/` touched (`git status`).

### Task 3 — CI strip-guard + sha256 step in test.yml
- One step after the existing `pnpm --filter docs build` (test.yml ~L121) running a single script that: (a) `sha256sum -c` the vendored file against the recorded hash (offline, committed file), (b) presence check — every `dist/**/*.html` except the token file contains `data-goatcounter`, (c) ordering check — inline `location.host` index < `count.js` index per file, same exclusion. Keep it small (bash/node inline, `python3` is already used in this workflow).
- Commit: `ci(docs): guard GoatCounter tag against silent strip + pin vendored script hash (spec: Test plan)`.
- Tests: run the step's script locally against the built dist; verify it FAILS when the inline script is removed from a copy of dist (negative check, then restore).

### Task 4 — Pre-merge mechanism check (verification only, no commit)
- Serve built site under base (`astro preview` from apps/docs), load the home page WITHOUT a query string in a browser, verify `window.goatcounter.get_data().p === location.host + location.pathname`; expect NO `/count` request (localhost filter). Read real browser output.

### Task 5 — Internal review ladder on the full implementation diff
- Sequence with Tier-2 suspended: SoR (T1) → Haiku 5.5 effort ladder (T1.5) → Opus delta (T3, `--effort low` per suspension substitution rules only for fix-verify; the code review rung itself is a standard Opus pass at medium). Fix findings with new commits; loop until clean.
- Independent reviewer subagent over the branch diff (diff-vs-spec, re-run test script, `git status --short`, adjudicate deviations) before any ready flip.

### Task 6 — Same-PR cleanup + ready flip
- Final commit: flip spec status → `Implemented`, delete `specs/goatcounter-analytics-tag/plan.md` + `LEDGER.md`, update PR body (problem/evidence/fix summary/real test output/spec ref), `gh pr ready`.
- Then: bot gauntlet (CodeRabbit/aws-cloud-agent — evaluate, fix valid findings) + CI green. STOP for Kurt's merge go (attended run).

### Task 7 — Post-merge (on Kurt's go, after merge)
- Spec's Post-merge checks section: deployed `/count` beacon check + dashboard filter check within 24 h of deploy, blocker-free profile, revert-first on failure. Owned by Tessera.

## Risks / notes

- `data-goatcounter` must stay on the stats host (Host-header site resolution) — only `src` moves same-origin. A drift here silently counts into a wrong/missing site.
- The token-file exclusion is load-bearing: the assertion must exclude `googleff7d7181e1455d40.html` or CI goes red on an intentional absence.
- Line-ending normalization of `public/count.js` would break the sha check — if a tool rewrites it, re-copy verbatim and re-record the hash in the SAME commit (CI enforces same-PR updates by design).
- Do not enable `allow_local`; the pre-merge probe is `get_data()` client-side, no network expected.
