---
title: Glossary
description: The memory engine's vocabulary — how facts live, age, and leave, plus the design ideas behind it.
sidebar:
  order: 6
---

The memory model is small: facts about an entity, the events they were learned from, and a few
verbs that move facts through their lifecycle. The terms below are the vocabulary used across
these docs and in the engine's API.

## The memory model

**Fact** — a single stored statement about an entity, with a title, body, tags, confidence, and
provenance (which document or event it came from). Facts are what the engine reads, ranks, and
returns in a memory bundle.

**Working memory** — what the engine hands back when you ask: a bundle of facts, tasks, events,
edges, and a summary, selected for relevance to the current moment. The agent's context at call
time is built from this.

**Wisdom** — knowledge that passed through curation rather than staying raw: condensed,
interlinked, and updated through review. The design bar is that the structure itself carries
recall — a lesser model navigating a well-built graph outperforms a cleverer model without one.

**Episodic memory** — the event log. Every observation, decision, action, and outcome is kept as
an event; facts are (re)derived from it. Events follow the host's `retainEventsFor` window: a
`runPrune()` with events retention set deletes events that pass the window and the librarian
watermark, on the host's schedule. `clearAll` deletes all events only with
`includeEvents: true`; plain erasure keeps them (see [Deleting data](/expo-llm-wiki/guides/deleting-data/)).

**Sources** — documents you store so their exact text can be quoted back. Stored source text is
kept verbatim with provenance, cut into passages with character offsets, and never merged
across entities. See [the source store guide](/expo-llm-wiki/guides/source-store/).

## Lifecycle verbs

**Memory fact states** — a fact is **live** (stored and readable), **superseded** (its validity
ended — replaced by a newer fact, or ended without replacement), **forgotten** (removed from
recall by `forget()`, still in the store), or **gone** (hard-deleted by prune; the text may
still be recovered from the raw database file). **Erased** is not a state — it's the engine's
verified claim that the erase pipeline ran to completion: deleted content in the database file
overwritten with zeros, the WAL truncated after a verified checkpoint, each step's outcome
checked, delivered in an `erase()` report.

**Forget** — removes a fact from recall immediately (a soft delete). The promise is "gone from
recall now, gone from disk at erase" — forgetting is an instruction, not destruction. See
[Deleting data](/expo-llm-wiki/guides/deleting-data/).

**Prune (`runPrune`)** — applies the host's retention windows: superseded facts age into
forgotten, forgotten facts age into gone, on the host's schedule. It is not an erasure tool —
see [Deleting data](/expo-llm-wiki/guides/deleting-data/).

**Erase** — takes every forgotten fact in scope past gone: deleted content in the database file
is overwritten with zeros and the WAL is truncated after a verified checkpoint, with a report
naming each step's outcome. Always on at full
strength; no opt-out. Ships with the forget-erasure work in this release — see
[Deleting data](/expo-llm-wiki/guides/deleting-data/).

**Expire** — ends a fact's validity without a replacement: an archive, not a deletion. The
archived fact becomes superseded. Planned, not yet released — a separate spec precedes its
implementation.

**Heal** — the periodic repair pass: soft-deletes wrong or superseded entries, checks
consistency, and reports clean when nothing is off. Part of the librarian's repair function,
distinct from ingest (below).

## Vocabulary

**Intuitive Wisdom** — knowing the curated fact *at the time it is relevant*. The test is
temporal, not mechanical: the right fact is present in the agent's context when it matters —
not merely retrievable if the agent thinks to ask. No delivery mechanism is part of the
definition.

**Curated Wisdom** — knowledge that passed through curation machinery rather than raw or
raw-indexed: librarian synthesis, reviewed proposals and supersession, and human
reconciliation on the correction path.

**Wisdom Layer** — the curated, graph-interlinked tier of the memory system, exportable as
markdown. It is the first-class context source; its design bar is "clear even to an agent of
lesser intelligence — structure does the work, not model cleverness."

**Active Librarian** — the background engine that turns raw input into curated memory. One
component, two named functions: **ingest** (the understanding pass) and **repair** (the
consistency/heal pass). Docs and error messages follow that vocabulary.

**Anchor Truth** — facts-layer content treated as ground truth: statements authoritative enough
to anchor other knowledge, in contrast to curated wisdom.

**Ingest vs. Repair** — the librarian's two named functions: ingest = the
librarian/understanding pass; repair = the consistency/repair pass (the "heal" run).

**OKF (Open Knowledge Format)** — the note format used across the ecosystem: YAML frontmatter
(version, profile, title, entity type, tags, timestamps) plus a body, with wiki-links between
neighboring notes.

**schema-software-org** — the published ontology schema the memory graphs follow: a fixed set
of node and edge types with strict-mode manifests, so memories written by different agents and
hosts stay interoperable.

**core-llm-wiki / expo-llm-wiki** — the open-source TypeScript memory engine these docs cover
(monorepo `expo-llm-wiki`; the core package is `core-llm-wiki`, with companion packages for
React bindings, schemas, and note format).

**Data Sovereignty** — the customer can export the raw database anytime and use it offline; no
vendor lock-in, no shared tables, no cross-tenant leaks. Erasure (above) and clean exports are
the compliance side of the same principle.

**Structure does the work, not model cleverness** — the design bar for the whole system:
retrieval and navigation must succeed even for a lesser agent, because the knowledge graph's
structure carries recall rather than model intelligence.
