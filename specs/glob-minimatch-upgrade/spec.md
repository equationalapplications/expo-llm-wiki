# Spec: force glob 14.0.2 / minimatch 11.0.1 past declared ranges (cooldown sweep pass 2)

**Date:** 2026-11-16
**Status:** Implemented (2026-11-16, this PR)
**Branch:** `specs/glob-minimatch-upgrade`
**Priority:** tier 3 (other security; moderate advisories, dev-only exposure)
**Issue:** equationalapplications/expo-llm-wiki#278

## Problem

`pnpm audit` emits two moderate advisories with upstream patches:

- GHSA-3g3m-2fjr-6pw4 (glob): AbortSignal bypass. glob can read files after a timeout fires.
- GHSA-g3hv-75wg-m249 (minimatch): DoS. Some patterns take exponential time to compile.

The patched versions are glob 14.0.2 and minimatch 11.0.1. They are majors.
Every consumer declares an older major. Dependabot cannot bump them: it only
bumps within declared ranges. The 14-day cooldown cleared on 2026-11-10.
The owner approved forced-major adoption on 2026-11-16. This overturns the
2026-11-09 "leave open" ruling on the same items.

## Evidence

See `investigation.md` in this folder. It carries the full review ladder
record: Opus r1-r3 plus Tier-4 Fable r1-r2. Both ladders approved with nits.
All nits are folded. Key evidence:

- Overrides resolve glob 14.0.2 (single copy) and minimatch 11.0.1.
- `pnpm install` passes the active 14-day gate. New transitives are all older than the gate cutoff.
- The full test suite passes: core 2566/2566, integration 47/47, all packages green.
- eslint 10 runs clean on minimatch 11. The scopelab PWA build runs clean on glob 14.
- A suspected glob-14 manifest drift was traced to a scopelab config double-listing plus a gitignored build leftover. It is pre-existing, unrelated to glob 14, and never ships (see investigation.md, "Differential probes").

## Proposed change

`pnpm-workspace.yaml` gains two range overrides:

```yaml
'glob@>=9.0.0 <14.0.2': 14.0.2
'minimatch@>=7.0.0 <11.0.1': 11.0.1
```

`pnpm-lock.yaml` regenerates from that change. No other file changes.

The override comment must state: advisory ids, patch publish dates, gate
clear dates, reach, the forced-major fact, the accepted residual risk, and
the drop condition. The drop condition: remove each line when no package in
the resolved graph declares a range that excludes 14.0.2 / 11.0.1. Re-check
in every cooldown sweep.

## Files touched

- `pnpm-workspace.yaml` — two override lines plus comment.
- `pnpm-lock.yaml` — regenerated.
- `specs/glob-minimatch-upgrade/` — this spec, the investigation doc, plan, ledger.

## Accepted risk (owner-approved 2026-11-16)

The @expo/fingerprint and @expo/config surfaces use glob in developer CLI
workflows. No probe target exists in this repo. Their behavior under glob
14's changed ignore semantics is unverified. The owner accepts this
risk-of-the-unknown. Failure mode: a visible developer-workflow hiccup, not
a shipped bug — these packages never ship to runtime.

## Test plan

- `pnpm install --frozen-lockfile` must be a no-op on the committed lockfile.
- `pnpm audit` must not emit GHSA-3g3m-2fjr-6pw4 or GHSA-g3hv-75wg-m249.
- Root `pnpm test` must pass (core 2566/2566 baseline; recorded run EXIT=0).
- `pnpm typecheck` must pass.
- `pnpm --filter docs build` must pass.
- `pnpm --filter scopelab build` must pass.
- CI (CodeQL, Analyze, rust, test) must go green on the PR.

## Rejected alternatives

- Wait for consumers to bump ranges: no timelines; workbox-build 7.4.1 is the latest upstream release. Waiting buys exposure, not safety.
- Pin glob only: eslint, typescript-estree, and @expo/fingerprint declare minimatch `^10.2.x` and would keep the vulnerable 10.2.6.
- Force minimatch 5.1.9 (filelist's copy) to 11: zero security gain; 5-to-11 API jump for filelist.
