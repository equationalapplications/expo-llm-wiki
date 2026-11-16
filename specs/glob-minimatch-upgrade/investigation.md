# Investigation: adopt glob 14.0.2 / minimatch 11.0.1 to clear GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249

**Date:** 2026-11-16 (rev 5 — Tier-4 Fable REQUEST CHANGES folded: the
"workbox duplicate-entry drift" was NOT glob-14 drift; confounder found and
proven by decisive experiment. Adoption shows ZERO observable drift.)
**Status:** Step 0 — investigation, converged pending owner ruling (see
Precondition). The branch must NOT merge as the fix until `spec.md`,
`plan.md` and `LEDGER.md` exist in this folder (first post-ruling task) and
the #278 ruling is recorded — the branch already carries live override +
lockfile changes.
**Branch:** `specs/glob-minimatch-upgrade`
**Priority:** tier 3 (other security; moderate advisories, dev-only exposure)
**Issue:** equationalapplications/expo-llm-wiki#278

## Problem

`pnpm audit` on `main` (`27f8e5e9`, 2026-11-16, post PR #400) emits two
remaining moderate advisories with upstream patches available:

| Advisory | Package | Vulnerable range | Patched | Locked | Patch published |
|---|---|---|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | glob | `>=9.0.0 <=14.0.1` | `>=14.0.2` | 11.1.0, 13.0.6 | 2026-10-27T22:07Z |
| GHSA-g3hv-75wg-m249 | minimatch | `>=7.0.0 <11.0.1` | `>=11.0.1` | 10.2.6 (5.1.9 also locked — NOT vulnerable) | 2026-10-27T22:26Z |

Both patch versions have cleared the 14-day cooldown (cutoff
2026-11-02T14:05Z). The owner directed this step-0 investigation on
2026-11-16 ("do step 0 of delivery flow for the remaining open issues
which are past the 14 day dependency age gate for upstream poison").

- **glob GHSA-3g3m-2fjr-6pw4 (moderate):** AbortSignal cancellation bypass —
  after a timeout fires, glob can still read files.
- **minimatch GHSA-g3hv-75wg-m249 (moderate):** DoS via globparts
  amplification (exponential pattern compile).

Registry facts in this doc were captured 2026-11-16 from full npm packuments
(`curl -s https://registry.npmjs.org/<pkg>`, reading the `time` field) and
the GitHub advisory API; re-check with `pnpm view <pkg>@<ver> time` or
`npm view <pkg> time --json`.

## Verified current state (repro)

- `pnpm audit --json` on main: glob advisory with two paths
  (`.>expo>@expo/cli>glob` → 13.0.6; `apps__scopelab>vite-plugin-pwa>workbox-build>glob`
  → 11.1.0); minimatch advisory via `.>expo>@expo/cli>glob>minimatch` →
  10.2.6 (shared by other consumers).
- No workspace `package.json` declares glob or minimatch directly — 100%
  transitive.

## Consumer map (line numbers = pnpm-lock.yaml @ main `27f8e5e9`)

| Locked version | Declared by (range) | Reach |
|---|---|---|
| glob@13.0.6 (L4959) | @expo/cli@58.1.18, @expo/config@58.0.10, @expo/config-plugins@58.0.11, @expo/metro-config@58.0.20, @expo/fingerprint@0.21.8 (`^13.0.0`) | expo dev/CLI tooling |
| glob@11.1.0 (L4953) | workbox-build@7.4.1 (`^11.0.1`) ← vite-plugin-pwa@2.0.0 ← apps/scopelab | scopelab PWA service-worker build |
| minimatch@10.2.6 (L5964) | eslint@10.13.0 (`^10.2.5`, apps/wiki-demo), @typescript-eslint/typescript-estree@8.72.0 (`^10.2.2`), @expo/fingerprint (`^10.2.2`), glob@11/13 own deps | lint + expo tooling |
| minimatch@5.1.9 (L5968) | filelist@1.0.6 (L4755; consumer ref L12775) — outside the vulnerable range | not vulnerable, untouched |

**Everything is dev/build-time tooling. Nothing ships to runtime.**

Gate-coverage honesty (verified by grep, not assumed): the @expo/\* glob
consumers are NOT exercised by any repo gate — there is no expo app in the
repo (no `app.json` anywhere), and `packages/expo`'s only test
(`adapter.test.ts`) imports neither `@expo/config` nor `@expo/fingerprint`.
Those packages ride devDependencies for typegen. Their glob behavior runs
in developer CLI workflows outside CI, and is unprobed here (disclosed as
an acceptance item in Open question 2).

## What the majors change (verified from upstream changelogs @ v14.0.2 / v11.0.1 tags)

- **glob 14:** matching switches from RegExp to `Matcher` objects
  (patterns can no longer cause ReDoS); `Pattern#pattern()` type changes;
  `isRegExp()→isMatcher()`; `Processor#testRegExp()→testMatcher()`;
  `debug` option removed; `GlobWalker#walk()/walkSync()` return arrays
  instead of sets; `MatchRecord#entries()` removed; `ignore` patterns
  anchored at `/` now resolve against `root`/cwd root (semantic change);
  on abort the walk STOPS (the security fix).
- **minimatch 11:** `makeRe()`, `Minimatch#regexp`, `AST` class,
  `maxExtglobRecursion` option REMOVED; `matchOne()`, `slashSplit()`,
  `levelTwoFileOptimize()` made internal; `Minimatch.set` items are now
  strings/`Matcher`/`GLOBSTAR`; edge-case matching closer to Bash;
  exponential `partial` compile fixed (the DoS fix).

## Isolation experiment (this branch, commits `8355cb1f`+)

Overrides added to `pnpm-workspace.yaml`:

```yaml
'glob@>=9.0.0 <14.0.2': 14.0.2
'minimatch@>=7.0.0 <11.0.1': 11.0.1
```

Resolution: glob → 14.0.2 single copy (11.1.0 and 13.0.6 both gone),
minimatch → 11.0.1 (+ untouched 5.1.9 via filelist). New transitives all
gate-clean: path-scurry@3.0.0 (2026-10-27T21:14Z),
@isaacs/nonrecursive-glob-match@1.0.3 (2026-10-28T19:50Z), minipass@7.1.3
(2026-02-19) — timestamps from the npm registry `time` field, captured
2026-11-16. glob@14.0.2 requires minimatch `^11.0.0` — consistent with the
global pin. `pnpm install` EXIT=0 under the active gate. The branch lockfile
diff is confined to this subgraph (glob/minimatch/path-scurry/
nonrecursive-glob-match + glob 11's dropped deps jackspeak/@isaacs/cliui/
package-json-from-dist); tinyglobby/fdir/picomatch (the OTHER globbers in
this build, see below) are version-identical on both sides.

### Differential probes — final, decisive run set (2026-11-16)

An earlier rev of this doc reported a scopelab PWA manifest difference
(7 entries on main vs 8 on branch) as "concrete evidence that glob-14
semantics are observably different". **That was wrong: the A/B was
confounded by untracked build state.** The decisive re-run:

1. **Reproducibility:** fresh builds on main (`27f8e5e9` worktree,
   glob 11) produce **7 entries 3/3 runs**; branch (glob 14) produced
   **8 entries 3/3 builds** — but the branch runs inherited an untracked
   leftover `apps/scopelab/public/sql-wasm.wasm` from prior builds (the
   `sql-wasmPlugin` in `apps/scopelab/vite.config.ts:11-19` copies it into
   `public/` at every `buildStart` and never removes it; it is not
   git-tracked).
2. **Confounder isolated by instrumentation** (temporary debug logging in
   `node_modules/vite-plugin-pwa/dist/index.js` on both sides, both trees):
   in a REAL build, vite-plugin-pwa resolves its options and runs its
   includeAssets glob — via **tinyglobby**, not the `glob` package, so
   unaffected by the override — BEFORE the plugin's `buildStart` copies
   `sql-wasm.wasm` into `public/`. Fresh-state builds therefore see only
   `favicon.svg` in the includeAssets half (both sides logged
   `assets after filter= ["favicon.svg"]`); builds with the leftover see
   `["favicon.svg","sql-wasm.wasm"]`.
3. **Decisive planted-leftover A/B:** with
   `apps/scopelab/public/sql-wasm.wasm` pre-existing, **main (glob 11)
   produces the IDENTICAL 8-entry manifest as the branch (glob 14)** —
   same count, same size (1270.92 KiB), same duplicated `sql-wasm.wasm`
   (same url, same revision `a152cddb…`). The glob version is not the
   variable; the leftover is.
4. **Mechanism (verified from source):** scopelab's
   `includeAssets: ['favicon.svg', 'sql-wasm.wasm']`
   (`apps/scopelab/vite.config.ts:30`) double-lists a file the default
   workbox `globPatterns: ['**/*.{js,wasm,css,html}']` already covers;
   `workbox-build`'s `additionalManifestEntriesTransform`
   (`build/lib/additional-manifest-entries-transform.js:16-32`) pushes the
   includeAssets entries onto the globbed manifest with NO dedupe. The
   runtime is unaffected: workbox-precaching's `precache()` "adds items to
   the precache list, removing any duplicates"
   (`node_modules/workbox-precaching/build/workbox-precaching.dev.js`,
   L492/L510).
5. **Conclusion: glob 14/minimatch 11 produce ZERO observable manifest or
   build drift in this repo.** The duplicate only manifests when the
   untracked `public/sql-wasm.wasm` leftover exists — CI fresh checkouts
   never have it, so CI manifests are always the 7-entry form. Exit codes
   alone would still have been insufficient evidence: the 7-vs-8 split was
   REAL and reproducible per-side; only the instrumented mechanism trace
   plus the planted-leftover experiment identified its true cause.
6. **Other probes (branch):** `pnpm exec eslint .` in apps/wiki-demo
   (eslint 10 + typescript-estree, minimatch 10→11) — clean;
   `pnpm --filter @equationalapplications/expo-llm-wiki test` (12 tests)
   PASS (repo-gate evidence only — see gate-coverage honesty);
   `pnpm --filter docs build` (53 pages) PASS; `pnpm typecheck` repo-wide
   PASS; full root `pnpm test` EXIT=0 — core 2566/2566, okf 194/194,
   mcp-server 135/135, scopelab 51/51, react 76/76, benchmarks 154/154,
   schema-software-org 46/46, integration 47/47
   (`/tmp/globmin-branch-fulltest.log`, 2026-11-16).

Side-finding (pre-existing quirk, NOT caused by this change, reported for
the owner): the scopelab `includeAssets` double-listing produces a
runtime-deduped duplicate precache entry on any machine where
`public/sql-wasm.wasm` lingers from a previous build. Cheap remedy if
wanted (separate decision): drop `'sql-wasm.wasm'` from `includeAssets` —
the default glob pattern already covers it.

## Proposed fix direction

Keep the two override lines. The final override comment must state (per the
file's convention): advisory ids; patched versions 14.0.2 / 11.0.1
published 2026-10-27T22:07Z / 22:26Z; gate cleared 2026-11-10T22:07Z /
22:26Z; reach (@expo/\* dev tooling, workbox-build via vite-plugin-pwa in
apps/scopelab, eslint chain in apps/wiki-demo — all dev/build-time); that
this override forces a MAJOR outside every range declared in today's
resolved graph; and the drop condition:

> **Drop condition:** remove each line when no package in the resolved
> graph (`pnpm why glob` / `pnpm why minimatch`) declares a range that
> excludes 14.0.2 / 11.0.1. NOTE: the workspace importers themselves never
> declare glob or minimatch — the range holders to watch are the
> transitive parents: @expo/\* (glob `^13.0.0`), workbox-build (glob
> `^11.0.1`), eslint + @typescript-eslint/typescript-estree +
> @expo/fingerprint (minimatch `^10.2.x`). `pnpm why` lists the parents
> but shows only resolved versions — check each parent's DECLARED range
> with `pnpm view <parent>@<locked> dependencies.glob` (or
> `dependencies.minimatch`). Re-check in every cooldown sweep (the standing
> cadence that already re-derives the audit surface).

No allowlist change: neither GHSA was allowlisted.

Dependabot cannot get here: it can bump transitive lockfile entries only
within the parents' declared ranges, and no parent declares an in-range
fix — so overrides are the only adoption mechanism while the ranges stand.

## Precondition (owner ruling required)

**This change overturns the 2026-11-09 ruling on issue #278** ("glob /
minimatch — leave open, fixes are majors crossing declared ranges"). It is
also the FIRST override in this repo whose target lands outside the major
its consumers declare in today's resolved graph (all existing overrides
resolve in-major: fast-uri floors, node-forge floors, undici in-range
minors, hono exact in-range pins — while `image-size@<2.0.3 → ^2.0.3`,
`deepmerge-ts@<8.0.0 → 8.0.0` and `tar@<7.5.21 → ^7.5.21` are cross-major
by range text but in-major against every range declared today). It
therefore needs an explicit owner yes/no before the PR opens — this
document is the decision material. The concrete #278 change if approved:
the glob/minimatch item flips from "leave open" to "adopted via forced
major (glob 14.0.2 / minimatch 11.0.1, overrides in pnpm-workspace.yaml
with drop condition)"; the PR #400 status comment's "Still open" list
loses the glob/minimatch line. Post-ruling task order: (1) create
`spec.md`/`plan.md`/`LEDGER.md` in this folder, (2) finalize the override
comment, (3) open the PR.

## Rejected alternatives

1. **Wait for upstream consumers to bump their ranges** (@expo → glob ^14,
   workbox → glob ^14, eslint chain → minimatch ^11). workbox-build 7.4.1
   is the latest upstream release (published 2026-05-04T20:21Z — npm
   registry `time` field). No announced timelines for any of the three.
   The probes show the majors work in every gate-covered surface today
   with zero observable drift, so waiting buys nothing but exposure time.
2. **Pin glob only, skip minimatch** — glob 14 needs minimatch `^11.0.0`
  internally, but eslint, typescript-estree and @expo/fingerprint declare
  `^10.2.x` and would keep the vulnerable 10.2.6 resolved for their own
  subtrees; the minimatch override exists for THEM.
3. **Force minimatch@5.1.9 (filelist's copy) to 11 for single-copy
   hygiene** — zero security gain (5.1.9 is outside the vulnerable range),
   5→11 API jump for filelist's consumer. Leave untouched.

## Open questions

1. Sequencing with the armed pass-2 cron (job `7e3f2bdc1576` in the Hermes
   cron store, `~/.hermes/cron/jobs.json`; recorded in the vault session
   record records/sessions/2026-11-16-expo-llm-wiki-cooldown-sweep-pr400.md):
   land this PR immediately (its versions are already gate-clear) or fold
   it into the pass-2 PR on 2026-11-20? Default: fold into pass 2 — one
   cooldown PR, no lane collision with the cron's brief.
2. Accept the UNPROBED @expo/fingerprint + @expo/config exposure to glob
   14's anchored-`ignore` semantics change? No probe target exists in-repo
   (no expo app); those surfaces run only in developer CLI workflows. With
   the scopelab manifest difference now attributed to config state (not
   glob), this is the ONLY residual adoption cost, and it is a
   risk-of-the-unknown rather than an observed change. Recommended:
   accept, noted in the override comment.
3. Follow-up (separate from this lane): the scopelab `includeAssets`
   double-listing of `sql-wasm.wasm` (duplicate precache entry on machines
   with the untracked public-dir leftover; runtime-deduped). Remedy: drop
   `'sql-wasm.wasm'` from `includeAssets`. Owner's call, not in scope here.

## Revision history

- **rev 1 (2026-11-16):** initial investigation + isolation experiment.
  Opus r1 (effort medium, $0.27, 12 turns): REQUEST CHANGES — 3 MAJOR
  (precedent claim false: every existing override resolves in-major, so
  this is a new override class requiring an owner ruling and superseding
  the 2026-11-09 park [M1]; exit-code-only probes cannot catch the doc's
  own flagged semantic changes — differential probes demanded [M2]; no
  drop condition [M3]) + 7 minor. All premises verified TRUE by the
  controller (structured-clone/brace-expansion overrides are in-major
  against today's graph; no expo app exists; adapter.test.ts imports
  neither @expo/config nor fingerprint; filelist@1.0.6 is the 5.1.9
  consumer).
- **rev 2 (2026-11-16):** differential probes run with fresh builds; the
  scopelab manifest showed 7-vs-8 entries and was (wrongly, see rev 5)
  attributed to glob 14 semantics. Opus r2 delta (effort low, $0.32,
  1 turn): REQUEST CHANGES — drop condition trivially satisfiable as
  written ("no lockfile importer"; importers are workspace packages);
  Status line lacked merge caveat; duplicate cause asserted not shown.
- **rev 3 (2026-11-16):** r2 folded: drop condition reworded to
  resolved-graph test (`pnpm why`) with the transitive range-holders
  named; Status line carries the merge caveat; attribution downgraded to
  "attributed — only variable in the A/B"; unprobed expo surface posed as
  acceptance item.
- **rev 4 (2026-11-16):** Opus r3 delta (effort low, $0.29, 1 turn):
  APPROVE WITH NITS — facts re-checked; `pnpm view` clause folded. Opus
  ladder converged.
- **rev 5 (2026-11-16):** Tier-4 Fable (effort high, $4.36, 85 turns):
  REQUEST CHANGES — MAJOR: the 7-vs-8 manifest difference is explained by
  scopelab's `includeAssets` double-listing (`sql-wasm.wasm` matched by
  both the includeAssets half and the default workbox `**/*.wasm` pattern,
  pushed undeduped by `additionalManifestEntriesTransform`), NOT by glob
  14; the fresh-state main result was the anomaly to explain; MINORs:
  in-major claim scoped to the resolved graph, registry facts must carry
  capture method, cron id citation, post-ruling task order. Controller
  adjudication: Fable's mechanism verified from source (vite-plugin-pwa
  uses tinyglobby for includeAssets — unaffected by the override;
  additionalManifestEntriesTransform pushes without dedupe) AND the
  claimed confounder proven by the decisive planted-leftover experiment
  (main glob 11 with leftover = identical 8-entry duplicate; fresh-state =
  7 on both sides; instrumented builds show tinyglobby runs before the
  public-dir copy). Fable's "7 is the anomaly" framing resolved: the
  anomaly was untracked build state, not glob behavior. All findings
  folded. Net effect on the decision: adoption shows ZERO observable
  drift; the residual cost is only Open question 2's unprobed @expo/\*
  exposure.
