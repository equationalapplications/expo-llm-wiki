# Plan — source pointers on librarian facts (#377 / PR #385)

**Status:** Active. Spec approved by the owner 2026-11-14 (spec stop);
reviewer re-gate PASSED (rev 12; nits in rev 13). This plan implements
`specs/source-pointers/spec.md` on this branch per INTENT.md, "How
changes are made", step 1. It is deleted with this ledger by the final
cleanup commit, which flips the spec Status to Implemented.

## Rulings carried in (2026-11-13 + 2026-11-14)

- Owner gate passed 2026-11-13 for the four scope decisions.
- Owner ruling 2026-11-14 (relay: Fable): verified quotes survive
  prune/export/outbox inside the fact's record (charter consolidation,
  not a deletion-promise violation); prune stays hands-off facts;
  quotes are pointer-in-function; docs state a quote carries whatever
  its event carried. Additions: forget({ eventId }) filed as #386 and
  cited in §forget boundary + §Non-goals; INTENT Amendments entry
  records the retention ruling ("recorded with specs/source-pointers/").
- Consult (Claude Code Opus 5.5 high, 2026-11-14, GO): pinning test must
  be behavioral under BOTH index strategies (fts5 + minisearch);
  §Reads sentence names every explicit column/field list incl. FTS5
  SQL (fts5Sql.ts:51-53, 75, 101-104, 182-184); say "charter rule 8/12"
  (INTENT has rules 1–11 only).

## Work breakdown (from spec §Files touched; execute in this order)

1. **Schema + types.** Add nullable `source_pointer TEXT` on `entries`
   (migration v16, column-add ordering per spec); add `WikiSourcePointer`
   type + optional `WikiFact.source_pointer`; `forget()` untouched.
2. **Ops write path.** `ops/extract.ts`: unknown `source_event` label →
   null + `source_pointer_unresolved` diagnostic (replaces the silent
   drop; reason `'unsupported_strategy'` on legacy). `ops/apply.ts`:
   write the pointer with the quote (grounding-validated only);
   one pointer per fact — a model naming several gets the single
   resolvable one + the diagnostic per §One pointer, not a list.
3. **Legacy path.** Tolerant parse only; prompt byte-identical;
   same diagnostic code with reason.
4. **OKF.** Optional `source_pointer` frontmatter key, round-trip both
   builders; parse-result carries dropped values on the new optional
   field (never silently swallowed).
5. **Export/import/outbox.** Pointer rides dump + outbox verbatim;
   malformed pointer at import → `source_pointer_invalid` (nulled,
   detail `factId`).
6. **Reads + prune.** Reads return the pointer; prune never touches
   facts or pointers (dangling by design); no event join on reads.
7. **INTENT.md + ROADMAP.** Rule-5 Planned note status clause only;
   Amendments entry (retention ruling + this change, per precedent
   INTENT.md:385-402); ROADMAP step 3 done mark. Glossary term.
8. **Cleanup commit.** Flip spec Status → Implemented; delete
   plan.md + LEDGER.md.

## Test plan

All 13 spec tests, plus the consult-mandated pinning test:

14. **No-leak pin (behavioral, both strategies).** Under
    `indexStrategy: 'fts5'` AND `'minisearch'`: store a fact whose
    quote holds a sentinel token. Keyword search for the sentinel
    returns nothing (a body token still hits). Stub `llmProvider.embed`
    records inputs; none contain the sentinel. Stored body does not
    contain the quote. Update that changes only `source_pointer`
    adds no `fts_pending` row.

Plumbing tests only (spec rule-11 intent: no accuracy/cost claims).
Also keep: opus/delta findings already in the test plan (temporal read
pattern, CASE import, precise quote check, entity isolation).

## Gates after implementation

CI full suite + audit steps + Rust job; review tier per the review
policy (spec-level change → tier with independent leaf review if
CodeRabbit unavailable); merge commits (never squash); minor release
9.1.0. Cite #386 in §forget boundary + §Non-goals text in rev 9
(the other lane's fold owns that edit; this plan assumes it).
