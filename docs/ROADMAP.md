# ROADMAP — what gets built, in what order

> **ROADMAP.md** · v1.0 · 2026-11-13 ·
> Authority: derived from [INTENT.md](../INTENT.md) and from owner rulings
> of 2026-11-12 and 2026-11-13. If this file and INTENT.md disagree,
> INTENT.md wins on intent and this file is wrong until amended. Changing
> the order is an amendment: say so in the pull request, don't drift.
>
> Scope note: this is the first roadmap for this repository. It starts
> with the "sharper memory" work ruled in that week. It is not an inventory
> of all open work; the issue tracker holds the rest.

## How to read this file

**Steps are ordered by gates, not by calendar.** Each step names the gate
that opens it. A step with an open gate is not late; it is waiting.

**Each step carries a promise class**, the same three the SynapseTree and
Curated Journal roadmaps use:

- **BINDING** — ruled: it will be built, in this order.
- **PLANNED** — decided in principle; its detail waits on a spec, an open
  decision, or an outside dependency. Its place in the order can move by
  amendment.
- **EXPLORATORY** — named so nobody builds it by accident. No commitment
  to build it at all.

**Done mark.** When a step completes, one dated line goes under its
heading: `Done — merged YYYY-MM-DD, PR #N, spec <link>`. It is written in
the pull request that completes the step, never in a status-only pull
request.

**This file carries order, not status.** How much of a charter rule the
code does today is the rule's Status line in INTENT.md. How far a piece of
work has got is its spec's Status line. Neither is repeated here.

## Sharper memory (ruled 2026-11-12 and 2026-11-13)

The charter says memory should get sharper with time, not just bigger. In
use, the engine's librarian keeps too much: many true statements that only
repeat what a better record already says, and that go stale when that
record changes. These four steps are the engine's part of fixing that.

The order is ruled (owner, 2026-11-13): step 1, then steps 2, 3 and 4.
Curated Thoughts builds its own half of step 1
([curated-thoughts#343](https://github.com/equationalapplications/curated-thoughts/issues/343))
straight after it, before step 2, because its librarian does not use
this engine's prompts.

### Step 1 — Librarian guidance and the general leave-out rule — PLANNED

A host can add a few plain lines of guidance to the librarian, and they
work on the `ops` chain as well as the `legacy` one. With guidance comes
one general rule, added by the engine: memory leaves out what a better
record already holds, and points to that record. Issue
[#375](https://github.com/equationalapplications/expo-llm-wiki/issues/375).

The general rule is added only when a host sets guidance (owner ruling,
2026-11-13). A host that sets none gets exactly the prompts it has
today, so an upgrade changes nothing for it.

*Gate:* a spec, checked against INTENT.md. Rule 11 applies: the spec says
how the change is measured, and no accuracy or cost claim is published
without a run.

### Step 2 — Statement kinds and areas in the software-org schema — PLANNED

The software-org schema gains four kinds of statement (rule, decision,
lesson, trap), defined by content, and an "area" type for a named part of
a codebase. Memory then holds one node per thing, with typed statements
attached. Issue
[#376](https://github.com/equationalapplications/expo-llm-wiki/issues/376).

*Gate:* a spec. It includes a cheap targeted test of whether a small model
sorts the kinds dependably.

### Step 3 — A source pointer on every librarian fact — PLANNED

Every fact the librarian writes carries a pointer to where it came from:
the source, the quote and its position. Today it carries none. The host
keeps the source text; the engine keeps the pointer. Issue
[#377](https://github.com/equationalapplications/expo-llm-wiki/issues/377).

*Gate:* a spec. The schema change is additive only (rule 2).

### Step 4 — A source store in the engine — PLANNED

The engine stores a document's text as it is, indexes it, and searches it
with no model call. A read can then return two labelled groups:
statements the librarian wrote, and passages from sources. A host that
hands the engine a document no longer has to pay a model to turn it into
facts before it can be found.

*Gate:* step 3 merged, so pointers and the store agree on how a source is
named. Then a spec that settles, at least:

- how rule 5 ("documents are immutable facts") is reworded, in the same
  pull request that ships the store;
- that the store makes no model call and spends no tokens (rules 1 and 7);
- that every schema change is additive (rule 2), and that no dependency
  is added (rule 8);
- what `ingestDocument()` does once the store exists;
- how sources are removed (`forget()`), exported and imported.

*Why here:* it is the largest of the four, and nothing waits on it.
Curated Thoughts already keeps its own source text, so the first three
steps deliver without it.

*Who follows:* the hosts that hand documents to the engine each carry a
roadmap entry of their own: SynapseTree, clanker and Curated Journal.
Curated Thoughts needs no change.

## Exploratory — named so nobody builds them by accident

- **The general leave-out rule for every host, always.** Today's ruling
  ties the rule to guidance (step 1). Turning it on for every host would
  change what existing hosts' models write on upgrade, without those
  hosts doing anything. Before this is explored, one step makes it safe:
  a cheap targeted test that runs a fixed set of events from a host with
  no better record to point to (a companion app, for example) through
  the old and the new prompts and shows that no fact is lost. Without
  that test, this stays unbuilt.

## What is intentionally absent

- **No dates.** The project runs on gates and reviews, not calendars.
- **No accuracy or cost claims.** Rule 11 binds: numbers are published
  only with the run that produced them.
- **No re-processing of facts already stored.** Guidance and kinds apply
  to what the librarian writes from now on. A store with a large backlog
  is cleaned once, outside the product (owner ruling, 2026-11-13).
- **No check of a statement against real code.** The leave-out rule is an
  instruction to the model. Nothing in the engine can verify it.
