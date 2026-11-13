# INTENT — expo-llm-wiki

**Read this file first.** It explains why this repository exists, the rules
it must follow, what it deliberately does not do, and how changes are made.

Two documents sit above and below this one:

- **Above it:** the SynapseTree founding charter
  (`SynapseTree/docs/founding/INTENT.md`, in the sibling repository). That
  charter decides what the memory engine promises its users: bring your own
  inference, your data stays yours, search that bends when your provider
  fails, no invisible spend, and the rest. This file does not restate or
  re-decide any of it. Where this file and the charter disagree, the charter
  wins, and this file gets amended.
- **Below it:** the specs, one folder each under `specs/<name>/` (see
  `specs/README.md`; work from before 2026-11-01 stays in
  `docs/superpowers/specs/`). If this file and a spec disagree, this file
  wins on *intent* (what we are trying to do) and the spec wins on *detail*
  (exactly how).

Each rule has a **Status** line saying how much of it the code does today:

- **Built** — the code does this.
- **Partly built** — some of it exists; the line says what is missing.
- **Planned** — decided, but not in the code yet.
- **Open decision** — not decided yet.

Statuses were checked against the code on 2026-10-29 (release 7.13.1).
Update a status line in the same pull request that changes the behavior.

What is planned next, and in what order, is in `docs/ROADMAP.md`. That
file carries order only; status stays in the lines described above.

## Why this repository exists

SynapseTree is one memory engine with two doors: a cloud service and an
installed package. This repository is the installed package. The charter
names the Expo package as the door for phone apps and the core package as
the door for everything else. The same engine code runs behind both doors.

Three kinds of software depend on what is published from here:

- **Curated Thoughts**, the desktop app, pins an exact core version and
  checks the wiki tables' schema at startup from Rust before the JavaScript
  engine loads.
- **SynapseTree's cloud service**, which runs the engine in-process over one
  SQLite file per tenant.
- **Developers on npm**, who install one of the published packages into an
  Expo, React, Node, or plain JavaScript app, and who can try the engine in
  the browser playground published to GitHub Pages.

The repository is a pnpm monorepo. Published packages live under
`packages/` (core, expo, react, okf, core-llm-tools, schema-org,
schema-software-org, prisma-outbox, and `mcp-server`, the SynapseTree
agent door; see `specs/mcp-server/spec.md`). Two packages are private and never
published: `integration` (integration tests) and `benchmarks` (the
benchmark harness). Two browser apps live under `apps/`. A Rust crate,
`crates/graphrag-core`, holds the start of a native engine.

## Glossary

- **Entity** — one independent memory ("brain") inside a database,
  identified by an `entityId` string. Many entities share one database.
- **Fact** — one stored unit of memory, with a title, body, confidence and
  a `source_type` saying how it got there.
- **Source type** — `immutable_document` (extracted from a document you
  ingested), `librarian_inferred` (synthesised from events),
  `user_stated`, `user_confirmed` (a person said or confirmed it).
- **Event** — one episodic record written with `write()`. Events are raw
  material; the librarian turns them into facts.
- **Librarian** — the maintenance pass that reads recent events and writes
  facts and tasks. Two strategies exist: `legacy` (add-only) and `ops`
  (add, supersede or skip, with a similarity gate).
- **Heal** — the maintenance pass that finds contradictions, downgrades
  stale claims and removes obsolete facts.
- **Ingest** — `ingestDocument()`: chunk a document, extract facts with
  the model, store them as immutable facts.
- **Seed** — loading an ontology manifest (node and edge types) into an
  entity before anything is written.
- **Ontology** — the per-entity set of allowed fact types and edge types.
  Mode is Strict, Emergent, or Off. A type may name one parent type;
  deeper inheritance is rejected.
- **OKF** — Open Knowledge Format, the interchange format the engine
  imports and exports. The `core-okf` package holds the primitives.
- **Draft** — a fact stored with `lifecycle_status = 'draft'` because a
  check did not pass. Drafts stay visible unless a read excludes them.
  `promoteDraft` makes one stable.
- **Grounding** — an opt-in check that asks a writer to quote its source
  and stores a fact as a draft when the quotes are missing or not found.
- **BYOI** — bring your own inference. You hand the engine one
  `generateText` function (and optionally `embed` and `classify`). The
  engine owns prompts, parsing and database writes; it never owns a key.
- **Diagnostic** — a typed, content-free report delivered through
  `onDiagnostic` when the engine drops something or a background job
  fails. It carries IDs, counts and reason slugs, never fact text.
- **Deferred maintenance** — `config.maintenance: 'deferred'`: `write()`
  only records the event, and nothing runs until the host calls
  `runPendingMaintenance` with a token budget and a deadline.
- **Adoption gate** — a measured condition (correctness, performance,
  parity) that must pass before the native crate replaces a TypeScript
  path in production.

## The rules

### 1. The engine never calls an AI service you did not hand it

Every model call goes through the `LLMProvider` you pass to `createWiki`.
The package ships no provider, no key handling and no network client of
its own. Search works without a model at all: when there is no `embed`
function, retrieval is keyword search in-process.

*(Scope note, added 2026-11-01 with PR #305: this rule governs the engine
packages — the libraries a host embeds. `packages/mcp-server`, the agent
door approved by Kurt VanDusen on 2026-11-01, is a credential-carrying
stdio server by design: it holds the user's SynapseTree API key, calls
the SynapseTree cloud API, and never embeds this engine or calls any
model.)*

*Why:* this is the charter's bring-your-own-inference promise, rendered
as code. The host decides where thinking comes from; the engine only
decides what to ask.

**Status: Built.** The only external runtime dependency of the core
package is the keyword-search library. Platform packages add only
first-party workspace packages plus the peer dependencies the host
already has (`expo-sqlite`, `expo-crypto`, `react`).

### 2. Your database stays yours

The engine writes only to tables under a prefix you choose (default
`llm_wiki_`) and never touches other tables. Schema migrations add
columns, tables and indexes; they never drop a column or a table that
holds your facts. A host can refuse to run a pending migration inside a
time-critical open (`setup({ migrations: 'refuse' })`) and run it later.

*Why:* the package is installed into someone else's database. The charter
says your memories stay yours in every sense; the smallest version of that
is "we don't rearrange your schema behind your back."

**Status: Built**, with two honest footnotes. Migration v2 dropped an
old full-text index table and its triggers (search index, not facts), and
v12 swapped one index for a better one. Migration v9 refuses to run, with
instructions, if it finds data that an older race condition could have
left inconsistent, rather than guessing which rows to keep.

### 3. One database, many memories, never mixed

Every read, write, traversal and maintenance pass is scoped to one
`entityId`. A graph write that tries to claim a node another entity owns
is rejected whole, before any row is written, with an error that names
nothing about the other entity. A dangling edge into another entity
resolves to an unreadable ID, never to that entity's content.

*Why:* the charter promises that memories are never mixed with another
customer's. In the cloud that is one file per tenant; in the package it is
entity isolation inside one file, because hosts do put many brains in one
database.

**Status: Built** (7.1.3, 2026-09-18). One boundary is the host's: a
custom vector-ranking adapter must filter by entity itself. `SECURITY.md`
says how.

### 4. Search bends, it does not break

If the embedding call fails, returns bad numbers, or the stored vectors
have a different dimension than the query (you switched embedding
models), `read()` falls back to keyword search over your facts' own words
and tells you it did (`onRetrievalFallback`). Facts whose vectors cannot
be used are flagged, and `runReembed()` converts them. Nothing is lost and
nothing is silently worse without a signal.

*Why:* the charter's "search bends instead of breaking" and its care
around embedding switches both land here.

**Status: Built.** Dimension mismatch is detected at read and at embed
time; the fallback, the callback, the mismatch count and `runReembed` all
exist.

### 5. Documents are immutable facts

A fact extracted by `ingestDocument()` is stored as `immutable_document`.
The librarian and heal never rewrite it, and the ops librarian refuses to
supersede it. It leaves only when you call `forget()` or re-ingest the
same source.

*Why:* a document is evidence. The engine may reason around it; it may
not edit it.

**Status: Built.**

**Planned** (owner ruling, 2026-11-13): the engine will also keep a
document's text as a *source*: stored as it is, searched with no model
call, and never rewritten. Until that ships, the host keeps the source
text. A pointer from each fact the librarian writes back to its source
is planned too (#377); today those facts carry none. This rule's text is
reworded in the pull request that ships the source store, not before.
See `docs/ROADMAP.md`, steps 3 and 4.

### 6. Honest reporting

Nothing is dropped silently. Every rejected chunk, rejected fact, dropped
edge and failed background job produces a typed, content-free diagnostic.
A fact that fails a check is stored as a draft, not thrown away. Health
checks (`lint`) report and never repair. Partial ingest failures return a
result with the failures listed; only a total failure throws.

*Why:* the host cannot fix what it cannot see, and a draft a person can
review is worth more than a silent rejection.

**Status: Built.** Diagnostics (7.x), draft review, grounding, `lint` and
`pendingSources` all ship. Diagnostics describe work that really
happened. Most are delivered after the transaction commits, and an
operation that throws before it commits delivers none. Some calls deliver
diagnostics and then still throw. `importDump` commits each entity in its
own transaction, so entities committed before the throw have delivered
theirs, and so may the entity that threw, if it threw after its own
commit. Ingest delivers its LLM-pass diagnostics when a duplicate-hash
race rolls back its write. `llm_usage` goes out as each model call
returns. A diagnostic delivered before a throw is still accurate.

### 7. Nothing spends your allowance invisibly

Every model call in a maintenance run draws from one token budget the
host can set. Usage is reported per call through a diagnostic when the
host asks for it, marked `estimated` when the provider did not report real
counts. In deferred mode nothing runs in the background, with one exception that makes no model call: after `setup()` the engine finishes removals from the host's vector index that the host already requested, when the host turns on `drainExternalDeletionsOnSetup` (off by default). The host decides when and how much.

*Why:* this is the charter's "no invisible spend" promise. Background work
that burns a user's allowance without saying so is the failure this rule
exists to prevent.

**Status: Built** (7.8.0, 2026-09-30, opt-in; the default from 8.0.0).
Kurt ruled on 2026-11-09 that 8.0.0 flips both defaults: `librarian.strategy`
to `'ops'` and `maintenance` to `'deferred'`. Hosts can restore either with
explicit configuration. See the 2026-11-09 amendment.
Amended 2026-11-11 (owner ruling): the "nothing runs in the background"
sentence gained one exception, the no-model drain of owed vector-index
removals after `setup()`. See the 2026-11-11 amendment and
`specs/durable-vector-removal/spec.md`.
Amended 2026-11-12 (owner ruling): that exception is opt-in. See the
2026-11-12 amendment.

### 8. A small, first-party, auditable dependency surface

The core package depends on one external library at runtime (keyword
search) and one first-party workspace package. The OKF and tools packages
have no runtime dependencies. Platform packages depend on first-party
workspace packages plus the peer dependencies the host supplies. The Rust
crate depends on four crates.
This is not "zero dependencies" and should never be described that way.

*Why:* the package is installed into other people's apps. Every
dependency we add is a dependency they inherit, and one they cannot
audit as easily as we can.

**Status: Built.** The earlier wording "zero runtime dependencies" that
appears in one 2026-09 spec is the overstated version of this rule.

### 9. The supply-chain gate is binding

No dependency version younger than 14 days enters the lockfile. Audit
fails the build on high-or-worse advisories unless the advisory is
allowlisted with a date-bounded expiry, which forces a revisit. Overrides
live in one place (`pnpm-workspace.yaml`). A version may be admitted early
only with a written waiver from Kurt recorded in that file with a date
and a reason.

*Why:* this repository's build pipeline is the one surface a consumer's
own gate cannot protect, because a library's lockfile never ships.

**Status: Built** (2026-09-16; waiver rule recorded 2026-10-29, one
precedent on file). Dependabot security updates bypass the cooldown by
GitHub's design; the manual override pattern is what keeps the gate
honest. Detail lives in the supply-chain spec.

### 10. Spec first, and status lines tell the truth

Behavior changes start with a spec, `specs/<name>/spec.md` (legacy
specs before 2026-11-01: `docs/superpowers/specs/`). Every
spec carries a Status line. The Status line is updated in the same pull
request that changes the behavior, never later.

*Why:* on 2026-10-29 a sweep found three specs whose features had shipped
weeks earlier with "implementation not started" still at the top. A
reader trusting those headers would have been wrong about the product.

**Status: Built.** All 75 specs carry a Status line; the three stale ones
were corrected 2026-10-29. The rule holds only as long as every PR keeps
it.

### 11. Benchmarks gate behavior changes

A change to retrieval or maintenance behavior is measured before it is
claimed. Accuracy or cost numbers are published only with the run that
produced them, naming the model, the judge, the slice and the caveats.
The native crate replaces a TypeScript path in production only after its
adoption gates pass.

*Why:* "faster" and "more accurate" are claims consumers build on. The
charter's equal-standing and no-invisible-spend promises both depend on
numbers that are real.

**Status: Partly built.** The benchmark harness exists and refuses to
spend tokens without an explicit flag. Supersession results for 7.8.0
versus 7.7.7 are published with caveats. LongMemEval accuracy and
tokens-per-answer are not measured yet; the first rerun attempt died to a
benchmark-CLI shutdown bug, fixed in 7.8.0 (#247), and has not been
re-run. The native crate's performance gate is scaffolded
and has never been run. **Open decision:** when the native engine's gate
runs and who schedules it.

## Out of scope (don't build these here)

- A hosted service inside the package. The cloud door is SynapseTree's
  repository; this one ships code that runs in the host's process.
- A bundled model, a default provider, or key storage. See rule 1.
- An external graph database. Graph retrieval runs on SQLite with one
  recursive query, and stays that way.
- Flipping the ops-librarian or deferred-maintenance defaults in any
  release before 8.0.0. The ruling is made (2026-11-09); it lands only
  with 8.0.0. See rule 7.
- Routing production reads through the native crate before its adoption
  gates pass. See rule 11.
- Prompt-injection defense inside the engine. User text is interpolated
  into prompts verbatim; the host owns that boundary, and `SECURITY.md`
  says how.
- A benchmark that touches a live user database. Benchmarks open fresh
  in-memory or cache-directory SQLite files only.

## How changes are made

1. **Spec first.** Write `specs/<name>/spec.md` from an investigation that
   reads the real code, with a spec Status (Draft → Reviewed →
   Implemented); investigation notes go in the spec's evidence section.
   Open a draft PR carrying the folder; add `plan.md` and
   `LEDGER.md` to the same PR once the spec is Reviewed; implement on the
   same branch; the final cleanup commit flips the Status to Implemented
   and deletes the plan and ledger. One PR per cycle, no spec-only merges.
   `specs/README.md` has the mechanics. The Status line changes in the
   same PR as the behavior.
2. **Review, then merge.** CI green (build, typecheck, tests, both audit
   steps, the Rust job). Reviews run in tiers; an unresolved review
   question holds the PR rather than being deferred silently.
3. **Merge commits, never squash.** Every PR into `main`, including the
   automated release PRs, merges as a merge commit (`release.yml` uses
   `gh pr merge --merge`; see issue #137). Squashing breaks release-tag
   reachability and the spec-then-code commit record.
4. **Releases are automated.** semantic-release computes the version from
   conventional commits in two phases. Nobody edits `CHANGELOG.md` or any
   `"version"` field in a PR. A `BREAKING CHANGE` footer publishes a major;
   do not write one without a ruling.
5. **Benchmarks gate behavior changes.** Retrieval and maintenance changes
   are measured on scratch stores with the harness in `packages/benchmarks`
   before numbers are claimed. Native-engine routing waits for its gates.
6. **Supply chain.** Lockfile changes go through the 14-day gate with
   pnpm 10.33.2; never set the gate to zero. Build-time tooling majors may
   ride a grouped bump after a pack-diff of the published type
   declarations; runtime and peer majors get their own PR. Early
   admission needs Kurt's written waiver in `pnpm-workspace.yaml`.
7. **Changes to this file** go through the same review as code, with a
   dated note of what changed and why. Anything that would change a
   charter promise is a charter amendment first, not an edit here.

## Amendments

- 2026-11-13 — Kurt rules that 9.0.0 removes the `handoff` and
  `session_recap` node types, the `handoffFor` edge rows, and
  `prompts.librarianSystemPrompt`, and nothing else; recorded with
  issue #376, PR #380 and `specs/statement-kinds/`. Why: session records
  become working memory that is searched as it is, and outside adoption
  is close to zero, so a clean break costs least now. No rule text
  changed.
- 2026-11-13 — Rule 5 gains a Planned note, and `docs/ROADMAP.md` is
  added. The owner ruled that memory has a Sources layer: the original
  material, searched as it is, beside what the librarian extracts from
  it. For now the host keeps source text. Two things are planned and
  not built: a pointer on each fact the librarian writes (#377, roadmap
  step 3) and a source store in the engine (roadmap step 4).
  Why: a document that can only be found after a model has turned it
  into facts costs tokens and loses detail, and a fact with no trail to
  its source cannot be checked. The roadmap is new: it carries the
  planned order of work, and no status. Owner rulings, 2026-11-12 and
  2026-11-13. No rule text changed.
- 2026-11-12 — Rule 7's one background job in deferred mode (the
  2026-11-11 entry below) is now off by default. Hosts turn it on with
  `drainExternalDeletionsOnSetup: true`. Why: the drain's short
  transactions share the host's connection, and a transaction the host
  opens on that connection itself throws while one of them is open. The
  engine can't serialize transactions it doesn't own. Owed removals are
  still recorded and still delivered by `runPendingMaintenance()`,
  `runExternalDeletions()`, `forget()` and prune. Owner ruling,
  2026-11-12; recorded with `specs/durable-vector-removal/`.
- 2026-11-11 — Rule 7 allows one background job in deferred mode: after
  `setup()`, the engine finishes removals from the host's vector index that
  the host already requested through `forget()`, prune or the other delete
  paths. It makes no model call and spends no tokens. It runs only when a
  removal hook is configured, or when the index is marked decommissioned
  (`forceDeleteIgnoreRankerHook`), in which case it only discards; it is not awaited by `setup()`, stops after 10
  seconds, and hosts turn it off with `drainExternalDeletionsOnSetup: false`.
  Why: charter rule 8 promises deletion, and a delete the host's index never
  heard about is not done; retrying only when the host asks leaves it undone
  after a crash. Owner ruling, 2026-11-11; recorded with
  `specs/durable-vector-removal/`.
- 2026-11-11 — Rule 6's Status no longer says an operation that throws
  delivers no diagnostics. `importDump` commits each entity separately;
  ingest's duplicate-hash path and `llm_usage` also deliver diagnostics
  before a throw. Why: those diagnostics describe work that really
  happened, and hiding them would break rule 6. The diagnostics guide
  carries the per-operation detail. No rule text changed.
- 2026-11-09 — Kurt rules that 8.0.0 flips `librarian.strategy` to `'ops'`
  and `maintenance` to `'deferred'` and removes the deprecated `wiki_*`
  tool names (#324); recorded with `specs/release-8-0-0/`. Why: the owner's
  goal is to release 8.0.0, and `'deferred'` makes "no invisible spend" the
  default. The flips were ruled **without benchmark evidence**: LongMemEval
  remains unrun by the owner's choice, and rule 11 still binds, so no
  accuracy or cost claim about the new defaults may be published until it
  is measured. Rule 7's Status and the out-of-scope line are updated; no
  rule text changed.
- 2026-11-02 — PR #323 lands the deferred `mcp-server` release wiring and
  deletes that cycle's `plan.md`/`LEDGER.md`, ending the 2026-11-01
  keep-past-merge exception. Why: the wiring PR they were kept for is
  #323. The package list drops the "gated before its first npm publish"
  qualifier on `mcp-server`. No rule text changed.
- 2026-11-01 — PR #305 adds the `mcp-server` agent door (rule 1 scope note,
  package list). The three §3 release-wiring edits are deferred to a
  follow-up PR by owner ruling until the spec §0 gates close, and the
  cycle's `plan.md`/`LEDGER.md` stay in the folder past merge so the
  wiring PR resumes from them. Why: the gates block any publish, and
  merging the wiring early would risk one. No rule text changed; the
  scope note under rule 1 carries the detail.
- 2026-11-01 — Spec cycles move to one folder each under `specs/<name>/`
  (`spec.md`, `plan.md`, `LEDGER.md`), the pattern ruled 2026-10-23;
  "Below it", "How changes are made" step 1, and rule 10's location
  pointer updated. Step 1 now requires one PR per cycle; spec-only merges,
  previously allowed, are no longer allowed. Why: the plan and ledger live
  and die in the same PR as the spec, and tracked, resumable plans and
  ledgers replace gitignored plans. Legacy specs and plans under
  `docs/superpowers/` are not migrated. No rule or Status changed.
- 2026-10-29 — Initial version. Authored by Fable from the Tessera
  research dossier; every Status checked against the code that day
  (evidence: `docs/superpowers/INTENT-NOTES.md`). Open decisions on
  record: 8.0.0 ops/deferred-maintenance defaults; native-engine gate
  scheduling.
