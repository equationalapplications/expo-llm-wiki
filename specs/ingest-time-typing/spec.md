# Spec — Step 14: Ingest-time typing

**Status:** Reviewed (owner-approved 2026-11-23; all open-question defaults accepted)
**Date:** 2026-11-23
**Intent check:** Rule 1 (the classifier is the host's `llmProvider.classify`;
core adds no provider, key or network client). Rule 2 (no schema change:
`okf_type` already exists on every row; nothing is dropped or rewritten).
Rule 5 (a document fact is *born* typed, as the generative path already
makes it today; its title, body, evidence and source stay as extracted —
typing at insert is creation, not an edit; §7 carries the evidence that the
engine already stamps `okf_type` on `immutable_document` rows through the
backfill). Rule 6 (every typing outcome gets a typed, content-free receipt
through the ingest buffer; nothing is dropped silently). Rule 7 (the
classify calls are exactly as metered as the generative chunk calls beside
them — `ingestDocument()` is a host call with no maintenance budget; every
call is reported through `llm_usage` when the host asks; §6 says so plainly
and opens the budget question for the owner). Rule 8 (no dependency). Rule
10 (this spec, Status line updated in the PR that ships it). Rule 11 (no
accuracy or cost claim; three disclosures carried over from step 13, sharper
for documents). Rule 12 (`ingestDocument` creates facts and moves none
between states; unchanged). The roadmap section's guarantees hold: the site
runs only when the host opts it in; a host that opts nothing in gets
byte-for-byte today's ingest prompts and writes; spend is visible; output
is validated before it reaches memory; every decision is receipted and
counted.

Base: `spec/type-on-write` @ `aea7abaa` (step 13, PR #471, approved, about
to merge into `main` after v9.14.0). Every pin below is verified live
against that commit in the worktree `expo-llm-wiki-step14`. Roadmap step 14
(`docs/ROADMAP.md:308-314`); gate "step 13 merged, and a spec" — step 13 is
approved and merging; this spec is the second half.

## Problem

`ingestDocument()` types a document's facts only if the generative model
types them in the same breath. When the entity's ontology mode is not
`'off'`, `IngestionService.ingestDocument` hoists one write context
(`buildWritePromptContext(entityId, { engaged: false })`,
`packages/core/src/services/IngestionService.ts:183`), `buildIngestPrompt`
appends the manifest block and typing instructions to every chunk's system
prompt (`services/PromptService.ts:185-203`, text from
`prompts/ontology.ts:45-84`), the model may answer `okf_type` and `edges`
per fact, and `validateAndNormalizeFact` resolves the slug at insert —
full path `IngestionService.ts:903`, then again at the door
`upsertGraphCore` `:656`; partial path `:1088`. A miss stores the fact
untyped (`:698`, `:1125`), and the fact waits for the `ontologyBackfill`
maintenance pass, whose pool is `okf_type IS NULL AND deleted_at IS NULL`
with no `source_type` filter (`repositories/EntryRepository.ts:1805-1819`)
— so document facts already get typed later, by the engine, in a pass the
host schedules.

Step 13 built the classifier write door for the librarian and left ingest
on the generative path by design: "Ingest passes `engaged: false` in this
step (byte-identical prompt; step 14 flips it)" (`specs/type-on-write/spec.md:338-339`,
§13 "The step-14 seam"). The roadmap's step 14 reads: "`ingestDocument()`'s
extracted facts get typed through the step 13 mechanism instead of the
write-time one, completing the typing story for the document path"
(`docs/ROADMAP.md:310-312`). Resolving "the write-time one" against step
13's Problem statement ("A fact the librarian writes is typed only if the
generative model types it in the same breath") gives one coherent reading:
today's mechanism — the generative model typing inline from a manifest in
the prompt — is what the document path leaves behind; the step 13
mechanism — the host classifier asked one `choice` question per fact
before the transaction, validated, floored, receipted — is what it gains.
Open question 1 asks the owner to confirm that reading; the rest of this
spec is written under it.

Everything ingest needs is already site-independent in
`packages/core/src/services/typing/typeOnWrite.ts`: the engagement
predicate (`canEngageWriteTyping`, `:48-58`), the question
(`buildTypingQuestion`, `:66-75`), the metered classify step taking
`ctx.operation` so ingest can pass `'ingest'` (`classifyFactsForWrite`,
`:116-155`; `TypingCallContext.operation` docstring at `:97`), the counters
(`:158-188`), the receipt mapping (`:196-215`) and the shared door
normalization (`normalizeForWrite`, `:243-303`). Ingest imports none of it
today (`IngestionService.ts:1-25`).

## Root cause (with evidence)

- **The ingest door has no classifier step.** `callClassify` is imported by
  the typing module and the backfill only; `IngestionService.ts` calls
  `callLlm` once per chunk (`:217`) and nothing else.
- **The seam is in place and pinned.** `buildWritePromptContext(entityId,
  { engaged })` returns `null` when engaged (`services/OntologyService.ts:97-105`),
  and `buildIngestPrompt`'s null-context branch strips placeholders and
  appends nothing (`PromptService.ts:160-183`, `:185-203`). The `engaged:
  false` constant at `IngestionService.ts:183` is the only thing that keeps
  the manifest in the ingest prompt. `getInstructions` forces the same
  constant for the `ingest` entry (`WikiMemory.ts:735-737`).
- **The pre-transaction seam exists.** Pass 1 and Pass 2 (`:306-367`) settle
  the cross-chunk winners into `orderedChunkFacts` and `factLedger` (keyed by
  fact object identity); the total-failure throw follows (`:383-389`); the
  transaction opens after (`:397`, `:420`). Model calls never run inside a
  transaction anywhere in the engine; this spec keeps that.
- **Both write paths normalize per fact with the in-transaction manifest.**
  Full: `runFullUpsertGraph` reads state in the tx (`:864-866`), merges
  emergent updates per slot (`:880-887`), normalizes each fact (`:903`),
  hands `type: ontologyFact.okf_type ?? ''` to `upsertGraphCore` (`:914`),
  which normalizes again and emits the door receipts
  (`:656-676`). Partial: `appendPartialFacts` reads state in the tx (`:1037`),
  normalizes (`:1088`) and emits its own door receipts (`:1093-1103`). The
  comment at `:908-910` pins that the full path's receipts fire only in
  `upsertGraphCore` ("the pinned duality"); §4 keeps that true by feeding
  the core a canonical-or-empty slug.
- **One gate reads the prompt context as a proxy for the mode.** The
  `ingest_zero_facts` receipt fires when `ontologyContext !== null`
  (`:405`). Under engagement the write context is `null` while the mode is
  not `'off'`, so without a fix the receipt would stop firing for engaged
  entities. §4 replaces the proxy with the mode.
- **`ingestDocument` carries no meter.** `callLlm` at `:217` passes no
  `meter`; the per-chunk generative calls are unmetered. `WikiBudgetExhausted`
  cannot be thrown on this path. The only spend channel is `llm_usage` per
  call under `reportLlmUsage` (`utils/llmCall.ts:107-115`, `:107-118` for
  classify).
- **Concurrency is a call parameter here, not only config.** The ingest
  call resolves `params.chunkConcurrency ?? config.chunkConcurrency ?? 1`
  (`:137-138`); `classifyFactsForWrite` reads `options.config.chunkConcurrency`
  only (`typeOnWrite.ts:124-125`). The step needs the resolved value.
- **The result type widens by precedent.** `IngestDocumentResult`
  (`types.ts:1634-1648`) documents that it "WIDENS relative to earlier
  versions"; hosts destructuring named fields see no change. It is the
  natural carrier for ingest-side typing counters; no scheduler report is
  involved because `ingestDocument` is not a maintenance unit
  (`MaintenanceScheduler.ts:168-303` runs librarian, heal, backfill, reembed).
- **The step 13 key is documented as librarian-only.** `systemOne.typeOnWrite`'s
  docstring (`config/systemOne.ts:62-73`), the configuration reference
  ("Librarian only", `apps/docs/.../reference/configuration.md:105`) and the
  guide ("It applies to the librarian only", `guides/ontologies.md:221`) all
  say so, by step 13 OQ8's ruling, which left widen-vs-sibling to this step.
- **Document facts are backfill-typed today.** The backfill pool has no
  `source_type` filter (`EntryRepository.ts:1810-1816`) and `updateOkfType`
  stamps any live untyped row (`:1844-1851`). The engine already sets
  `okf_type` on `immutable_document` rows after the fact, under rule 5 as
  written. Typing at insert is strictly earlier than that.

## Proposed change

### 1. Opt-in key `systemOne.typeOnIngest: 'auto' | 'llm'` (sibling, not widening)

Add to `SystemOneConfig` (`systemOne.ts`, beside `typeOnWrite`):

```ts
/**
 * Ingest-time typing for `ingestDocument()`. `'llm'` (default) keeps today's
 * ingest path exactly: every chunk prompt carries the ontology block and the
 * model types each fact inline, or leaves it for backfill. `'auto'` asks
 * `llmProvider.classify` to type every extracted fact the call is about to
 * insert, and the ontology block leaves the ingest prompt for that call (§5).
 * The classify calls are as metered as the call's generative chunk calls:
 * `ingestDocument()` carries no token budget (§6). Facts the classifier does
 * not type are written untyped exactly as today and stay eligible for
 * backfill. Engages only when a classifier is present and the manifest is
 * representable (§2). Facts typed this way carry no manifest-drawn edges
 * (§10). Independent of `typeOnWrite`. There is no `'off'`.
 */
typeOnIngest?: 'auto' | 'llm';
```

Resolution: `resolveSystemOneTypeOnIngest(config)` in `engineDefaults.ts`,
`config?.systemOne?.typeOnIngest ?? 'llm'`; a present invalid value warns
once through `warnOnce` and is treated as unset — the S1-0 §2 contract,
mirroring `resolveSystemOneTypeOnWrite` (`engineDefaults.ts`, the block
right after `resolveSystemOneHealScreen`) verbatim. `??`, never `||`. No call option on
`ingestDocument` (a config-level stance, like every other System-One site).
No `'off'`: `'llm'` is today's path.

No new member joins `SystemOneThresholdSite`. The ingest site reads the
existing `'typing'` floor through `resolveTypingMinConfidence`
(`engineDefaults.ts:225-245`), as step 13 OQ1 ruled for the librarian door:
one floor governs "the classifier assigns a node type" wherever that
happens. The `systemOne.ts` fence comment (`:2-13`) names `typeOnIngest` as
landed with no member change.

**Why a sibling and not widening `typeOnWrite`** (step 13 OQ8, deferred
here; Open question 2): the roadmap section's first guarantee is "a site
runs only when the host opts it in", and every System-One key so far is one
site (`typing`, `edges`, `resolve`, `healScreen`, `typeOnWrite`). Ingest is
a different door with a different cost shape (one call per extracted fact
across every chunk of a document, with no budget) and a sharper
extraction-quality exposure (the ontology block is the document
extractor's guide). Widening would also change ingest prompts and writes
for any host that already set `typeOnWrite: 'auto'` under docs that said
"Librarian only", without that host touching its config — the one upgrade
behavior this section forbids. The price is one more key; a host that
wants both sets both.

### 2. Engagement predicate (resolved once per `ingestDocument` call)

Ingest-time typing is **engaged** for a call when all of:

1. `resolveSystemOneTypeOnIngest(config) === 'auto'`;
2. `typeof options.llmProvider.classify === 'function'`;
3. the entity's effective ontology mode is not `'off'`
   (`ontologyService.getEffectiveState(entityId)`, outside any transaction,
   cached);
4. the manifest is representable (`isManifestRepresentable`,
   `typeOnWrite.ts:36-41`).

`canEngageWriteTyping` (`:48-58`) is refactored into a shared
`typingEngages(site: 'auto' | 'llm', provider, mode, manifest)` with two
thin named callers, `canEngageWriteTyping` (unchanged signature and
behavior, so the librarian strategies, `getInstructions` and the step 13
tests are untouched) and `canEngageIngestTyping(config, provider, mode,
manifest)`. Conditions 2–4 cannot drift between the three sites.

The check runs at the hoist (`IngestionService.ts:177-183`): after the
duplicate-hash early returns and the empty-chunk return, before any model
call. `ontologyService` absent → not engaged. When any condition fails the
call runs exactly as today: today's appendix, no classify call, no new
receipt, no counters. A failing condition emits nothing (same posture as
step 13 §2 and the backfill).

### 3. Where the step sits, and which facts it asks about

One new pre-transaction stage, between the total-failure throw (`:383-389`)
and the transaction (`:394`). It takes the kept winners and returns one
outcome per asked fact, keyed by fact object identity (the same key
`factLedger` uses, `:37-38`), so both write paths read the same map. It
makes no database write.

- **Candidates:** every fact in `orderedChunkFacts` — the cross-chunk
  winners after Pass 2 — whose raw `okf_type` does not already resolve
  against the pre-transaction manifest (`volunteeredTypeResolves`,
  `typeOnWrite.ts:105-107`; the §3 skip rule of step 13: a valid
  model-supplied slug stands, `writer: 'llm'`). Losers of the title dedupe
  are never asked: typing runs after dedupe, so no call is spent on a fact
  that will not be written (Rejected alternatives: per-chunk typing).
- **Wasted calls, disclosed:** on the partial path, a winner whose
  normalized title already exists among the live rows for the `sourceRef`
  is skipped in the transaction (`:1060-1071`) after its classify call was
  spent. In `'emergent'` mode an in-transaction merge could make a raw slug
  resolve that did not resolve pre-transaction; the classifier's answer for
  that fact is then unused (the first normalization wins, step 13 §4). Both
  mirror step 13's disclosed waste; neither is reproduced before the
  transaction (drift hazard).
- **When nothing is asked:** total failure throws `WikiIngestEmptyError`
  before this stage, so a document whose every chunk failed spends no
  classify call. Zero winners → no calls, counters all zero.

The call is `classifyFactsForWrite(options, ctx, asked, manifest, floor)`
with `ctx = { entityId, trigger: 'call', operation: 'ingest', meter:
undefined }` and `floor = resolveTypingMinConfidence(config)`. The function
gains one optional trailing argument, `opts?: { concurrency?: number }`
(additive; the librarian passes none and keeps today's config read), and
ingest passes the call's resolved `chunkConcurrency` (`:137-138`) so a
host's per-call knob governs the classify fan-out as it governs the chunk
fan-out. Outcomes, validation order, sentinel-before-floor and the
`'typing'` floor are step 13 §3 and §7 verbatim: `accepted`, `abstain`,
`low_confidence`, `invalid`, `threw`, `overflow_skip`; `unattempted` is
unreachable here (§6) and stays in the union.

### 4. How an accepted type reaches the row

Both write paths switch their per-fact normalization to the shared
`normalizeForWrite(ontology, fact, manifest, mode, outcome, base, factId)`
(`typeOnWrite.ts:243-303`), the function the librarian door already uses.
Its contract is step 13 §4: the first normalization is today's; when it
misses and the classifier accepted a type, the row is normalized a second
time with `{ ...fact, okf_type: accepted, edges: [] }` against the
**in-transaction** manifest; `edges: []` is deliberate (no mixed
provenance, step-10 OQ6; the manifest-drawn edge pipeline is §10's
disclosure); mode `'off'` in the transaction means the classifier's type is
not applied; a slug that no longer resolves in-transaction stores the fact
untyped and surfaces as the door's own `node_type_dropped`.

- **Full path** (`runFullUpsertGraph`, `:899-947`). The per-fact
  `validateAndNormalizeFact` + `edgeDropDiagnostic` block (`:903-907`)
  becomes one `normalizeForWrite` call with `base = { entityId, operation:
  'ingest', trigger: 'call' }` and the minted `factId`; its `drops` go
  through `edgeDropDiagnostic` as today and its `receipts` are pushed with
  `sourceRef` added to `detail` (the shape every ingest door receipt
  already has, `:671-674`). `hostNodes[].type` becomes the **canonical or
  empty** slug (`normalized.okf_type ?? ''`) instead of the raw model slug.
  Consequence for the pinned duality (`:908-910`): `upsertGraphCore`'s
  `nodeTypeReceipts` (`:663-676`) now sees an exact match or an empty
  supplied type for every ingest node and emits nothing for the model door;
  the person door (`WikiMemory.upsertGraph`, `:1321`) is untouched and keeps
  its receipts there. The receipts a default host sees are the same codes
  with the same details, produced one frame earlier; Test plan 1(c) pins
  that. The comment at `:908-910` is rewritten to say so. `titleIndex` and
  `rawEdgeRequests` (`:942-946`) read the same `normalized`, so a
  classifier-typed fact enters the title index typed (and may be an edge
  target in the same ingest) and stages no outgoing edges.
- **Partial path** (`appendPartialFacts`, `:1086-1103`). The
  `validateAndNormalizeFact` + `nodeTypeReceipts` block becomes the same
  `normalizeForWrite` call; receipts pushed with `sourceRef`; `okf_type`
  stored from `normalized.okf_type` (`:1125`) as today.
- **`typing.typed`** increments where `normalizeForWrite` reports
  `typedByClassifier`, on either path.
- **`ingest_zero_facts` gate** (`:405`): `ontologyContext !== null` becomes
  `hoistedState.mode !== 'off'`, where `hoistedState` is the
  `getEffectiveState` read the engagement check already made. Under the
  default the two are equivalent (the write context is `null` iff the mode
  is `'off'` when not engaged), so the receipt's behavior is unchanged for
  every host that does not opt in; under engagement it keeps firing.

A fact with any non-accepted outcome is inserted exactly as today: untyped,
**without** an `ontology_checked_at` stamp (step 13 OQ2 ruling carried
over), so it is eligible for the next backfill pass at once.

### 5. The manifest leaves the engaged ingest prompt

The hoist at `:183` becomes `buildWritePromptContext(entityId, { engaged })`.
When engaged it returns `null`, and `buildIngestPrompt` takes its existing
null-context branch (`PromptService.ts:185-203` via `:160-183`): the system
prompt is, byte for byte, the ingest prompt that entity would get with
ontology mode `'off'` — guidance and grounding included, in place. A runtime
`promptOverride` or configured `ingestSystemPrompt` carrying
`{{ontologyManifest}}` / `{{ontologyModeInstructions}}` has its placeholders
stripped exactly as the null-context branch does today (`:147-156`). Nothing
new is written into any prompt. Consequences:

- The manifest's tokens leave every chunk's generative prompt. `maxChunkLength`
  and chunking are character-based (`:130`, `:174`) and unchanged; the
  prompt is simply shorter. A consequence, not a claim (rule 11).
- The model receives no `okf_type`/`edges` schema and no `ontology_updates`
  invitation (`prompts/ontology.ts:50-62`); §10 discloses both.
- `getInstructions(entityId).ingest` (`WikiMemory.ts:735-737`) reflects
  engagement: it evaluates `canEngageIngestTyping` for the entity and
  passes the matching write context, so what the host reads is what the
  call sends. `librarian`, `heal` and `ontologyBackfill` are unchanged.

Under `'llm'` (default) the hoist passes `engaged: false` as today and every
ingest prompt is byte-identical (Test plan 1).

### 6. Budget and metering: a host call, not a maintenance pass

`ingestDocument()` is a host verb. It is not a `runPendingMaintenance` unit,
carries no `UsageMeter`, and its generative chunk calls are unmetered today
(`:217`). This step keeps that posture and makes it explicit:

- The classify calls pass `meter: undefined`. They are exactly as metered as
  the generative calls beside them: not at all. `WikiBudgetExhausted` is
  unreachable on this path; `typing.unattempted` is always `0` here and the
  field stays for shape parity with the librarian's counters.
- **Visibility (rule 7's substance).** Every classify call is reported
  through `llm_usage` with `operation: 'ingest'`, `trigger: 'call'`, when
  `reportLlmUsage` is on (`llmCall.ts:107-115`), `estimated: true` when the
  provider returned no counts — the same channel the chunk calls use. The
  host opted the door in and sees each call it buys.
- **Spend shape, disclosed, no number.** At most one classify call per
  kept winner fact whose slug did not resolve, so a document's typing spend
  scales with the facts the model extracted, not with its chunks. A host
  that needs a ceiling bounds the document it hands in; the engine offers no
  budget on this call in this step (Open question 3).
- **Issue #475 (meter checked before, charged after; N−1 overshoot under
  concurrency).** The overshoot is a property of `UsageMeter` pre-flight;
  with no meter there is nothing to overshoot, so #475 does not apply to
  the ingest site as specified. The disclosure carries over as a
  conditional: if Open question 3 ever adds a `tokenBudget` to
  `ingestDocument`, the classify fan-out under `chunkConcurrency` inherits
  #475 verbatim and that spec must say so. The docs state this in one
  sentence beside the librarian's #475 note.
- **Context budget resolver:** untouched, as in step 13 §6. A context
  overflow from `classify` is `overflow_skip`, receipted as
  `context_overflow_skipped { factId, sourceRef }`, written untyped.
- **Deadline:** none exists on `ingestDocument`; nothing to disclose.

### 7. Rule 5: a document fact is born typed; nothing is edited

Rule 5 says the librarian and heal never rewrite a document fact and the ops
librarian refuses to supersede it; it leaves only on `forget()` or
re-ingest. Typing at insert touches none of that:

- The row is created with `okf_type` set, by the same `entryRepo.upsert`
  that creates it today (`:786`, `:1128`). Title, body, tags, confidence,
  `source_type: 'immutable_document'`, `source_ref`, `source_hash`,
  grounding trust and evidence handling are unchanged. Rule 12 already
  says `ingestDocument` creates facts and moves none between states; a
  typed creation is still a creation.
- The generative path types document facts at insert today
  (`:656-659`, `:1088`); this step changes which model answers the typing
  question, not whether a document fact may carry a type.
- The engine already stamps `okf_type` on `immutable_document` rows after
  insert through the backfill (`EntryRepository.ts:1805-1819`, `:1844-1851`;
  no `source_type` filter) — under rule 5 as written since the backfill
  shipped. `okf_type` is engine-maintained classification metadata, not
  document content.
- No INTENT amendment is needed (Open question 4 asks the owner to
  confirm). The rule-5 text is not touched by this PR.

### 8. Validation before memory; low confidence; abstain

Step 13 §7 verbatim, at the ingest door: `validateClassifierAnswer`, the
sentinel check, the `'typing'` floor, then the in-transaction
`resolveNodeTypeMatch` inside `normalizeForWrite`. Nothing the classifier
returns reaches a row without passing all four. Low confidence and abstain
write the fact untyped and unstamped with the outcome's receipt;
`onLowConfidence` is **not** read at this site (the backfill pass is the
generative second opinion, and ingest has no generative typing step of its
own to escalate to — adding one would put a backfill-shaped prompt back
into the ingest path). The configuration reference's `onLowConfidence` row
names the ingest site beside the write site.

### 9. Receipts and counters

Per-fact receipts, `operation: 'ingest'`, `trigger: 'call'`, pushed into the
call's `DiagnosticBuffer` and flushed after commit (`:478`), so a receipt
always names a committed row. `detail` carries `factId` plus `sourceRef`
(the ingest door convention, `:671-674`, `:1101`); chunk and item locators
are **not** added (Open question 6 — the existing door receipts carry
`sourceRef` only, and the grounding receipts that carry locators do so
because they describe a response position). **Zero new diagnostic codes**;
the table is step 13 §8's:

| Outcome | Code | `detail` |
|---|---|---|
| accepted and stored | `node_type_assigned` | `{ factId, sourceRef, okfType, writer: 'classifier', confidence }` |
| accepted, slug missed the in-tx manifest | `node_type_dropped` | `{ factId, sourceRef, nodeType, reason: 'not_in_manifest' }` |
| abstain | `classification_abstained` | `{ factId, sourceRef, writer: 'classifier' }` |
| low confidence | `classification_low_confidence` | `{ factId, sourceRef, reason: 'below_threshold' }` |
| invalid answer | `classification_invalid` | `{ factId, sourceRef, reason }` |
| `classify` threw | `classification_invalid` | `{ factId, sourceRef, reason: 'classify_threw' }` |
| context overflow | `context_overflow_skipped` | `{ factId, sourceRef }` |

Receipts fire only while the in-transaction mode is not `'off'`
(`shouldEmitOntologyReceipt`, inside `normalizeForWrite`). Volume: one per
asked fact, never a summary.

**Generative-typed facts at the ingest door** (Open question 5,
recommended yes, step 13 OQ4 precedent): `normalizeForWrite` emits
`node_type_assigned { factId, sourceRef, okfType, writer: 'llm' }` for a
fact whose model-supplied slug resolved, in every `typeOnIngest` mode. This
completes the typing audit (`node_type_dropped` / `node_type_folded` /
`node_type_assigned` joined on `factId`, `specs/ontology-curation` §4) at
the second model door, and is the one disclosed default-host delta of this
spec (§12): a new `info` diagnostic, not a prompt or write change. (The
`'inherited'` writer value reserved by ontology-curation is not emitted
here; its emitter is still the supersede edge-copy path, not ingest.)

**Duplicate-hash race.** When the write loses the race and rolls back
(`:427-473`), the buffer flushes only `LLM_PASS_DIAGNOSTIC_CODES` (`:51`,
`:455`). Every typing receipt carries a `factId` minted inside the aborted
transaction and is dropped by that rule (#221) — correct, since the row
does not exist. The classify calls did run and the host paid; their
`llm_usage` went out as each returned, and that is the honest record.
Counters are not returned on that path (the call throws or returns
`zeroChunkResult`).

**Counters.** `IngestDocumentResult` (`types.ts:1641-1648`) gains one
optional field, `typing?: TypingCounters`, present only when §2 engaged,
with the seven fields the librarian's counters carry (`asked`, `typed`,
`abstained`, `lowConfidence`, `invalid`, `skipped`, `unattempted`;
`typeOnWrite.ts:158-166`). `TypingCounters` becomes a public export (it
rides `export * from './types'` after moving the interface to `types.ts`,
with the typing module re-importing it — a type move, no behavior).
`zeroChunkResult` carries none. No change to `chunks`, `ingestedChunks`,
`failedChunks`, `parseFailures`, `duplicateOf`. No `EntityMaintenanceReport`
or `PendingMaintenance` change: ingest is not a scheduler unit, and
`typedOnWrite` stays the librarian's number.

### 10. Disclosures the roadmap demands, sharpened for documents

**No manifest-drawn edges — and ingest is where document edges come from.**
A fact typed by the classifier at ingest carries **no** outgoing edges: no
edge question is asked (step 10's screen is backfill-only), the engaged
prompt carries no manifest so the model proposes none, `edges: []` is
forced on the second normalization, and because a typed fact never
re-enters the backfill pool, backfill never adds outgoing edges to it
later. Today the ingest full path's two-pass title-index resolution
(`:843-967`) is the main producer of edges between a document's own facts
and from them to prior facts; under engagement that production stops for
the classifier-typed facts of that call. They can still be edge *targets*
(title index and shortlist pool, `okf_type IS NOT NULL`,
`EntryRepository.ts:1878-1896`) — including, within the same ingest, for
sibling facts the model typed itself. The docs say this in the opt-in's own
paragraph: a host that wants within-document edges keeps `typeOnIngest:
'llm'`.

**Extraction-quality risk, sharper than the librarian's.** The ontology
block is the document extractor's guide to what counts as a fact; when
engaged, the model extracts every chunk without it. Whether it extracts
the same facts is **unmeasured**; the exploratory benchmark that would
measure it was removed from the step list (`docs/ROADMAP.md:342-345`) and
the docs disclose instead: the engine makes no claim; a host compares
extraction on its own documents, with its own model, before and after
(rule 11).

**Cost profile, unmeasured.** Shorter chunk prompts, plus one classify call
per extracted fact (including the wasted calls §3 discloses), with no
budget. Net cost may go either way; no number is claimed.

**Emergent proposals.** While engaged, ingest sends no `ontology_updates`
invitation, so no new types are proposed from documents for that call
(`:880-887` sees none); the backfill's generative path still proposes
(Open question 7; step 13 OQ3 precedent).

### 11. Interactions

- **Backfill:** a classifier-typed document fact is never a candidate
  (`okf_type IS NOT NULL`); a declined one is eligible at once (no stamp).
  Under `typing: 'auto'` the backfill asks the same question again, once,
  and stamps; disclosed as in step 13 §11.
- **Re-ingest of the same `sourceRef`:** the full path supersedes the prior
  rows (`:772-773`) and types the new ones fresh; nothing is re-typed in
  place. `okf_type` on the retired rows is untouched (they are
  soft-deleted whole).
- **Partial path and retry:** partial rows are typed by the same stage;
  a later full retry supersedes them with freshly typed rows (§6 of the
  curation spec). The dedupe-skip waste is disclosed (§3).
- **Step 13 (`typeOnWrite`):** independent key, independent site; both can
  be `'auto'`. `getInstructions` reflects each separately. Shared module,
  shared floor, shared question text.
- **Step 10 (edges):** backfill-only; §10. **Step 11 (resolve):** librarian
  only; untouched. **Step 12 (heal):** untouched; heal reads `okf_type`
  nowhere.
- **`upsertGraph` (person door):** never classifier-typed; the host supplies
  types. `upsertGraphCore`'s receipts keep firing for it (§4).
- **Source store (step 4) and source pointers (step 3):** unchanged. Ingest
  facts still link to a stored source by `sourceRef` and carry no source
  pointer (the accepted gap). The store makes no model call; this step adds
  none there.
- **Import/export, `remember()`, `forget()`:** untouched.
- **Guidance and grounding:** unchanged in position and text; the ingest
  grounding corpus is still the chunk (`:232-238`).

### 12. Compatibility lock

With no `systemOne.typeOnIngest` key (or `'llm'`), with the key set but no
`classify` function, with mode `'off'`, or with an unrepresentable
manifest: no classify call is made, every ingest system and user prompt —
default template, configured override, runtime override, with and without
guidance and grounding, modes `'off'`/`'strict'`/`'emergent'` — is
byte-identical to today, every row is written as today (same `okf_type`,
same edges, same trust), `ingest_zero_facts` fires exactly when it fires
today, `IngestDocumentResult.typing` is absent, and the backfill, librarian
and `getInstructions().librarian` are untouched. One deliberate
default-host delta, diagnostics-only and `info`: `node_type_assigned
{ writer: 'llm' }` at the ingest door for generative-typed facts (§9, Open
question 5). The door receipts a default host already sees (`node_type_folded`,
`node_type_dropped`, `edge_dropped`) keep their codes, details and ordering
relative to commit; their emission moves one frame on the full path (§4),
which Test plan 1(c) pins as invisible.

### 13. Release

`feat(core)`: a minor release. No `BREAKING CHANGE` footer: the default is
byte-identical, every type change is additive and optional, no public
signature narrows. The commit body carries §10's disclosures in one
sentence each.

## Files touched

- `packages/core/src/config/systemOne.ts` — `typeOnIngest?: 'auto' | 'llm'`
  with its docstring (§1); fence comment (`:2-13`); `typeOnWrite`'s
  docstring gains "Librarian only; `typeOnIngest` governs ingest."
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneTypeOnIngest`
  beside `resolveSystemOneTypeOnWrite` (§1).
- `packages/core/src/services/typing/typeOnWrite.ts` — shared
  `typingEngages` + `canEngageIngestTyping` (§2); `classifyFactsForWrite`
  optional `opts.concurrency` (§3); `TypingCallContext.operation` docstring
  says ingest now passes `'ingest'`; `TypingCounters` moves to `types.ts`
  and is re-imported (§9).
- `packages/core/src/types.ts` — `TypingCounters` (public); `IngestDocumentResult.typing?`
  (§9).
- `packages/core/src/services/IngestionService.ts` — engagement check and
  `engaged` hoist (`:177-183`); typing stage between `:389` and `:394`;
  `normalizeForWrite` in `runFullUpsertGraph` (`:903-907`, `:914`) and
  `appendPartialFacts` (`:1086-1103`); `ingest_zero_facts` gate on the
  mode (`:405`); `typing` on the result (`:523-530`); duality comment
  (`:908-910`) rewritten.
- `packages/core/src/WikiMemory.ts` — `getInstructions` ingest context
  reflects `canEngageIngestTyping` (`:735-737`).
- `packages/core/src/index.ts` — export `resolveSystemOneTypeOnIngest`
  beside the other resolvers (`:29-36`).
- `docs/ROADMAP.md` — step 14 done mark, in the cleanup commit (steps
  10–13 precedent): `Done — merged YYYY-MM-DD, PR #N, spec [ingest-time-typing](../specs/ingest-time-typing/spec.md)`.
- Docs, same PR (`apps/docs/src/content/docs/`):
  `reference/configuration.md` — `systemOne.typeOnIngest` row; `typeOnWrite`
  row's "Librarian only" gains the pointer; the `minConfidence.typing` and
  `onLowConfidence` rows name the ingest site (`:99`, `:104-105`);
  `guides/ontologies.md` — the "Type on write" subsection (`:208-245`)
  gains an "Ingest" paragraph: the key, the engagement rule, the no-budget
  statement with the #475 conditional, and §10's three disclosures with
  the document-edge sharpening and the emergent note; the sentence "It
  applies to the librarian only" is rewritten; `guides/prompts.md` — the
  "one exception" sentence (`:97-99`) names both engaged doors and
  `getInstructions().ingest`; `guides/diagnostics.md` — the five receipt
  rows (`:54-60`) name the ingest door and the new `writer: 'llm'` emitter;
  `guides/maintenance.md` — one sentence after the `typeOnWrite` budget
  paragraph (`:95-100`): ingest-time typing is outside the maintenance
  budget and reported per call through `llm_usage`.
- Tests: see Test plan.

Not touched: `EntryRepository` (no query or schema change), `PromptService`
(the null-context branch already exists), `OntologyService`,
`MaintenanceService`, `MaintenanceScheduler`, `EntityMaintenanceReport`,
the librarian strategies, `upsertGraph`, `SourceStoreService`,
`config/context.ts`, `package.json` dependencies, `pnpm-lock.yaml`,
`INTENT.md` (no rule text or Status changes; §7).

## Test plan

Vitest, red-first, beside the existing suites (`packages/core/__tests__/`).
Targeted files only during the lane; the full suite at the gate.

1. **Byte identity (the core guarantee).** (a) `promptByteIdentity.test.ts`
   already pins `buildIngestPrompt` across modes, overrides, guidance and
   grounding at `dd6e2a4c`; it stays green with no fixture change. (b) New
   end-to-end pin: `IngestionService.ingestDocument` with no
   `systemOne.typeOnIngest` key and with `'llm'`, through a capturing
   provider, sends system and user prompts equal to the recorded fixture
   for modes `'off'`, `'strict'`, `'emergent'`, with a placeholder override
   and with guidance; no `classify` call is made even when the provider has
   one. (c) Default-host diagnostics pin: the full-path and partial-path
   receipt sequences (`node_type_folded`, `node_type_dropped`,
   `edge_dropped`, `fact_deduplicated`, `ingest_zero_facts`, grounding
   codes) recorded before the change equal those after, except for the one
   added `node_type_assigned { writer: 'llm' }` per generative-typed fact,
   asserted explicitly.
2. **Resolver.** `resolveSystemOneTypeOnIngest`: unset → `'llm'`; `'auto'`/`'llm'`
   pass through; invalid warns once and resolves `'llm'`; the floor read
   is `resolveTypingMinConfidence` (`minConfidence.typing: 0` honored).
   `resolveSystemOneTypeOnWrite` is unaffected by `typeOnIngest` and vice
   versa.
3. **Engagement predicate.** Each of §2's four conditions alone disables
   the step (prompt equals test 1's fixture, no classify call, no typing
   receipt, no `typing` on the result). `typeOnWrite: 'auto'` alone does
   **not** engage ingest; `typeOnIngest: 'auto'` alone does not engage the
   librarian (`typeOnWriteLibrarian.test.ts` baseline stays green). The
   shared `typingEngages` boundary tests (254/255 slugs, reserved slug)
   pass for both named callers.
4. **Engaged prompt.** Under engagement every chunk's system prompt equals
   the mode-`'off'` ingest prompt for the same inputs, byte for byte, with
   guidance and grounding present; a placeholder override has its ontology
   placeholders stripped; `getInstructions().ingest` equals the engaged
   prompt while `.librarian` and `.ontologyBackfill` are unchanged.
5. **Accepted type reaches the row — full path.** A classifier answer at or
   above the floor stores `okf_type` on the inserted row, emits one
   `node_type_assigned { writer: 'classifier', confidence, sourceRef }`
   with the inserted `factId`, increments `typing.typed`, and the fact is
   absent from `findUntypedByEntityId`. No outgoing edge row is written for
   it; a sibling fact the model typed itself may still draw an edge *to*
   it in the same ingest. A model-volunteered valid slug is not asked and
   receipts `writer: 'llm'`.
6. **Accepted type reaches the row — partial path.** One chunk fails;
   the siblings' facts are typed by the classifier and stored with
   `source_hash: null` as today; receipts carry `sourceRef`; a winner whose
   title already lives for the `sourceRef` spends one call and stores
   nothing from it (`fact_deduplicated` as today).
7. **Every non-accept outcome.** Abstain, below-floor (`floor` accepted,
   `floor − ε` not), `choice_not_offered`, `kind_mismatch`, malformed,
   thrown, and context-overflow answers each: write the fact untyped,
   leave `ontology_checked_at` NULL, emit exactly the §9 receipt with
   `sourceRef`, and leave the fact eligible for an immediate backfill
   (`countUntypedByEntityId(...).eligible` counts it). The sentinel at
   confidence `1.0` is an abstain.
8. **Candidate set and ordering.** Cross-chunk dedupe losers are never
   asked (call count equals winner count minus volunteered-valid slugs);
   a document whose every chunk failed throws `WikiIngestEmptyError` with
   zero classify calls; zero winners → zero calls, `typing` all zeros.
   Classify fan-out honors `params.chunkConcurrency` over
   `config.chunkConcurrency` (observed max in-flight).
9. **In-transaction re-validation.** A manifest edit between the hoist and
   the transaction that removes the accepted slug stores the fact untyped
   with `node_type_dropped { nodeType: <classifier slug>, reason:
   'not_in_manifest' }` and no `node_type_assigned`; a mode flip to `'off'`
   stores untyped with no ontology receipt. In `'emergent'` mode an
   in-transaction merge that makes a raw slug resolve stores the model's
   slug (`writer: 'llm'`) and discards the classifier's answer.
10. **`ingest_zero_facts` under engagement.** A full re-ingest that
    tombstones prior facts and extracts nothing fires `ingest_zero_facts`
    with `typeOnIngest: 'auto'` engaged (the proxy fix, §4); the existing
    `ontologyReceipts.test.ts` cases stay green.
11. **Metering.** No `UsageMeter` is constructed; a provider that counts
    `fits` calls sees none; `llm_usage` fires once per classify call with
    `operation: 'ingest'`, `estimated: true` when the provider reports no
    counts; `typing.unattempted` is `0`.
12. **Duplicate-hash race.** When the write loses the race, no typing
    receipt is emitted (only `LLM_PASS_DIAGNOSTIC_CODES`), `llm_usage` for
    the classify calls already fired, and the result/throw carries no
    `typing`.
13. **Backfill interaction.** A classifier-typed ingest fact is not
    returned by the next `runOntologyBackfill`; a declined one is, and is
    typed or stamped by it as today.
14. **Compatibility full pass.** `ingest.test.ts`, `groundingIngest*.test.ts`,
    `diagnosticsIngest.test.ts`, `ingestDuplicateHash.test.ts`,
    `ingestRaceTranslation.test.ts`, `graphOwnershipIngest.test.ts`,
    `ontologyReceipts.test.ts`, `contextBudgetIngest.test.ts` and every
    `typeOnWrite*.test.ts` pass unchanged except for the one disclosed
    receipt delta (§12), asserted explicitly.
15. **Docs pin (light).** `typeOnWriteDocs.test.ts` grows: the ontologies
    guide contains `systemOne.typeOnIngest`, the no-budget sentence, and
    the three disclosures' document-sharpened wording (string presence).
16. **Typecheck.** `pnpm --filter @equationalapplications/core-llm-wiki typecheck`
    clean; full `pnpm test` green at the gate.

## Out of scope / rejected alternatives

Out of scope:

- A token budget, deadline or meter on `ingestDocument()` (Open question 3;
  its own spec if ruled, and #475 rides with it).
- Edge questions at the ingest door, an edge-only pass over typed document
  facts, or reviving generative edges under a classifier's type (§10).
- Extraction that reads from the source store (exploratory, roadmap).
- Any change to the backfill, the librarian strategies, `upsertGraph`, or
  `typeOnWrite`'s scope.
- An ingest-side `onLowConfidence` escalation (§8).
- A fix for #475 (its own spec; touches `UsageMeter`).

Rejected alternatives:

- **Widening `typeOnWrite` to cover ingest.** Rejected (§1): one key per
  site is the section's pattern and guarantee; widening would change
  ingest behavior for hosts already on `typeOnWrite: 'auto'` without a
  config change, under docs that promised "Librarian only". A host that
  wants both sets both.
- **Typing per chunk, before the cross-chunk dedupe.** Rejected: spends
  calls on facts the title dedupe will discard; the pre-transaction seam
  after Pass 2 asks only about winners.
- **Typing inside the transaction.** Rejected: model calls never run in a
  transaction anywhere in the engine; the `factLedger` identity key makes
  a pre-transaction map trivial to consume on both paths.
- **A new meter for ingest in this step.** Rejected as default: it is a new
  host-facing budget semantics on a verb that has none, with the #475
  overshoot attached; rule 7's visibility is already met by `llm_usage`,
  and the generative chunk calls beside the classify calls are unmetered
  today. Opened as a question, not decided.
- **Keeping door receipts in `upsertGraphCore` for the model door by
  passing the raw slug through.** Rejected: the classifier's `node_type_assigned`
  needs the in-transaction resolution result, which the core does not
  return; computing it twice (once to decide, once in the core) is the
  drift `normalizeForWrite` exists to prevent. Feeding the core a canonical
  slug keeps the core's person-door receipts intact and the model-door
  receipts byte-identical, one frame earlier (§4).
- **Adding `chunkIndex`/`itemIndex` to typing receipts.** Rejected as
  default (Open question 6): the door receipts carry `sourceRef` only, and a
  typing receipt describes a row, not a response position.
- **Stamping `ontology_checked_at` on non-accepts.** Rejected, as step 13
  OQ2 ruled: it would turn "typing earlier" into "typing less".
- **A `'strict'`-only engagement.** Rejected (Open question 7): step 13 OQ3
  ruled one prompt shape and one rule for the librarian; the same reasoning
  applies, and a host in `'emergent'` mode opted in knowingly.
- **New diagnostic codes.** Rejected: every outcome has a code and a
  content-free shape (§9).

## Open questions for Kurt

Each carries the recommended default and a one-line reason.

1. **Reading of the step 14 wording.** "Typed through the step 13 mechanism
   instead of the write-time one" — read as "the host classifier asked
   pre-transaction (step 13's mechanism) replaces the generative model
   typing inline from a manifest in the ingest prompt (today's write-time
   mechanism)" (recommended), or does "the write-time one" mean something
   else? — It is the only reading under which the sentence names a
   change the code can make; step 13's Problem statement uses the same
   phrase for today's inline typing.
2. **Opt-in key.** A sibling `systemOne.typeOnIngest: 'auto' | 'llm'`
   (recommended) or widen `typeOnWrite` to cover ingest? — One key per
   site is the section's guarantee, and widening would change ingest for
   hosts already on `typeOnWrite: 'auto'` under docs that said "Librarian
   only".
3. **Budget on `ingestDocument()`.** No meter in this step; classify calls
   as unmetered as the chunk calls beside them, visible per call through
   `llm_usage` (recommended) — or add an optional `tokenBudget` to the call
   now? — A budget is new verb semantics with #475 attached and belongs in
   its own spec; the host chose both the document and the opt-in.
4. **Rule 5 reading.** Typing at insert is creation, not an edit; no INTENT
   amendment (recommended) — or amend rule 5 to name `okf_type` as
   engine-maintained metadata? — The backfill already stamps `okf_type` on
   document facts under rule 5 as written, and rule 12 already says
   `ingestDocument` creates facts.
5. **`node_type_assigned { writer: 'llm' }` at the ingest door** for
   generative-typed facts, in every mode. Yes (recommended) — the third
   leg of the typing audit at the second model door, and step 13 OQ4 ruled
   it for the librarian door; it is a new `info` diagnostic on default
   hosts, disclosed in §12.
6. **Receipt detail.** `factId` + `sourceRef` only (recommended), or also
   `chunkIndex`/`itemIndex` from the ledger? — Door receipts carry
   `sourceRef` only; a typing receipt names a row, not a response position.
7. **Emergent mode under engagement.** Engage in `'emergent'` too and lose
   ingest's `ontology_updates` for the call (recommended), or engage only in
   `'strict'`? — Step 13 OQ3 ruled one prompt shape and one rule; the
   backfill's generative path still proposes types.
8. **Counter carrier.** `IngestDocumentResult.typing?: TypingCounters`
   (recommended), with `TypingCounters` made public, or counters through
   receipts only? — The result already widens by precedent and is the only
   per-call channel; `typedOnWrite` stays the librarian's number.
9. **Classify fan-out.** Honor the ingest call's resolved `chunkConcurrency`
   (param → config → 1) for the classify calls (recommended), or read
   config only as the librarian does? — The host's per-call knob should
   govern every fan-out that call makes; an additive optional argument
   leaves the librarian untouched.

### Owner answers (2026-11-23)

All nine open-question defaults accepted: 1 reading as recommended; 2 sibling
`typeOnIngest` key; 3 no meter, visible through `llm_usage`; 4 no INTENT
amendment; 5 `node_type_assigned { writer: 'llm' }` at the ingest door;
6 `factId` + `sourceRef` only; 7 engage in `'emergent'` too; 8
`IngestDocumentResult.typing?` with `TypingCounters` public; 9 honor the
call's resolved `chunkConcurrency`.
