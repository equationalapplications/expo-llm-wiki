# Investigation: adopt glob 14.0.2 / minimatch 11.0.1 to clear GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249

**Date:** 2026-11-16
**Status:** Step 0 — investigation (pre-spec)
**Branch:** `specs/glob-minimatch-upgrade`
**Priority:** tier 3 (other security; moderate advisories, dev-only exposure)
**Issue:** equationalapplications/expo-llm-wiki#278

## Problem

`pnpm audit` on `main` (2026-11-16, post PR #400) emits two remaining
moderate advisories with upstream patches available:

| Advisory | Package | Vulnerable range | Patched | Locked | Published (patch) |
|---|---|---|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | glob | `>=9.0.0 <=14.0.1` | `>=14.0.2` | 11.1.0, 13.0.6 | 2026-10-27T22:07Z |
| GHSA-g3hv-75wg-m249 | minimatch | `>=7.0.0 <11.0.1` | `>=11.0.1` | 10.2.6 (also 5.1.9, NOT vulnerable) | 2026-10-27T22:26Z |

The 2026-11-09 ruling on this issue parked these items because **the only
patched versions are majors that sit outside every consumer's declared
range** (glob `^13.0.0` / `^11.0.1`, minimatch `^10.2.x`). Both patch
versions have now cleared the 14-day cooldown (cutoff
2026-11-02T14:05Z), so the owner directed a step-0 investigation on
adopting them.

The advisories:

- **glob GHSA-3g3m-2fjr-6pw4 (moderate):** AbortSignal cancellation bypass —
  after a timeout fires, glob can still read files (post-timeout file
  disclosure in tooling that globs untrusted trees).
- **minimatch GHSA-g3hv-75wg-m249 (moderate):** DoS via globparts
  amplification — certain patterns take exponential time to compile.

## Verified current state (repro)

- `pnpm audit --json` on main (2026-11-16): 9 advisories; the glob advisory
  reports two paths — `.>expo>@expo/cli>glob` (13.0.6) and
  `apps__scopelab>vite-plugin-pwa>workbox-build>glob` (11.1.0); the
  minimatch advisory reports `.>expo>@expo/cli>glob>minimatch` (10.2.6).
- No workspace `package.json` declares glob or minimatch directly — they are
  100% transitive.

## Consumer map (file:line = pnpm-lock.yaml @ main `27f8e5e9`)

| Locked version | Declared by (range) | Reach |
|---|---|---|
| glob@13.0.6 | @expo/cli@58.1.18, @expo/config@58.0.10, @expo/config-plugins@58.0.11, @expo/metro-config@58.0.20, @expo/fingerprint@0.21.8 (`^13.0.0`) | expo dev/CLI tooling |
| glob@11.1.0 | workbox-build@7.4.1 (`^11.0.1`) ← vite-plugin-pwa@2.0.0 ← apps/scopelab | scopelab PWA service-worker build |
| minimatch@10.2.6 | eslint@10.13.0 (`^10.2.5`, apps/wiki-demo), @typescript-eslint/typescript-estree@8.72.0 (`^10.2.2`), @expo/fingerprint (`^10.2.2`), glob@11/13 (their own deps) | lint + expo tooling |
| minimatch@5.1.9 | legacy consumer (L12775) — `>=7.0.0` range excludes it | not vulnerable, untouched |

**Everything is dev/build-time tooling. Nothing ships to runtime.** The CI
surfaces that exercise these packages: scopelab build (vite → vite-plugin-pwa
→ workbox), wiki-demo eslint, packages/expo tests (expo config tooling),
docs build, repo-wide typecheck.

## What the majors change (verified from upstream changelogs @ v14.0.2 / v11.0.1 tags)

- **glob 14:** matching switches from RegExp to `Matcher` objects
  (patterns can no longer cause ReDoS — this is the paired minimatch fix);
  `Pattern#pattern()` type changes; `isRegExp()→isMatcher()`;
  `Processor#testRegExp()→testMatcher()`; `debug` option removed;
  `GlobWalker#walk()/walkSync()` return arrays instead of sets;
  `MatchRecord#entries()` removed; `ignore` patterns anchored at `/` now
  resolve against `root`/cwd root (semantic change); on abort the walk
  STOPS (the security fix).
- **minimatch 11:** `makeRe()`, `Minimatch#regexp`, `AST` class,
  `maxExtglobRecursion` option REMOVED; `matchOne()`, `slashSplit()`,
  `levelTwoFileOptimize()` made internal; `Minimatch.set` items are now
  strings/`Matcher`/`GLOBSTAR`; edge-case matching is closer to Bash;
  several 10.2.3+ matching bugs fixed; exponential `partial` compile fixed
  (the DoS fix).

API-risk reading: any consumer calling `minimatch.makeRe()` or glob's
removed members would break. The consumers here use high-level glob/ignore
APIs (config arrays, PWA globbing, expo config globs) — but this cannot be
proven statically, which is why the empirical probe matrix below exists.

## Isolation experiment (performed 2026-11-16, this branch)

Overrides added to `pnpm-workspace.yaml`:

```yaml
'glob@>=9.0.0 <14.0.2': 14.0.2
'minimatch@>=7.0.0 <11.0.1': 11.0.1
```

Results:

- `pnpm install` EXIT=0 under the active `minimumReleaseAge: 20160` gate.
  Resolution: glob → 14.0.2 (single copy; 11.1.0 and 13.0.6 both gone),
  minimatch → 11.0.1 (+ untouched 5.1.9). New transitives all
  gate-clean: path-scurry@3.0.0 (2026-10-27T21:14Z),
  @isaacs/nonrecursive-glob-match@1.0.3 (2026-10-28T19:50Z),
  minipass@7.1.3 (2026-02-19). glob@14.0.2 requires minimatch `^11.0.0` —
  consistent with the global pin.
- **pnpm audit: 9 → 7 advisories.** Both targeted GHSAs stop emitting.
  Remaining: deepmerge (no fix exists upstream), node-forge ×4 (1.4.3 gate
  clears 2026-11-18T01:06Z), astro ×2 (7.4.7 gate clears 2026-11-19T19:59Z)
  — all tracked in #278.
- Probe matrix (every consumer surface, all EXIT=0):
  - `pnpm --filter scopelab test` (51 tests) — PASS
  - `pnpm --filter scopelab build` — vite build → vite-plugin-pwa →
    workbox-build generated `dist/sw.js` (8 precache entries): glob 11→14
    through workbox works end-to-end
  - `pnpm --filter @equationalapplications/expo-llm-wiki test` (12 tests,
    exercises @expo/config tooling): PASS
  - `pnpm exec eslint .` in apps/wiki-demo (eslint 10 + typescript-estree,
    minimatch 10→11): clean, no config-resolution errors
  - `pnpm --filter docs build` (53 pages): PASS
  - `pnpm typecheck` repo-wide: PASS

## Proposed fix direction

Keep the two override lines (with a corrected comment), let CI run the full
suite, and remove the two GHSA ids from... nothing — they were never
allowlisted (moderate, fix-available advisories are handled by the fix, not
the allowlist). The override-forced major is outside the declared consumer
ranges; this is the SAME pattern the repo already uses for
`@ungap/structured-clone` and `brace-expansion`, and it stays until the
consumers' own ranges mature past 14.0.x / 11.x (Dependabot cannot get
there — it only bumps direct deps — so these overrides are the permanent
mechanism unless the range-selector entries are revisited when @expo/*,
workbox, or eslint publish new ranges).

Rejected alternatives:

1. **Wait for upstream consumers to bump their ranges** (@expo → glob ^14,
   workbox → glob ^14, eslint chain → minimatch ^11). No announced
   timelines; the two moderates would sit for an unknown number of weeks.
   The empirical probe matrix shows the majors work in this repo's actual
   surfaces today, so waiting buys nothing but exposure time.
2. **Pin only glob, leave minimatch** — glob 14 depends on minimatch
   `^11.0.0`, so the minimatch override is required anyway for a single
   consistent copy; and the minimatch advisory has its own independent
   consumers (eslint, typescript-estree, fingerprint).

## Open questions

1. Do we hold the PR until 2026-11-18/11-19 and land it together with the
   node-forge 1.4.3 bump + astro merges (one bigger cooldown pass 2 PR), or
   open it immediately (its versions are already gate-clear)? Both are
   gate-legal; the cron job `7e3f2bdc1576` currently expects to handle the
   other items — coordination needed so the two lanes don't collide.
2. `minimatch@5.1.9` (legacy consumer, not in the vulnerable range): leave
   untouched (recommended) or force to 11 for single-copy hygiene? Forcing
   would jump it 5→11 (larger API risk for its consumer) for zero security
   gain.
3. Should the `cooldown-blocked`-adjacent reporting in #278 be updated to
   note that glob/minimatch moved from "leave open" to "adopted via forced
   major" (superseding the 2026-11-09 ruling)? Owner confirmation requested.
