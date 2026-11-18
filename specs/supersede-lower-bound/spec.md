# supersede(): reject an inverted or empty validity interval (lower-bound check)

**Status: Reviewed — owner ratified the design 2026-11-18 (msg `1572645718122954859`); plan.md + LEDGER.md on the PR**  
**Anchor:** issue #414, filed from `specs/expire/spec.md` D1's note. The expire
lane deliberately deferred this fix to its own issue ("its own issue at
implementation time"). This spec is that issue's lane.  
**Intent check:** no INTENT.md change. INTENT says nothing about interval
validation; this is a defect fix inside the supersede guard family. The
`specs/expire` spec already promises the fix ("mirror expire()'s check") and
the owner ratified that design there (2026-11-17, msg `1572591903667654798`).

## Problem

`TemporalService.supersedeInTx`
(`packages/core/src/services/TemporalService.ts`, `supersedeInTx` at :26)
never checks the supersede time `t` against the old fact's validity start.
The start is `old.valid_from ?? old.created_at` — the same expression the
liveness predicates use (`packages/core/src/utils/temporal.ts:6-7`).

A supersede at `t <= start` writes `valid_to = t` on the old row. The old
row then has `valid_to <= COALESCE(valid_from, created_at)`. Its live
window is half-open: `start <= T < valid_to`. That window is empty (t ==
start) or inverted (t < start). The fact is live for no instant, yet it
occupies a supersession chain slot.

A second defect rides the same missing check. When the replacement is a
new fact with no `valid_from`, `supersedeInTx` sets the replacement's
`valid_from = t` (:48-50). At `t <= start` the replacement starts at or
before the fact it replaces, so `history()` orders the successor at or
before its predecessor.

The fix below covers this ordering symptom only for the no-`valid_from`
path. A replacement created with an explicit early `valid_from`
(`TemporalService.ts:85-93`) skips that write, so the same
successor-before-predecessor ordering stays reachable and unchecked.
This spec does not check that case; see the non-goal on overlap and gap
policy.

## Root cause

A pre-existing gap, deliberately deferred. `expire()` got its lower-bound
check first (PR #409, D1) because that lane scoped to the archive verb.
`supersede()` shares the guard stack but kept the gap. The expire spec's
Non-goals section names the gap and points at issue #414.

Evidence: no guard exists on the write path. The old row's write is
`setTemporal(oldId, entityId, { valid_to: t, superseded_by: newId,
superseded_at: now }, tx)` with no interval check before it. Contrast
`expire()` at :125: `if (t <= start) throw new WikiSupersedeError(
'invalid_interval', 'expire()')`. The `invalid_interval` reason is already
in the `WikiSupersedeReason` union (`packages/core/src/types.ts:1614`) —
PR #409 added it. No type widening is needed.

## The decisions

### D1 — mirror expire()'s check, same math

`supersedeInTx` must reject an inverted or empty interval. Immediately
before the writes, add:

```ts
const start = old.valid_from ?? old.created_at;
if (t <= start) throw new WikiSupersedeError('invalid_interval');
```

The default verb in `WikiSupersedeError` is `'supersede()'`, so the
constructor call needs no second argument. The math matches expire()'s D1
exactly: the lower bound is `created_at` only when `valid_from` is absent,
`==` rejects (half-open liveness makes `t == start` an empty interval),
and `t < start` rejects as inverted. A `t` after the start but before the
current time stays legal — retro-active supersede is meaningful, as long
as `t` is strictly after the fact's own start.

### D2 — guard order

The existing guard stack keeps its order: `not_found`, `cross_entity`,
`already_superseded`, `already_expired`, `immutable_target`, `cycle`
checks, then the interval check last, immediately before the writes. An
expired fact with an inverted `t` reports `already_expired`, not
`invalid_interval`. This matches expire()'s D1 ordering rule.

`supersedeInTx` has two callers, and a rejection behaves differently on
each:

- **Public `supersede()`** — the replacement's row creation runs before
  `supersedeInTx` inside the same transaction, so a rejection rolls back
  the created replacement. The existing "leaves no partial writes on
  rejection" test pins this pattern; the new cases reuse it.
- **Librarian ops path** — `applyOps` inserts the replacement first and
  catches `WikiSupersedeError` into a `librarian_op_rejected` diagnostic
  with no rollback
  (`packages/core/src/services/librarian/ops/apply.ts:201-212`). A
  rejection there leaves both facts live and retrievable: the old row
  keeps its window and the unlinked replacement stays. The existing
  `already_expired` ops test (`opsLibrarian.test.ts:135`) pins this
  shape; the new guard adopts it for `invalid_interval` (D3
  consequence 4).

### D3 — documented consequences

The check changes behavior for existing callers in four documented ways:

1. A fact cannot be superseded at or before its own validity start. A
   `validFrom` at or before `valid_from ?? created_at` now throws.
2. A default `validFrom` (`t = now`) can throw on a fact whose
   `valid_from` is future-dated. The throw lasts until the fact's start.
   This mirrors expire()'s documented default-`at` consequence.
3. An explicit early `valid_from` on a new replacement fact is not
   checked — the successor can still start at or before the fact it
   replaces (Problem section). A test pins this boundary so a later
   policy change is visible.
4. Librarian ops change outcome. `applyOps` derives a SUPERSEDE time
   from the model's `valid_from` or the candidate event's time
   (`packages/core/src/services/librarian/ops/extract.ts:116`). An op
   whose time lands at or before the target's start used to link the
   pair with an inverted window, which dropped the old fact from all
   reads, `asOf` reads included. It now surfaces as a
   `librarian_op_rejected` diagnostic with reason `invalid_interval`,
   and both facts stay live and retrievable (D2, ops path). This
   outcome is the path's established rejection semantics, not a new
   pattern: every `WikiSupersedeError` reason already leaves the
   replacement live and unlinked next to a live target. The pre-fix
   outcome was worse — a silent temporal rewrite that hid the old fact
   everywhere. `applyOps` handling of `invalid_interval` stays
   unchanged.

The `docs` guide states consequences 1, 2 and 3 in the supersede rules
section; consequence 4 is pinned by an `opsLibrarian` test and covered
by the diagnostics table entry the guide already carries.

### D4 — docs updates

`packages/core/src/WikiMemory.ts` — the `supersede()` JSDoc (:1174-1178)
gains `invalid_interval` in its throws sentence, worded like the
`expire()` JSDoc (:1188-1196).

`apps/docs/src/content/docs/guides/temporal-facts.md` — the "## Rules"
section gains one bullet: `supersede()` rejects a `validFrom` at or
before the target's validity start (`invalid_interval`), a default
`validFrom` applies the rule to the current time, a fact whose start
is in the future rejects until that start, and an explicit early
`valid_from` on a replacement fact is not validated. The new bullet
goes after the "when the target:" list as its own paragraph — the list
describes target properties, the bullet describes an argument rule.
The "## Expire a fact" section already documents the expire() side; no
change there. `reference/errors.md` already routes `WikiSupersedeError`
reasons to the guide; `guides/diagnostics.md` already carries the
`librarian_op_rejected` row. No change in either.

## Test plan

All cases live in `packages/core/__tests__/supersede.test.ts`, which
already carries the supersede guard suite. The `insert()` helper defaults
`created_at` to 100.

1. RED first, per TDD: write the cases below, run them against the
   unfixed tree, and record each failure. Every case below must fail for
   the right reason (no `invalid_interval` thrown) before the fix lands.
2. `t == start` throws `invalid_interval`: insert with default
   `created_at` 100, supersede with `validFrom: 100`.
3. `t < start` throws `invalid_interval`: `validFrom: 99` on the same
   fact.
4. A `valid_from` on the old row lowers nothing and hides nothing:
   give the old fact `valid_from` 500 (direct `setTemporal`), then
   `validFrom: 400` throws and `validFrom: 600` succeeds.
5. Default `validFrom` on a future-dated fact throws
   `invalid_interval` (D3 consequence 2).
6. Guard order: an expired fact (its `valid_to` in the past) superseded
   with `t` before its start reports `already_expired`, not
   `invalid_interval` (D2).
7. Rejection leaves no partial writes: a `{ title, body }` replacement
   is not persisted and the old row keeps `superseded_by == null` after
   a rejected call.
8. The success path stays intact: a supersede strictly after the start
   still links both rows, and the replacement's `valid_from` equals `t`
   (existing "no gap" test must stay green untouched).
9. Scope boundary (D3 consequence 3): a replacement created with an
   explicit `valid_from: 50` superseded at `validFrom: 200` onto a fact
   with `created_at` 100 still succeeds — the current unchecked
   ordering behavior is pinned, not blessed.
10. Librarian ops path (D3 consequence 4): a SUPERSEDE op whose time is
    at or before the target's start surfaces one
    `librarian_op_rejected` diagnostic with reason `invalid_interval`;
    the old row keeps its window and the replacement stays live and
    unlinked (mirror the `already_expired` ops test's assertions). The
    read path is pinned too: a default read and an `asOf` read inside
    the old window both return both facts.
11. Full `packages/core` suite green; typecheck green; docs build green.

## Rejected alternatives

- **A new error type for the supersede side** — same rejection as the
  expire lane: two error types for one guard family double host handling
  code for no gain; the reason code already disambiguates.
- **Clamp `t` up to `start + 1` silently** — a silent temporal rewrite of
  the caller's chosen time is worse than a refusal; `expire()`'s D1
  rejected silent rewrites for the same reason.
- **Check only when the replacement is a fresh fact** — the old row's
  empty or inverted window corrupts the archive regardless of the
  replacement's shape; a conditional check leaves half the defect live.
- **Also validate the old row's window against the replacement's
  `valid_from` (overlap or gap policy)** — a separate design question
  about successor windows. The expire lane scoped the same question out.
  Out of scope here.
- **Change `applyOps`'s handling of `invalid_interval`** (clamp the op
  time, or skip the replacement insert) — a librarian-path behavior
  redesign outside a guard-mirror lane. Option (a) matches how the path
  already treats `already_expired`: swallow into a diagnostic, keep both
  facts live, pin with an ops test. Keeping both facts live is also the
  truthful outcome: the correction failed, and the pre-fix alternative
  hid the old fact from all reads, `asOf` included.
- **Repair rows already carrying zero-width intervals** — a data
  migration with its own scan and policy. Out of scope; file a follow-up
  if a corrupted store surfaces.

## Release

PATCH (`fix:` — a guard on an existing API; no new surface, no type
change). No migration. Hosts that catch `WikiSupersedeError` see the new
`invalid_interval` reason without code changes. Librarian-op hosts see a
previously linked-but-corrupt event now surface as a
`librarian_op_rejected` diagnostic with both facts live (D3
consequence 4).

## Non-goals

- No change to `expire()`; its guard shipped in PR #409.
- No overlap or gap policy between the old row's `valid_to` and the
  replacement's `valid_from` — including the explicit-`valid_from`
  successor-ordering case the Problem section names (rejected
  alternative above).
- No repair of existing corrupted rows (rejected alternative above).
- No wrapper exposure in react/expo; nothing forwards `supersede()`
  options today, and exposure is its own decision when a host asks.
