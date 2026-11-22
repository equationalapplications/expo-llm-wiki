# ROADMAP — what gets built, in what order

> **ROADMAP.md** · v1.2 · 2026-11-20 ·
> Authority: derived from [INTENT.md](../INTENT.md) and from owner rulings
> of 2026-11-12, 2026-11-13, 2026-11-14, 2026-11-19 and 2026-11-20. If this file and INTENT.md
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
> v1.2 amendment (2026-11-20): adds the section "A model of the host's
> choosing" with the steps the owner ruled on 2026-11-19 and 2026-11-20
> (owner rulings: bring your own classifier; System-One decisions carry
> no verb restrictions, only visibility). The new steps are PLANNED.
> Their gate lines name merged steps and specs, not benchmark scores —
> rule 11 backs claims and gates the native engine; the host measures
> whatever model it enables. Three named explorations move into the
> exploratory list so nobody treats them as gates. No change to the
> order of the existing steps.
>
> Scope note: this is the first roadmap for this repository. It starts
> with the "sharper memory" work ruled in that week. It is not an inventory
> of all open work; the issue tracker holds the rest.

## How to read this file

**Steps are ordered by gates, not by calendar.** Each step names the gate
that opens it. A step with an open gate is not late; it is waiting.

**Each step carries a promise class**, the same three the hosted-service and
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

Follow-up done — merged 2026-11-18, PR #422, spec [forget-by-event-id](../specs/forget-by-event-id/spec.md) (issue #386)

Ops facts the librarian writes can carry a pointer to where they came
from: the source event and, when grounding permits, the verified quote
(`ref` and `position` slots exist with no producer; heal and legacy
facts carry no pointer — the accepted gap). Verified quotes survive
prune inside the fact's own record (owner ruling, 2026-11-14). A host
hides a quote by forgetting its fact by entry id, `forget({ entryId })`
— reads and exports drop it immediately, and prune purges the row;
deleting quotes by event id, `forget({ eventId })`, ships in
[`specs/forget-by-event-id/`](../specs/forget-by-event-id/spec.md)
(issue
[#386](https://github.com/equationalapplications/expo-llm-wiki/issues/386)). Issue
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
roadmap entry of their own: the hosted cloud service, clanker and Curated Journal.
Curated Thoughts needs no change.

## A model of the host's choosing (ruled 2026-11-19 and 2026-11-20)

The engine's judgement work — typing stored facts, resolving entity
references, screening heal candidates, suggesting edges — runs on the
same generative model that writes the librarian's facts. The owner has
ruled that a host may opt each of these sites in, one at a time, to a
second, smaller model of its own choosing (the System-One model), while
the librarian keeps the model the host hands it for writing.

Core stays unopinionated about which model that is. The host chooses
the model and the host measures it: "The engine runs whatever model you
hand it and puts no benchmark in front of that choice. How well that
model works on your data is yours to measure" (INTENT rule 11). Core
guarantees the mechanics instead: a site runs only when the host opts
it in; a host that opts nothing in gets byte-for-byte today's behavior;
spend is metered; output is validated before it reaches memory; and
every decision is surfaced in receipts and per-pass counters a human
audit can be built on. Step 11 may rewrite a fact in place and step 12
may remove one when the host runs them; typing stamps facts; the
receipts and counters make all of these moves auditable.

The steps below are ordered by dependencies, not by calendar. The
config surface comes first; the context budget and the shortlist are
independent of it; the site conversions wait on the pieces they use.

### Step 5 — The System-One config surface — PLANNED

Done — merged 2026-11-21, PR #442, spec [system-one-config](../specs/system-one-config/spec.md) (catch-up mark by PR #448; omission tracked in issue #449)

One optional `systemOne` config section: the per-site typing modes, the
`minConfidence` thresholds, the low-confidence policy (`leave` the fact
untouched, or re-run it on the generative model), and a classifier
abstain option so the typing question can answer "none of these".
Maintenance passes that use a System-One site join the host-passed
maintenance job set; nothing types on write by default.

*Gate:* a spec.

### Step 6 — A context budget the host can declare — PLANNED

Done — merged 2026-11-21, PR #438, spec [context-budget](../specs/context-budget/spec.md) (catch-up mark by PR #448; omission tracked in issue #449)

Every prompt-size constant in the engine (the resolve and heal caps,
the extract cap, the ingest chunk default, the characters-per-token
estimate) resolves through one budget resolver. The default keeps
every byte identical to today. A host with a small-window model
declares a budget instead of collecting overflow skips.

*Gate:* a spec.

### Step 7 — A per-fact shortlist and its recall report — PLANNED

Done — merged 2026-11-21, PR #439, spec [shortlist-recall](../specs/shortlist-recall/spec.md) (catch-up mark by PR #448; omission tracked in issue #449)

The ontology backfill prompt lists every typed node, title-ordered and
capped. This step adds a deterministic per-fact shortlist builder and a
`shortlist-recall` benchmark that measures, on the committed fixture,
how often the shortlist contains the true target. The report publishes
numbers about the engine's own code and blocks nothing.

*Gate:* a spec.

### Step 8 — The shortlist in the backfill prompt — PLANNED

Done — merged 2026-11-21, PR #453, spec [backfill-shortlist-wiring](../specs/backfill-shortlist-wiring/spec.md)

The backfill title catalog narrows from "every typed node, capped" to
the per-fact shortlist of step 7. The step's spec records the errata
that supersedes the temporary data-scope ruling of 2026-11-19
(PR #425), which accepted the all-typed-nodes catalog as temporary.

*Gate:* step 7 merged, and a spec.

### Step 9 — The backfill cap under the context budget — PLANNED

Done — merged 2026-11-22, PR #455, spec [backfill-cap-context-budget](../specs/backfill-cap-context-budget/spec.md)

The ontology-backfill prompt cap joins the resolver of step 6, the
last prompt-size constant to do so.

*Gate:* steps 6 and 8 merged, and a spec.

### Step 10 — Edge suggestions from System-One — PLANNED

Done — merged 2026-11-22, PR #459, spec [edge-suggestions-system-one](../specs/edge-suggestions-system-one/spec.md)

The edge-suggestion site opts in to the configured model. Edge
suggestion is additive — a wrong edge is a wrong fact, not a lost one —
so it runs first among the site conversions.

*Gate:* steps 5 and 7 merged, and a spec.

### Step 11 — Resolution from System-One — PLANNED

The entity-resolution site opts in to the configured model. When the
configured model is unavailable or below threshold, the fact falls
through to the generative path, and the pass warns once.

*Gate:* steps 5 and 6 merged, and a spec.

### Step 12 — Heal screening from System-One — PLANNED

The heal screen opts in to the configured model. Heal may forget when
the host runs it (owner ruling, 2026-11-20); this step ships the
per-fact receipts (`heal_deleted`, `heal_downgraded`) and the
changed-id lists that make such moves auditable, and documents the
prune and event-retention clocks a host must set to audit them.

*Gate:* steps 5 and 6 merged, and a spec.

### Step 13 — Type on write — PLANNED

Facts get typed when the librarian writes them, inside the same
host-passed budget, instead of waiting for a maintenance pass. The
write path's instruction templates split from the backfill's own in
`PromptService.ts`, so a write-time manifest change cannot change
backfill prompts. Facts typed this way carry no
manifest-drawn edges until step 10 replaces them; the spec discloses
that gap.

*Gate:* steps 5 and 6 merged, and a spec.

### Step 14 — Ingest-time typing — PLANNED

`ingestDocument()`'s extracted facts get typed through the step 13
mechanism instead of the write-time one, completing the typing story
for the document path.

*Gate:* step 13 merged, and a spec.

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
- **An extraction-quality benchmark.** Whether the generative model
  extracts the same facts when the backfill prompt stops carrying the
  manifest. Named 2026-11-19 and removed from the step list (owner
  amendment); step 13's docs disclose the risk instead.
- **A classifier-confidence calibration tool.** A tool that tunes a
  host's `minConfidence` thresholds on its own data. The docs explain
  host self-calibration instead; the engine ships no tool.
- **A keyword or ambiguous-band gate for the shortlist.** Whether a
  lexical pre-filter should harden the shortlist against ambiguous
  titles. A System-One site with no step; named 2026-11-20.

## What is intentionally absent

- **No dates.** The project runs on gates and reviews, not calendars.
- **No accuracy or cost claims.** Rule 11 binds: numbers are published
  only with the run that produced them.
- **No re-processing of facts already stored.** Guidance and kinds apply
  to what the librarian writes from now on. A store with a large backlog
  is cleaned once, outside the product (owner ruling, 2026-11-13).
- **No check of a statement against real code.** The leave-out rule is an
  instruction to the model. Nothing in the engine can verify it.
