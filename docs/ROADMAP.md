# ROADMAP — what gets built, in what order

> **ROADMAP.md** · v1.1 · 2026-11-14 ·
> Authority: derived from [INTENT.md](../INTENT.md) and from owner rulings
> of 2026-11-12, 2026-11-13 and 2026-11-14. If this file and INTENT.md
> disagree, INTENT.md wins on intent and this file is wrong until amended.
> Changing the order is an amendment: say so in the pull request, don't
> drift.
>
> v1.1 amendment (2026-11-14): records the owner's ruling on step 4's
> scope (the store only), names three things left out of it as
> exploratory, adds the done mark that step 1 was missing under the
> done-mark rule's new exception (issue #392), allows gate lines to
> gain a dated met note, links step 4 to its issue #390, and rewords
> step 4's `ingestDocument()` gate bullet to match the ruled scope.
> No order change.
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
request. Exception: a mark a completing PR failed to write may be added
afterwards by a pull request that says so and cites the issue tracking
the omission.

**Met gates.** When a step's gate opens, the gate line may gain a
dated note naming the pull request that met it.

**This file carries order, not status.** How much of a charter rule the
code does today is the rule's Status line in INTENT.md. How far a piece of
work has got is its spec's Status line. Neither is repeated here.

## Sharper memory (ruled 2026-11-12 to 2026-11-14)

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

Done — merged 2026-11-13, PR #379, spec [librarian-guidance](../specs/librarian-guidance/spec.md)

A host can add a few plain lines of guidance to the librarian, and they
work on the `ops` chain as well as the `legacy` one. With guidance comes
one general rule, added by the engine: memory leaves out what a better
record already holds, and points to that record. Issue
[#375](https://github.com/equationalapplications/expo-llm-wiki/issues/375).

The general rule is added only when a host sets guidance (owner ruling,
2026-11-13). A host that sets none gets exactly the prompts it has
today, so an upgrade changes nothing for it.

Guidance is set in two places: one default for the database, and an
optional value per entity, which wins. The host passes both in; the
engine stores neither. The older whole-prompt override
(`prompts.librarianSystemPrompt`) is marked deprecated in this step's
planned release and removed in step 2's; the deprecation notice
reached no published version (see `specs/librarian-guidance/`,
Release).

*Gate:* a spec, checked against INTENT.md. Rule 11 applies: the spec says
how the change is measured, and no accuracy or cost claim is published
without a run.

### Step 2 — Statement kinds and areas in the software-org schema — PLANNED

Done — merged 2026-11-14, PR #380, spec [statement-kinds](../specs/statement-kinds/spec.md)

The software-org schema gains four kinds of statement (rule, decision,
lesson, trap), defined by content, and an "area" type for a named part of
a codebase. Memory then holds one node per thing, with typed statements
attached. Issue
[#376](https://github.com/equationalapplications/expo-llm-wiki/issues/376).

**This step's release is a major release, 9.0.0** (owner ruling,
2026-11-13). It removes the `handoff` and `session_recap` node types and
the `handoffFor` edges from the software-org schema, because session
records become working memory that is searched as it is. It also removes
the deprecated `prompts.librarianSystemPrompt` override. The reasoning:
outside adoption is close to zero, so a clean break costs least now.

*Gate:* a spec. It includes a cheap targeted test of whether a small model
sorts the kinds dependably.

### Step 3 — A source pointer on every librarian fact — PLANNED

Done — merged 2026-11-14, PR #385, spec [source-pointers](../specs/source-pointers/spec.md)

Ops facts the librarian writes can carry a pointer to where they came
from: the source event and, when grounding permits, the verified quote
(`ref` and `position` slots exist with no producer; heal and legacy
facts carry no pointer — the accepted gap). Verified quotes survive
prune inside the fact's own record (owner ruling, 2026-11-14). Today a
host hides a quote by forgetting its fact by entry id,
`forget({ entryId })` — reads and exports drop it immediately, and prune
purges the row; deleting quotes by event id, `forget({ eventId })`,
is planned in issue
[#386](https://github.com/equationalapplications/expo-llm-wiki/issues/386). Issue
[#377](https://github.com/equationalapplications/expo-llm-wiki/issues/377).

*Gate:* a spec — met (`specs/source-pointers/`, PR #385,
owner-approved 2026-11-14; schema additive only, rule 2).

### Step 4 — A source store in the engine — PLANNED

Done — merged 2026-11-15, PR #396, spec [source-store](../specs/source-store/spec.md)

The engine stores a document's text as it is, indexes it, and searches it
with no model call. A read can then return two labelled groups:
statements the librarian wrote, and passages from sources. A host that
hands the engine a document no longer has to pay a model to turn it into
facts before it can be found. Issue
[#390](https://github.com/equationalapplications/expo-llm-wiki/issues/390).

**Scope: the store only** (owner ruling, 2026-11-14). `ingestDocument()`
does not change. A host that also wants facts from a document calls it
as it does today, and those facts point to the document by its
`sourceRef`, as today. A host that does not use the store gets exactly
what it has today, so an upgrade changes nothing for it.

*Gate:* step 3 merged, so pointers and the store agree on how a source is
named — met 2026-11-14 (PR #385). Then a spec that settles, at least:

- how rule 5 ("documents are immutable facts") is reworded, in the same
  pull request that ships the store;
- that the store makes no model call and spends no tokens (rules 1 and 7);
- that every schema change is additive (rule 2), and that no dependency
  is added (rule 8);
- what links a stored source to the facts `ingestDocument()` writes
  under the same `sourceRef`, now that the call itself is ruled
  unchanged;
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
- **Extraction that reads from the source store.** `ingestDocument()`
  pointed at a stored source instead of being sent the text again, with
  each fact pointing at the passage it came from. It would be the first
  producer for the source pointer's `ref` and `position` slots. Named on
  2026-11-14 and left out of step 4; not ruled.
- **Document facts the librarian may replace.** Once the engine keeps a
  document's text, the text is the evidence, and facts drawn from it
  could be replaced or sharpened like any other statement. This changes
  what rule 5 means, so it needs its own ruling before anyone explores
  it. Named on 2026-11-14 and left out of step 4; not ruled.
- **Working memory in the source store.** Records that are never
  extracted and that drop out of search with age. Under step 4's ruling
  nothing in the store is extracted unless the host asks, so only the
  ageing rule is missing. Left out of step 4 (owner ruling,
  2026-11-14). Step 4's spec must leave room to add a per-source age
  later as an additive change; the ruled scope does not build it.

## What is intentionally absent

- **No dates.** The project runs on gates and reviews, not calendars.
- **No accuracy or cost claims.** Rule 11 binds: numbers are published
  only with the run that produced them.
- **No re-processing of facts already stored.** Guidance and kinds apply
  to what the librarian writes from now on. A store with a large backlog
  is cleaned once, outside the product (owner ruling, 2026-11-13).
- **No check of a statement against real code.** The leave-out rule is an
  instruction to the model. Nothing in the engine can verify it.
