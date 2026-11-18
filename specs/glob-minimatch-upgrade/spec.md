# Spec: force glob 14.0.2 / minimatch 11.0.1 past declared ranges (cooldown sweep pass 2)

**Date:** 2026-11-16
**Status:** Implemented (2026-11-16, this PR)
**Branch:** `specs/glob-minimatch-upgrade`
**Priority:** tier 3 (other security; moderate advisories, dev-only exposure)
**Issue:** equationalapplications/expo-llm-wiki#278
**Intent check:** INTENT rule **8** (small, first-party, auditable
dependency surface) does **not** apply — glob/minimatch are dev-time
tooling in the build graph, not runtime dependencies of any published
package, and this change adds no runtime dependency. The alignment rests
on INTENT rule **9** (the supply-chain gate is binding): the forced majors
are adopted through the repo's single override home (`pnpm-workspace.yaml`),
the 14-day age gate cleared (2026-11-10) before the owner ruling
(2026-11-16), the ruling is recorded in-file, and the scoped drop
condition keeps the override surface temporary — rule 9's manual override
pattern being what keeps the gate honest.

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
the drop condition. The drop condition: remove each line when no parent
whose DECLARED range falls inside the override range still excludes
14.0.2 / 11.0.1 — i.e. every range holder subject to the override (glob
`^11`/`^13` — @expo/\*, workbox-build; minimatch `^10.2.x` — eslint,
@typescript-eslint/typescript-estree, @expo/fingerprint,
@eslint/config-array `^10.2.4`) has accepted the patched major. Enumerate
the parents with `pnpm why glob` / `pnpm why minimatch`, then check each
parent's DECLARED range. Unrelated consumers outside the override range
(e.g. `filelist`'s `minimatch` `5.1.9`, below the override floor
`>=7.0.0`) do not block retirement. Re-check in every cooldown sweep.
Note: @eslint/config-array 0.23.5 still declares `^10.2.4`, so the
minimatch line is NOT yet retirable as of 2026-11-18.

## Files touched

- `pnpm-workspace.yaml` — two override lines plus comment.
- `pnpm-lock.yaml` — regenerated.
- `specs/glob-minimatch-upgrade/` — this spec and the investigation doc
  (plan and ledger were deleted in the step-4 cleanup commit).

## Accepted risk (owner-approved 2026-11-16)

The @expo/fingerprint and @expo/config surfaces use glob in developer CLI
workflows. No probe target exists in this repo. Their behavior under glob
14's changed ignore semantics is unverified. The owner accepts this
risk-of-the-unknown. Failure mode: a visible developer-workflow hiccup, not
a shipped bug — these packages never ship to runtime.

## Test plan

- `pnpm install --frozen-lockfile` must be a no-op on the committed lockfile.
- `pnpm audit` must not emit GHSA-3g3m-2fjr-6pw4 or GHSA-g3hv-75wg-m249.
  NOTE: CI's audit step (`test.yml`) runs `--prod --audit-level=high` and
  would NOT catch these (both moderate, dev-only) — this check is MANUAL.
  Manual run recorded 2026-11-18 (full, `--audit-level=moderate`): the two
  glob/minimatch GHSAs are absent; remaining findings are astro
  GHSA-r3h5-4585-7x3w (patched ≥7.4.7 — dependabot #399/#382) and node-forge
  ×3 (patched ≥1.4.3 — the armed pass-2 fold), all outside this lane's scope.
- Root `pnpm test` must pass (core 2566/2566 baseline; recorded run EXIT=0).
- `pnpm typecheck` must pass.
- `pnpm --filter docs build` must pass.
- `pnpm --filter scopelab build` must pass.
- CI (CodeQL, Analyze, rust, test) must go green on the PR.

## Rejected alternatives

- Wait for consumers to bump ranges: no timelines; workbox-build 7.4.1 is the latest upstream release. Waiting buys exposure, not safety.
- Pin glob only: eslint, typescript-estree, and @expo/fingerprint declare minimatch `^10.2.x` and would keep the vulnerable 10.2.6.
- Force minimatch 5.1.9 (filelist's copy) to 11: zero security gain; 5-to-11 API jump for filelist.
