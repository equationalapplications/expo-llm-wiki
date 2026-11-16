# LEDGER — glob-minimatch-upgrade

## Decisions

- 2026-11-16, owner (this PR thread): forced-major adoption approved;
  sequencing = fold into cooldown pass 2 (2026-11-20); residual @expo/\*
  exposure accepted; scopelab `includeAssets` remedy deferred to a separate
  lane.
- 2026-11-09 (issue #278 comment): "leave open" park on glob/minimatch —
  superseded by the owner ruling above.

## Review ladder record

- Opus r1 medium $0.27 REQUEST CHANGES; r2 delta low $0.32 REQUEST CHANGES;
  r3 delta low $0.29 APPROVE WITH NITS. Converged.
- Fable r1 high $4.36 REQUEST CHANGES; r2 delta high $1.71 APPROVE WITH
  NITS. Converged. Ladder total ≈ $6.95.

## Working notes

- `pnpm update <transitive>` does not move transitives (lockfile reuse) and
  side-churns unrelated packages. Bump the owning direct dep or override
  exactly.
- An A/B across two checkouts must equalize gitignored state: `git status`
  clean does not mean same-state (found via the scopelab manifest A/B).
- The scopelab duplicate precache entry (includeAssets double-listing) is
  pre-existing, runtime-deduped, and never ships (deploy builds scopelab
  once per fresh checkout). Deferred remedy: drop `'sql-wasm.wasm'` from
  `includeAssets`.
