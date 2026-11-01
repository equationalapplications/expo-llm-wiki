# specs/ — one folder per spec cycle

Adopted 2026-11-01 (pattern ruled 2026-10-23, SDD decisions D6–D8). The
canonical mechanics live once, in the knowledge vault's pr-spec-driven
procedure ("Artifact layout"; the vault lives outside this repo). This
file is the in-repo summary so that a
session working from the repository alone can follow it.

## The folder is the unit

Each spec cycle gets one folder, `specs/<name>/`, holding three files:

| File | What it is | Lifetime |
|---|---|---|
| `spec.md` | Problem, root cause with evidence from real runs or logs, proposed change, files touched, test plan. Carries a Status line: **Draft → Reviewed → Implemented**. | Durable: stays after merge. |
| `plan.md` | The ordered implementation plan. | Transient: deleted by the final cleanup commit. |
| `LEDGER.md` | One checkbox per plan task, an evidence link per tick, and a "what's in flight" line. | Transient: deleted by the final cleanup commit. |

Everything in the folder is tracked in git. Nothing under `specs/` is
gitignored. `.superpowers/` (runtime working state, never source) stays
ignored, and so does the legacy `docs/superpowers/plans` line; the nine
legacy plans there are force-tracked.

`<name>` is a short kebab-case slug, no date prefix: the folder's git
history carries the dates.

## Ledger disciplines

1. **Tick only after verification.** A box is ticked when that task's
   verification has passed, as a step of the implementation loop, never as
   an afterthought at the end.
2. **Reconcile at session start.** Compare the ledger with the disk. If the
   ledger claims work the disk does not show, trust the disk, roll the
   ledger back, and log the discrepancy in the ledger.

## Lifecycle: one PR, draft until implemented

1. Write `spec.md`. Check it against `INTENT.md` (and, through INTENT,
   the SynapseTree charter). Push and open a **draft** PR carrying the
   folder; the folder is the reviewer-facing artifact. On approval the
   status flips to **Reviewed**.
2. Add `plan.md` and `LEDGER.md` to the same PR once the spec gate
   closes. There are no spec-only merges.
3. Implement on the same branch. Conventional commits name the spec
   section they fulfil. Tick ledger boxes after verification.
4. When review loops converge: one final cleanup commit on the same PR
   flips the spec to **Implemented** and deletes `plan.md` and
   `LEDGER.md` (never a separate cleanup PR). Then `gh pr ready`; bot
   reviews that skip drafts fire on the ready flip. CI runs on every
   push, draft included.
5. After merge, the status-carrying `spec.md` and the code are the record.
   Nothing is left to clean up.

## Authority chain

INTENT beats spec beats plan beats prompt. A contradiction means the lower
artifact is wrong until the higher one changes. When the spec is silent,
stop and ask; never invent.

## Larger work: roadmaps

When work will not fit one spec cycle, an optional `docs/roadmaps/<epic>.md`
sits between INTENT and the specs. It names and orders the slices; it
carries no authority over a spec's content. Create the directory with the
first roadmap.

## Legacy layout

Specs and plans written before 2026-11-01 live in `docs/superpowers/specs/`
and `docs/superpowers/plans/` (flat, date-prefixed). They are history and are
not migrated. The legacy specs' Status lines still bind: update one in
the same PR that
changes the behaviour it describes. New work goes here.

## Skeletons

`specs/<name>/spec.md`

```markdown
# <Title>

**Status:** Draft
**Date:** YYYY-MM-DD
**Intent check:** <which INTENT.md rules this touches, and how it aligns>

## Problem

## Root cause (with evidence)

## Proposed change

## Files touched

## Test plan
```

`specs/<name>/plan.md`

```markdown
# <Title> — plan

Spec: `specs/<name>/spec.md`

1. <task> — files, test, verification command
2. …
```

`specs/<name>/LEDGER.md`

```markdown
# <Title> — ledger

In flight: <task number and one line, or "nothing">

- [ ] 1. <task> — evidence: <commit, test run, or log link>
- [ ] 2. …

## Discrepancies

- YYYY-MM-DD — <what the ledger claimed, what the disk showed, what was rolled back>
```
