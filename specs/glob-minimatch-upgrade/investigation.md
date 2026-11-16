# Investigation: adopt glob 14.0.2 / minimatch 11.0.1 to clear GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249

**Date:** 2026-11-16 (rev 4 — Opus ladder CONVERGED: r3 APPROVE WITH NITS, nit folded)
**Status:** Step 0 — investigation, converged pending owner ruling (see
Precondition). The branch must NOT merge as the fix until `spec.md`,
`plan.md` and `LEDGER.md` exist in this folder and the #278 ruling is
recorded — the branch already carries live override + lockfile changes.
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
in developer CLI workflows outside CI.

## What the majors change (verified from upstream changelogs @ v14.0.2 / v11.0.1 tags)

- **glob 14:** matching switches from RegExp to `Matcher` objects
  (patterns can no longer cause ReDoS); `Pattern#pattern()` type changes;
  `isRegExp()→isMatcher()`; `Processor#testRegExp()→testMatcher()`;
  `debug` option removed; `GlobWalker#walk()/walkSync()` return arrays
  instead of sets; `MatchRecord#entries()` removed; **`ignore` patterns
  anchored at `/` now resolve against `root`/cwd root (semantic change)**;
  on abort the walk STOPS (the security fix).
- **minimatch 11:** `makeRe()`, `Minimatch#regexp`, `AST` class,
  `maxExtglobRecursion` option REMOVED; `matchOne()`, `slashSplit()`,
  `levelTwoFileOptimize()` made internal; `Minimatch.set` items are now
  strings/`Matcher`/`GLOBSTAR`; edge-case matching closer to Bash;
  exponential `partial` compile fixed (the DoS fix).

## Isolation experiment (this branch, commit `8355cb1f`)

Overrides added to `pnpm-workspace.yaml`:

```yaml
'glob@>=9.0.0 <14.0.2': 14.0.2
'minimatch@>=7.0.0 <11.0.1': 11.0.1
```

Resolution: glob → 14.0.2 single copy (11.1.0 and 13.0.6 both gone),
minimatch → 11.0.1 (+ untouched 5.1.9 via filelist). New transitives all
gate-clean: path-scurry@3.0.0 (2026-10-27T21:14Z),
@isaacs/nonrecursive-glob-match@1.0.3 (2026-10-28T19:50Z), minipass@7.1.3
(2026-02-19). glob@14.0.2 requires minimatch `^11.0.0` — consistent with
the global pin. `pnpm install` EXIT=0 under the active gate.

### Differential probes (main `27f8e5e9` vs branch, equalized fresh builds)

Run BOTH sides in throwaway state — baseline worktree at `27f8e5e9` with
fresh `pnpm install` + fresh `packages/*` builds, branch likewise — because
stale dists masquerade as behavior differences (first attempt showed
7-vs-8-entry noise that vanished once both sides were rebuilt fresh).

1. **scopelab PWA build (workbox glob):** both sides succeed; **BUT the
   generated `sw.js` manifests differ.** Main: 7 entries. Branch: 8 entries
   — `sql-wasm.wasm` appears TWICE (same url, same revision
   `a152cddb…`), and vite-plugin-pwa's log line correspondingly reports
   "precache 8 entries (1270.92 KiB)" vs main's "7 entries
   (1270.92 KiB)". The set of unique urls is IDENTICAL (7 urls both sides;
   entry-by-entry JSON diff clean apart from the duplicate). Verified from
   workbox-precaching's shipped source
   (`node_modules/workbox-precaching/build/workbox-precaching.dev.js`,
   `precache()`/"addToCacheList" docs, L492/L510): the runtime
   "adds items to the precache list, **removing any duplicates**" — so the
   runtime precache is functionally identical. The duplicate is ATTRIBUTED
   to the glob 11→14 delta — the only variable in this A/B (identical vite
   config, identical dist inputs, fresh builds on both sides); the precise
   glob pattern responsible is NOT identified, and whether the
   anchored-`ignore` semantic change also affects @expo/fingerprint or
   @expo/config globbing has no evidence either way (no probe target
   exists in-repo) — see Open question 2. workbox-build 7.4.1 is the
   LATEST upstream release (published 2026-05-04, declares glob
   `^11.0.1`) — there is no newer workbox that fixes or absorbs this.
   The drift is bounded (same url + same revision, runtime-deduped) and is
   the concrete evidence that glob-14 semantics ARE observably different
   in this repo's real build surfaces — exit codes alone would have hidden
   it.
2. **eslint 10 + typescript-estree (minimatch 10→11):** `pnpm exec eslint .`
   in apps/wiki-demo — clean on the branch (no config-resolution errors,
   no lint failures). No differential output to compare (eslint is quiet
   when clean on both sides).
3. **expo package tests** (`pnpm --filter @equationalapplications/expo-llm-wiki test`,
   12 tests): PASS on branch. **These do NOT exercise @expo/config or
   fingerprint** (see gate-coverage honesty above) — they are recorded as
   repo-gate evidence only, not as @expo/\* surface coverage.
4. **`pnpm --filter docs build`** (53 pages): PASS on branch.
5. **`pnpm typecheck`** repo-wide: PASS on branch.
6. **Full root `pnpm test`** on the branch: EXIT=0 — core 2566/2566,
   okf 194/194, mcp-server 135/135, scopelab 51/51, react 76/76,
   benchmarks 154/154, schema-software-org 46/46, integration 47/47, all
   other suites green (log `/tmp/globmin-branch-fulltest.log`,
   2026-11-16).

## Proposed fix direction

Keep the two override lines. The final override comment must state (per the
file's convention): advisory ids; patched versions 14.0.2 / 11.0.1
published 2026-10-27T22:07Z / 22:26Z; gate cleared 2026-11-10T22:07Z /
22:26Z; reach
(@expo/\* dev tooling, workbox-build via vite-plugin-pwa in apps/scopelab,
eslint chain in apps/wiki-demo — all dev/build-time); that this override
forces a MAJOR outside every consumer's declared range; the known-benign
workbox duplicate-entry drift; and the drop condition:

> **Drop condition:** remove each line when no package in the resolved
> graph (`pnpm why glob` / `pnpm why minimatch`) declares a range that
> excludes 14.0.2 / 11.0.1. NOTE: the workspace importers themselves never
> declare glob or minimatch — the range holders to watch are the
> transitive parents: @expo/\* (glob `^13.0.0`), workbox-build (glob
> `^11.0.1`), eslint + @typescript-eslint/typescript-estree +
> @expo/fingerprint (minimatch `^10.2.x`). `pnpm why` lists the parents
> but shows only resolved versions — check each parent's DECLARED range
> with `pnpm view <parent>@<locked> dependencies.glob` (or
> `dependencies.minimatch`). Re-check in every cooldown
> sweep (the standing cadence that already re-derives the audit surface).

No allowlist change: neither GHSA was allowlisted.

Dependabot cannot get here: it can bump transitive lockfile entries only
within the parents' declared ranges, and no parent declares an in-range
fix — so overrides are the only adoption mechanism while the ranges stand.

## Precondition (owner ruling required)

**This change overturns the 2026-11-09 ruling on issue #278** ("glob /
minimatch — leave open, fixes are majors crossing declared ranges"). It is
also the FIRST override in this repo that forces a version outside the
major its consumers declare (all existing overrides stay in-major:
fast-uri floors, node-forge floors, undici in-range minors, hono exact
in-range pins). It therefore needs an explicit owner yes/no before the PR
opens — the step-0 product below is the decision material. The concrete
#278 change if approved: the glob/minimatch item flips from "leave open"
to "adopted via forced major (glob 14.0.2 / minimatch 11.0.1, overrides in
pnpm-workspace.yaml with drop condition)"; the PR #400 status comment's
"Still open" list loses the glob/minimatch line.

## Rejected alternatives

1. **Wait for upstream consumers to bump their ranges** (@expo → glob ^14,
   workbox → glob ^14, eslint chain → minimatch ^11). workbox-build 7.4.1
   is the latest upstream release (2026-05-04); no announced timelines for
   any of the three. The differential probes show the majors work in every
   gate-covered surface today, with one bounded, runtime-deduped drift.
2. **Pin glob only, skip minimatch** — glob 14 needs minimatch `^11.0.0`
  internally, but eslint, typescript-estree and @expo/fingerprint declare
  `^10.2.x` and would keep the vulnerable 10.2.6 resolved for their own
  subtrees; the minimatch override exists for THEM.
3. **Force minimatch@5.1.9 (filelist's copy) to 11 for single-copy
   hygiene** — zero security gain (5.1.9 is outside the vulnerable range),
   5→11 API jump for filelist's consumer. Leave untouched.

## Open questions

1. Sequencing with the armed pass-2 cron (`7e3f2bdc1576`, 2026-11-20): land
   this PR immediately (its versions are already gate-clear) or fold it
   into the pass-2 PR on 2026-11-20? Default: fold into pass 2 — one
   cooldown PR, no lane collision with the cron's brief (which would need
   this branch's existence added to its context if landed separately).
2. Accept the two disclosed costs of adoption? (a) the workbox
   duplicate-entry drift (runtime-deduped, same revision) and (b) the
   UNPROBED @expo/fingerprint + @expo/config exposure to glob 14's
   anchored-`ignore` semantics change — no probe target exists in-repo
   (no expo app), those surfaces run only in developer CLI workflows, and
   the changed semantics are exactly the class of drift the workbox probe
   caught. Recommended: accept both, with both documented in the override
   comment.

## Revision history

- **rev 1 (2026-11-16):** initial investigation + isolation experiment.
  Opus r1 (effort medium, $0.27, 12 turns): REQUEST CHANGES — 3 MAJOR
  (precedent claim false: every existing override stays in-major, so this
  is a new override class requiring an owner ruling and superseding the
  2026-11-09 park [M1]; exit-code-only probes cannot catch the doc's own
  flagged semantic changes — differential main-vs-branch probes demanded
  [M2]; no drop condition for the overrides [M3]) + 7 minor. All premises
  verified TRUE by the controller (structured-clone/brace-expansion
  overrides are in-major; no expo app exists; adapter.test.ts imports
  neither @expo/config nor fingerprint; filelist@1.0.6 is the 5.1.9
  consumer).
- **rev 2 (2026-11-16):** all findings folded: precedent claim deleted,
  owner-ruling precondition added; differential probes run with equalized
  fresh builds — the workbox duplicate-entry drift found, characterized
  (same url/revision, runtime-deduped per workbox-precaching source), and
  disclosed; gate-coverage honesty added for the @expo/\* surfaces; drop
  condition written; m1–m5, m7 folded (line numbers corrected to main
  `27f8e5e9`, consumer named as filelist@1.0.6, Dependabot statement made
  precise, rejected-alternative 2 re-led, #278 checklist change made
  concrete). Opus r2 delta (effort low, $0.32, 1 turn): REQUEST CHANGES —
  NEW-M1: the drop condition as written ("no lockfile importer") was
  already satisfiable today because pnpm importers = workspace packages
  and none declare glob/minimatch — a literal read would delete both
  overrides at the first sweep; NEW-m-A: Status line still lacked the
  merge caveat; NEW-m-B: duplicate cause asserted not shown, unprobed expo
  surface disclosed but not posed as an acceptance risk.
- **rev 3 (2026-11-16):** r2 folded: drop condition reworded to
  resolved-graph test (`pnpm why`) with the transitive range-holders
  named; Status line carries the merge caveat; drift attribution downgraded
  to "attributed — only variable in the A/B, precise pattern unidentified";
  the unprobed @expo/fingerprint + @expo/config anchored-ignore exposure is
  now an explicit acceptance item in Open question 2.
- **rev 4 (2026-11-16):** Opus r3 delta (effort low, $0.29, 1 turn):
  **APPROVE WITH NITS** — all r2 findings verified fixed, facts re-checked
  against pnpm-workspace.yaml (in-major examples, gate dates, allowlist).
  One nit folded: `pnpm why` shows only resolved versions, so the drop
  condition now also specifies `pnpm view <parent>@<locked>
  dependencies.glob|minimatch` for the declared-range check. **Opus ladder
  converged.**
- **rev 5 (pending):** Tier-4 Fable review of this converged doc (final
  step-0 tier).
