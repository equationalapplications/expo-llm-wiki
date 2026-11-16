# Plan: glob/minimatch forced-major adoption (cooldown sweep pass 2)

**Date:** 2026-11-16
**Status:** Executed — implementation predates this plan (step-0 experiment);
this plan records the executed steps and the remaining pass-2 work.

## Executed steps (already on this branch)

1. Step-0 investigation ran the isolation experiment: two range overrides in
   `pnpm-workspace.yaml`, lockfile regeneration, full probe matrix. Result:
   zero observable drift; both targeted advisories stop emitting.
   Evidence: `investigation.md` (rev 6), review ladder Opus r1-r3 + Fable
   r1-r2, both APPROVE WITH NITS.
2. Owner ruling 2026-11-16 (this PR thread): forced-major adoption approved;
   fold into cooldown pass 2; accept the unprobed @expo/\* exposure; defer
   the scopelab `includeAssets` double-listing remedy to a separate lane.

## Remaining steps (cooldown pass 2, 2026-11-20 armed cron `7e3f2bdc1576`)

1. Cron verifies gate clearance for node-forge@1.4.3 (clears
   2026-11-18T01:06Z) and astro@7.4.7 (clears 2026-11-19T19:59Z) from the
   registry before acting. No registry time check, no action — that is the
   gate.
2. Cron bumps the node-forge override floor `<1.4.1 → <1.4.3` on this
   branch and verifies the four node-forge advisories stop emitting.
3. Cron checks the hono overrides for removal (drop if natural resolution
   picks >=4.13.16 / >=2.1.6).
4. Cron merges dependabot PR #399 (astro) and closes #382 as superseded.
5. One merge wave: this PR merges first (CI green), then the pass-2 branch
   work lands as its own PR on top, per the cron brief.

## Risks

- Pass-2 items depend on registry gate clearance; the cron brief makes the
  gate a stop condition, so a slipped clearance only delays, never forces.
- The hono override removal can be skipped safely (the pins keep working).
