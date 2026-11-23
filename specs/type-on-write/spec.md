# Spec — Step 13: Type on write

**Status:** Implemented (2026-11-23, PR #471); owner-approved 2026-11-23, all open-question defaults accepted
**Date:** 2026-11-23
**Intent check:** Rule 1 (the classifier is the host's `llmProvider.classify`;
core adds no provider, key or network client). Rule 2 (no schema change at
all: `okf_type` and `ontology_checked_at` already exist; nothing is dropped
or rewritten). Rule 6 (every typing outcome and every librarian rewrite or
supersede gets a typed, content-free receipt; nothing is dropped silently).
Rule 7 (write-time classify calls draw from the same `UsageMeter` the pass
already carries; `write()` itself still makes no model call in deferred
mode). Rule 10 (this spec, Status line updated in the PR that ships it).
Rule 11 (no accuracy or cost claim; the cost profile under the opt-in is
disclosed as unmeasured). Rule 12 (ships the librarian's per-fact pass
report that the 2026-11-22 amendment in PR #465 assigns to step 13). The
roadmap's own guarantees for this section hold: a site runs only when the
host opts it in; a host that opts nothing in gets byte-for-byte today's
prompts and writes; spend is metered; output is validated before it reaches
memory; every decision is surfaced in receipts and per-pass counters.

Base: `origin/main` @ `dd6e2a4c` (v9.14.0). Every pin below is verified
live against that commit in the worktree `expo-llm-wiki-step13`. Repo:
expo-llm-wiki. Product rule: hosts bring their own models; core stays
unopinionated about providers. Roadmap step 13 (`docs/ROADMAP.md:294-303`);
gate "steps 5 and 6 merged" — met (PR #442, PR #438).

## Problem

A fact the librarian writes is typed only if the generative model types it
in the same breath. When the entity's ontology mode is not `'off'`,
`OntologyService.buildPromptContext` (`packages/core/src/services/OntologyService.ts:88-93`)
renders the manifest plus typing instructions
(`packages/core/src/prompts/ontology.ts:18-38`) and the write builders append
it to the system prompt: the legacy librarian at
`services/librarian/legacy.ts:46-59` → `services/PromptService.ts:205-237`,
the ops extract at `services/librarian/ops/extract.ts:263-269` →
`PromptService.ts:382-398`. The model may answer `okf_type`;
`validateAndNormalizeFact` (`OntologyService.ts:113-148`) resolves it; a
miss stores the fact untyped (`legacy.ts:166-167`, `:193`;
`services/librarian/ops/apply.ts:116-117`, `:147`). An untyped fact then
waits for the `ontologyBackfill` maintenance job
(`repositories/EntryRepository.ts:1805-1814`, `okf_type IS NULL`). In
deferred mode that is a later `runPendingMaintenance` round, after the
entity's librarian, heal and reembed units (`services/MaintenanceScheduler.ts:168-303`),
and only while budget remains.

The host's non-generative classifier (`LLMProvider.classify`,
`packages/core/src/types.ts:826-834`) is never consulted at the write door.
Four System-One sites exist (`typing`, `edges`, `resolve`, `healScreen`,
`packages/core/src/config/systemOne.ts:14`); the S1-0 spec reserved a fifth
key for this step — "`typeOnWrite` (PR 5b) reuses the `'typing'` threshold
key" (`specs/system-one-config/spec.md:67-71`, fence at `:265-272`) — and
the ontology-curation spec fenced it the same way: "PR 5b owns `typeOnWrite`
and receipts on its door, only after an edge path exists"
(`specs/ontology-curation/spec.md:303-304`). The edge path exists since
step 10 (PR #459).

Two more gaps ride the same step:

- One appendix builder serves both the write prompts and the backfill
  prompt. `buildOntologyPromptAppendix` is the only producer of
  `OntologyPromptContext`; `buildPromptContext` feeds it to backfill
  (`services/MaintenanceService.ts:2447`) and to every write site
  (`legacy.ts:46`, `extract.ts:77`, `:263`, `services/IngestionService.ts:183`,
  `WikiMemory.ts:728`). A write-time change to what the manifest block says
  would change the backfill prompt too. The roadmap requires the split.
- INTENT rule 12 says the librarian "reports how many facts it forgets or
  rewrites, not which" and PR #465's amendment assigns the per-fact
  librarian pass report to step 13. Today an in-place rewrite
  (`apply.ts:194-210`) and a supersede (`apply.ts:224-226`) emit no per-fact
  receipt; `LibrarianResult` carries counts only
  (`services/librarian/types.ts:109-116`).

## Root cause (with evidence)

- The write door has no classifier step. `callClassify`
  (`packages/core/src/utils/llmCall.ts:79-118`) is called from one site only,
  `_runClassifierBackfill` (`MaintenanceService.ts:2757-2761`). Neither
  librarian strategy imports it (`legacy.ts:21-30`, `ops/index.ts:1-9`,
  `ops/apply.ts:1-11`).
- The classifier machinery the write door needs already exists end to end
  and is site-independent: the question shape (`choice` over manifest slugs
  plus the reserved `none_of_these` sentinel, `MaintenanceService.ts:2663-2670`,
  `utils/ontology.ts:63-68`), the state text (`classifierStateForFact`,
  `utils/classifier.ts:62-66`), untrusted-answer validation
  (`validateClassifierAnswer`, `classifier.ts:20-59`), the sentinel-before-floor
  ordering (`MaintenanceService.ts:2785-2789`), the floor chain
  (`resolveTypingMinConfidence`, `utils/engineDefaults.ts:225-245`), the
  engagement predicate (typing `'auto'`, a `classify` function, 1..254
  slugs, no reserved slug — `MaintenanceService.ts:2301-2309`), the metered
  call (`callClassify` pre-flights against `ctx.meter` and records usage,
  `llmCall.ts:85-105`), and the concurrency knob (`chunkConcurrency`,
  `MaintenanceService.ts:2657-2658`, `withConcurrency` from `utils/pure.ts`).
- The write path already has a seam where a pre-transaction step fits. Ops:
  `runOpsLibrarianPass` runs extract → gate → `runResolve` → `applyOps`
  (`ops/index.ts:48-100`); the candidates that will be inserted are known
  after `runResolve` and before the transaction opens (`apply.ts:88`). Legacy:
  validation (`legacy.ts:88-96`) precedes the transaction (`legacy.ts:107`).
  Model calls never run inside a transaction anywhere in the engine; this
  spec keeps that.
- `okf_type` is set on insert by both strategies (`legacy.ts:193`,
  `apply.ts:147`) from `normalized.okf_type`, and `nodeTypeReceipts`
  (`utils/diagnostics.ts:147-182`) already emits `node_type_folded` /
  `node_type_dropped` at the write door (`legacy.ts:170-180`,
  `apply.ts:119-129`). The `node_type_assigned` receipt
  (`WikiDiagnosticCode`, `types.ts:954`; detail `okfType`, `writer`,
  `confidence`, `types.ts:1056-1060`) fires only on the backfill paths
  (`MaintenanceService.ts:3091-3095`); a fact the generative model types at
  write time gets no `node_type_assigned` today.
- The backfill pool is `okf_type IS NULL AND deleted_at IS NULL` past the
  cooldown (`EntryRepository.ts:1805-1819`); `updateOkfType` is additive by
  construction (`:1844-1851`). A fact that leaves the write door typed is
  never a backfill candidate, so "typed on write" and "re-typed by
  backfill" cannot both happen to one fact.
- The meter reaches the librarian pass: the scheduler passes its shared
  `UsageMeter` as `ctx.meter` (`MaintenanceScheduler.ts:173`), the strategies
  forward it to every `callLlm` (`legacy.ts:65`, `extract.ts:205`, `:270`;
  `resolve.ts` via `runBatched`). Manual `runLibrarian`
  (`MaintenanceService.ts:1031-1038`) and the `'auto'` trigger
  (`services/WriteService.ts:217-219`) pass no meter; their generative calls
  are unmetered today, and the write-time classify calls will be exactly as
  metered as the generative calls beside them.
- The context budget is not a classify concern: `ClassifyRequest`
  (`types.ts:844-847`) has no cap field, `resolveMaxPromptChars`
  (`packages/core/src/config/context.ts:92-102`) has no classify op, and the
  backfill classifier path reads no cap either. A context overflow from
  `classify` is already classified by `isContextOverflowError`
  (`MaintenanceService.ts:2779`).
- The emergent-mode proposal channel on the write path depends on the
  appendix: `EMERGENT_EXTRA` (`prompts/ontology.ts:10-16`) is the only text
  asking the model for `ontology_updates`, and both strategies merge the
  answer (`legacy.ts:111-116`, `apply.ts:91-96`). Removing the manifest from
  the write prompt removes this channel for the pass (§5, Open question 3).

## Proposed change

### 1. Opt-in key `systemOne.typeOnWrite: 'auto' | 'llm'`

Add to `SystemOneConfig` (`systemOne.ts:16-73`, beside `healScreen`):

```ts
/**
 * Write-time typing for the librarian (both strategies). `'llm'` (default)
 * keeps today's write path exactly: the generative prompt carries the
 * ontology block and the model types each fact inline, or leaves it for
 * backfill. `'auto'` asks `llmProvider.classify` to type every fact the
 * librarian is about to insert, inside the pass's own token meter, and the
 * ontology block leaves the write prompt for that pass (§5). Facts the
 * classifier does not type are written untyped exactly as today and stay
 * eligible for backfill. Engages only when a classifier is present and the
 * manifest is representable (§2). Facts typed this way carry no
 * manifest-drawn edges (§10). There is no `'off'`.
 */
typeOnWrite?: 'auto' | 'llm';
```

Resolution: `resolveSystemOneTypeOnWrite(config)` in `engineDefaults.ts`,
`config?.systemOne?.typeOnWrite ?? 'llm'`; a present non-`'auto'`/non-`'llm'`
value warns once through `warnOnce` (`engineDefaults.ts:89-93`) and is
treated as unset — the S1-0 §2 contract, mirroring `resolveSystemOneEdges`
(`engineDefaults.ts:168-178`) verbatim. `??`, never `||`. No call option (a
config-level stance, like `edges`/`resolve`/`healScreen`). No legacy chain
(none exists). No `'off'`: `'llm'` already means "today's path".

No new member joins `SystemOneThresholdSite`. The write site reads the
existing `'typing'` floor through `resolveTypingMinConfidence`
(`systemOne.minConfidence.typing` → `ontology.classifyMinConfidence` → `0.5`,
`engineDefaults.ts:225-245`), exactly as S1-0 §1 reserved. One floor governs
"the classifier assigns a node type" wherever that happens. (Open question
1 asks whether the write site should instead require an explicit floor —
posture A.)

The `systemOne.ts` fence comment (`:2-10`, `:13`) is updated to name
`typeOnWrite` as landed and to say the member count did not change.

### 2. Engagement predicate (resolved once per pass, per entity)

Write-time typing is **engaged** for a librarian pass when all of:

1. `resolveSystemOneTypeOnWrite(config) === 'auto'`;
2. `typeof options.llmProvider.classify === 'function'` (capability alone
   never switches paths — REQ-COMPAT-01.5, `types.ts:826-834`);
3. the entity's effective ontology mode is not `'off'`
   (`ontologyService.getEffectiveState(entityId)`, outside any transaction);
4. the manifest is representable as a `choice` question: at least one node
   type, at most `CLASSIFIER_MAX_CHOICES − 1` (254) node types, and no slug
   equal to the reserved sentinel — the same three checks as
   `MaintenanceService.ts:2305-2309`, extracted into one shared predicate so
   the two sites cannot drift.

When any condition fails, the pass runs exactly as today: today's appendix,
no classify call, no new receipt. A failing condition is not an error and
emits nothing; the backfill's classifier site treats the same conditions the
same way (it silently falls back to generative, `:2301-2309`).

The predicate is a pure function
`canEngageWriteTyping(config, provider, mode, manifest)` in a new module
(§13 names it) so step 14 reuses it unchanged.

### 3. Where the step sits, and which facts it asks about

The typing step is one new pre-transaction stage in each strategy. It takes
the pass's `ctx` (entity, trigger, meter), the manifest from the engagement
check, the resolved floor, and a list of **candidate facts**; it returns one
outcome per fact. It makes no database write.

- **Ops** (`ops/index.ts`): after `runResolve` returns and before `applyOps`
  (`:68-90`). Candidates: every `GatedCandidate` whose gate decision is not
  `noop` (`gate.ts:20-23`) and whose resolved op is not `NOOP` — exactly the
  set that is not already settled as a duplicate. (A classifier-settled NOOP
  from step 11 is settled before this stage and costs no typing call.) A
  candidate on the UPDATE-in-place branch (`apply.ts:194-210`) is asked and
  its answer is unused when the existing row is updated instead of a new row
  inserted; at most one classify call per such candidate is spent for
  nothing. For an ops SUPERSEDE, or an UPDATE applied as a supersede, the
  classifier is asked about the candidate's raw text while the stored row may
  carry the merged `overrides` title/body. Disclosed; the alternative — reproducing `applyOps`'s branch logic
  before the transaction — is rejected as a drift hazard (Rejected
  alternatives).
- **Legacy** (`legacy.ts`): after the `validateFact` loop (`:88-96`) and
  before the transaction (`:107`). Candidates: every `validFacts` entry. A
  fact the in-transaction fuzzy dedupe later skips (`:141-161`) has spent
  one classify call for nothing. Disclosed.
- **Skip rule:** a candidate whose raw `okf_type` already resolves against
  the pre-transaction manifest (`resolveNodeTypeMatch`, `utils/ontology.ts:35-48`)
  is **not asked**: a valid model-supplied slug stands, with
  `writer: 'llm'` on its receipt (§8). With the appendix gone (§5) a
  volunteered slug is rare, but it is honored, not discarded. One writer per
  fact (step-10 OQ6 precedent: no mixed provenance).

The call is identical to the backfill's: one `callClassify` per fact with
`{ state: classifierStateForFact(fact), questions: { okf_type: question } }`
(`MaintenanceService.ts:2757-2766` shape), where `question` is the same
`choice` over the manifest slugs plus `ONTOLOGY_ABSTAIN_SENTINEL` with the
same instruction text (`:2663-2670`), `operation: 'librarian'`, the pass's
`trigger`, and `meter: ctx.meter`. Calls run under `withConcurrency` with
the `chunkConcurrency` rule (`:2657-2658`). No edge questions are asked at
this site (§10).

Outcomes mirror the backfill's `Outcome` union (`:2672-2691`) minus the
edge states: `accepted { okfType, confidence }`, `abstain`,
`low_confidence`, `invalid { reason }`, `threw`, `overflow_skip`,
`unattempted`. Validation order is the backfill's: `validateClassifierAnswer`
first; an answer that is not `choice` is `invalid`; the sentinel is checked
**before** the floor (an abstain at any confidence is a decline, S1-0 §5);
`confidence < floor` is `low_confidence`.

Budget: `WikiBudgetExhausted` from `callClassify` marks that fact and every
not-yet-started fact `unattempted`; the step stops asking; the pass
**continues to apply** with those facts untyped. The pass does not return
`budgetStop`: extraction and resolution were paid for and their facts are
written; discarding them to signal the stop would re-pay the whole unit on
the next pass (Rejected alternatives). The scheduler sees exhaustion at the
next unit's pre-flight exactly as it does today
(`MaintenanceScheduler.ts:184-188`). Rule 7 holds: no call ran past the
meter.

### 4. How an accepted type reaches the row

The step returns a `Map<candidate, { okfType, confidence }>` for accepted
outcomes. Inside the transaction, at the insert sites (`legacy.ts:163-200`,
`apply.ts:110-171` `insert()`), when the candidate's own `okf_type` did not
resolve and the map holds an entry, the row is normalized a second time
through the **same** `validateAndNormalizeFact` with
`{ ...fact, okf_type: accepted.okfType, edges: [] }` against the
**in-transaction** manifest (`getEffectiveState(entityId, tx)`,
`legacy.ts:108`, `apply.ts:89`). Consequences, all by reuse of existing
code:

- A slug that still resolves is stored as `okf_type` on the new row (the
  insert already writes `okf_type`, `legacy.ts:193`, `apply.ts:147`).
  `updateOkfType` is not involved: the row is new, so additivity is by
  construction.
- A slug that no longer resolves in-transaction (a concurrent manifest edit;
  the engagement check read the manifest outside the transaction) stores
  the fact untyped and the existing `nodeTypeReceipts` call at the same site
  emits `node_type_dropped { factId, nodeType, reason: 'not_in_manifest' }`.
  No new code path.
- If the in-transaction mode is `'off'`, the door does not apply the
  classifier's type (it checks the mode itself: a stored `'off'` row keeps
  its manifest, so the slug would still resolve), the fact is stored as
  today's door stores it, and `shouldEmitOntologyReceipt(mode)` suppresses
  the door receipts (`legacy.ts:170`, `apply.ts:119`).
- `edges: []` is deliberate: the classifier proposes none, and any edges the
  generative model may have volunteered without a type were already dropped
  as `no_source_type` by the first normalization (`OntologyService.ts:126-139`)
  — they are **not** revived under the classifier's type (step-10 OQ6: no
  mixed-provenance facts). §10 discloses the gap.

A fact with any other outcome is inserted exactly as today: untyped,
**without** an `ontology_checked_at` stamp (Open question 2), so it is
eligible for the next backfill pass at once. The write-time step is "typing
earlier", never "typing less".

### 5. The write-path / backfill template split, and the manifest leaving the engaged write prompt

Today's one `OntologyPromptContext` producer becomes two, and the two
consumer families are kept apart at the type level:

- `prompts/ontology.ts`: `buildOntologyPromptAppendix(mode, manifestJson)`
  stays, byte-identical, and becomes the **backfill** appendix. A new
  `buildWriteOntologyAppendix(mode, manifestJson)` returns a
  `WriteOntologyPromptContext` whose text is, in this step, **byte-identical**
  to the backfill appendix for the same inputs — but produced from its own
  constants, so a later edit to either cannot reach the other. The pin test
  (Test plan 1) is the guard.
- `types.ts`: `WriteOntologyPromptContext` is a new, additive exported type
  with the same two fields plus a literal brand (`site: 'write'`), so a
  write context cannot be passed to the backfill builder without a compile
  error. The reverse direction stays open: the public write builders keep
  accepting a plain `OntologyPromptContext`, so no host call that compiles
  today stops compiling (semver: minor). `OntologyPromptContext`
  (`types.ts:136-139`) is unchanged.
- `OntologyService`: `buildPromptContext(entityId)` (`:88-93`) stays and
  serves backfill only. New `buildWritePromptContext(entityId, { engaged })`
  returns `null` when the mode is `'off'` **or** `engaged` is true, else the
  write appendix.
- `PromptService.ts`: `buildOntologyBackfillPrompt` (`:348-379`) and the
  `ontologyBackfill` entry of `buildInstructionTemplates` (`:425`) accept
  `OntologyPromptContext` only. `buildIngestPrompt` (`:185-203`),
  `buildLibrarianPrompt` (`:205-237`), `buildOpsExtractPrompt` (`:382-398`)
  and the `ingest`/`librarian` entries of `buildInstructionTemplates`
  (`:420-423`) keep accepting `OntologyPromptContext | null` (a
  `WriteOntologyPromptContext` is assignable to it); only the backfill
  builder narrows, to `OntologyPromptContext & { site?: never }`. The private
  `appendOntology`/`buildSystemPrompt` helpers (`:158-183`) are split into a
  write and a backfill variant with identical bodies, so the roadmap's
  sentence holds in the file it names: a write-time instruction change
  cannot change backfill prompts.
- Call sites: `legacy.ts:46`, `extract.ts:77` and `:263` (both the
  `selectBatch` reserve estimate and `extractOnce` **must** use the same
  write context, or the reserve estimate diverges from the prompt actually
  sent), `IngestionService.ts:183` and `WikiMemory.ts:728` (the write
  entries) switch to `buildWritePromptContext`. Ingest passes
  `engaged: false` in this step (byte-identical prompt; step 14 flips it).

**The engaged pass sends no ontology block.** When §2 engages, the librarian
pass calls `buildWritePromptContext(entityId, { engaged: true })`, receives
`null`, and every write builder takes its existing null-context branch
(`PromptService.ts:163-167`, `:180-183`, `:191-203`, `:212-237`, `:390`): the
system prompt is, byte for byte, the prompt that entity would get with
ontology mode `'off'` — guidance and grounding included, unchanged. A
runtime `promptOverride` carrying `{{ontologyManifest}}` /
`{{ontologyModeInstructions}}` has its placeholders stripped exactly as the
null-context branch does today (`:147-156`). Nothing new is written into any
prompt. Consequences:

- The manifest's tokens leave the generative prompt for the pass. In
  `selectBatch` the reserve estimate (`extract.ts:79`) shrinks, so more
  events may fit one batch under a meter. This is a consequence, not a
  claim (rule 11).
- The model receives no `okf_type`/`edges` schema and no `ontology_updates`
  invitation; §10 discloses both.
- `getInstructions(entityId).librarian` (`WikiMemory.ts:726-742`) reflects
  the engaged state: it evaluates the §2 predicate for the entity and passes
  the matching write context, so what the host reads is what the pass
  sends. `ingest`, `heal` and `ontologyBackfill` are unchanged.

Under `'llm'` (default) the write context is the write appendix, whose text
equals today's; every prompt is byte-identical (Test plan 1).

### 6. "Inside the same host-passed budget", concretely

- **Deferred mode** (`runPendingMaintenance`): the scheduler's one
  `UsageMeter` reaches the pass as `ctx.meter` (`MaintenanceScheduler.ts:117`,
  `:173`); every write-time `callClassify` pre-flights against it and
  records usage into it (`llmCall.ts:85-105`), reported per call as
  `llm_usage` when `reportLlmUsage` is on (`:107-115`), `estimated: true`
  when the provider returned no counts. There is no second budget, no new
  option, and no change to `tokenBudget`, `deadlineMs` or `jobs`.
- **Stop reasons:** `budget_too_small` is classified on the librarian unit's
  `budgetStop.requiredEstimate` (`MaintenanceScheduler.ts:137-143`, `:184-188`),
  which this step never sets (§3), so a typing-step exhaustion surfaces as
  `budget_exhausted` at the next unit, exactly as a generative exhaustion
  inside `applyOps`'s predecessors would. `deadlineMs` is checked between
  units and never interrupts one (`types.ts:1857`); the typing step adds
  awaited calls to the librarian unit, so a unit can run past the deadline
  by that much — the same contract heal and backfill already have.
  Disclosed in the maintenance guide.
- **Manual `runLibrarian`** and the **`'auto'` write trigger**
  (`WriteService.ts:217-219`) pass no meter; classify calls there are
  unmetered exactly as their generative neighbours are today. `write()` in
  deferred mode still records the event and calls nothing (rule 7).
- **Context budget resolver:** untouched. The classify request is one fact's
  text and one question; `ClassifyRequest` carries no cap, the backfill
  classifier reads none, and `ContextBudgetOp` gains no member. A context
  overflow from `classify` is `overflow_skip` (§3), receipted as
  `context_overflow_skipped { factId }` (§8), written untyped, eligible for
  backfill.

### 7. Validation before memory; low confidence; abstain

Nothing the classifier returns reaches a row without passing, in order:
`validateClassifierAnswer` (shape, `choice` kind, option offered, finite
confidence in [0, 1]; `classifier.ts:20-59`); the sentinel check; the
`'typing'` floor; and the in-transaction `resolveNodeTypeMatch` against the
live manifest (§4). Each gate's failure has a receipt (§8).

**Low confidence and abstain at the write site:** the fact is written
untyped and unstamped, and the receipt names the outcome. `onLowConfidence`
is **not** read at this site. Under `'llm'` the backfill escalates such a
fact to its generative step (S1-0 §4); the write site has no generative
typing step of its own and does not add one (Rejected alternatives: an
inline generative typing call would be a second generative call per pass
and would put a backfill-shaped prompt back into the write path). The
route to a generative second opinion is the existing backfill pass, which
the unstamped fact enters at once. The configuration reference says so in
the `onLowConfidence` row.

### 8. Receipts and per-pass counters

Per-fact receipts, `operation: 'librarian'`, the pass's `trigger`, pushed
into the pass's `DiagnosticBuffer` and delivered after the transaction
commits (`legacy.ts:241`, `ops/index.ts:100`) so a receipt always names a
committed row. A rolled-back pass emits none; the ops buffer is discarded on
a `budgetStop` as today (`ops/index.ts:85-88`), which this step never
produces. `factId` is the inserted row's id, so outcomes are keyed by
candidate until insert mints the id. **Zero new diagnostic codes for
typing** — every outcome reuses an existing code and detail shape:

| Outcome | Code | `detail` |
|---|---|---|
| accepted and stored | `node_type_assigned` | `{ factId, okfType, writer: 'classifier', confidence }` |
| accepted, slug missed the in-tx manifest | `node_type_dropped` (existing door receipt) | `{ factId, nodeType, reason: 'not_in_manifest' }` |
| abstain | `classification_abstained` | `{ factId, writer: 'classifier' }` |
| low confidence | `classification_low_confidence` | `{ factId, reason: 'below_threshold' }` |
| invalid answer | `classification_invalid` | `{ factId, reason }` (the `ClassifierRejection`) |
| `classify` threw | `classification_invalid` | `{ factId, reason: 'classify_threw' }` |
| context overflow | `context_overflow_skipped` | `{ factId }` |
| unattempted (budget) | none per fact | counted (below) |

Receipts fire only while the in-transaction mode is not `'off'`
(`shouldEmitOntologyReceipt`, the S1-0 §7 rule). Volume: one receipt per
asked fact, never a summary.

**Generative-typed facts at the write door** (Open question 4,
recommended yes): a fact whose model-supplied slug resolved emits
`node_type_assigned { factId, okfType, writer: 'llm' }` at the insert site,
in every `typeOnWrite` mode, so the typing audit (`node_type_dropped` /
`node_type_folded` / `node_type_assigned` joined on `factId`,
`specs/ontology-curation` §4) is complete at the librarian door. This is a
new `info` diagnostic on default hosts — not a prompt or write change — and
is the one disclosed default-host delta of this spec (§12). Heal's step-12
ruling ("receipts fire in every mode; default hosts are not blinded") is the
precedent.

**Counters.** `LibrarianResult` (`librarian/types.ts:109-116`; internal —
not re-exported from `packages/core/src/index.ts`) gains one optional
field, `typing?: { asked: number; typed: number; abstained: number;
lowConfidence: number; invalid: number; skipped: number; unattempted:
number }`, present only when §2 engaged. `EntityMaintenanceReport`
(`types.ts:1868-1887`) gains `typedOnWrite?: number`, summed from
`typing.typed` across the entity's librarian passes, beside the existing
backfill `typed` — two writers, two counters (Open question 5). No change
to `factsWritten`, `OntologyBackfillResult`, or `PendingMaintenance`.

### 9. The librarian's per-fact pass report (rule 12)

The 2026-11-22 INTENT amendment (PR #465) says: "The librarian's per-fact
pass report remains planned (step 13)." Rule 12 names two librarian moves
that change an existing fact when the host runs it: the in-place rewrite of
an engine-inferred fact and the supersede. This step receipts both, in the
heal shape (per-fact `info` diagnostics, every mode, after commit):

- `librarian_rewritten` — emitted once per existing fact the UPDATE branch
  rewrote in place (`apply.ts:194-210`): `detail: { factId }` where
  `factId` is the **existing** row's id (its old text is gone; the receipt
  carries no text). Message: "The librarian rewrote an engine-inferred
  fact in place; the previous text was not kept."
- `librarian_superseded` — emitted once per fact `supersedeInTx` ended
  (`apply.ts:224-226`, after it returns without `WikiSupersedeError`):
  `detail: { factId, replacementId }` where `factId` is the superseded
  fact and `replacementId` the new row. `WikiDiagnosticDetail` gains the
  optional `replacementId?: string` (additive; hosts tolerate unknown
  fields, `types.ts:933-936`). Message: "The librarian ended a fact's
  validity with a replacement fact."

Both codes join `WikiDiagnosticCode`, and `SEVERITY` (`info`) and `MESSAGE`
in `utils/diagnostics.ts` (the two exhaustive maps). The legacy strategy is
add-only and emits neither. Drafts written on the `contradicts_document`,
`resolve_failed` and `librarian_op_rejected` branches keep their existing
receipts and gain none. `LibrarianResult` gains `rewrittenIds?: string[]`
and `supersededIds?: string[]` populated from `updatedIds` and the
supersede loop; because `runLibrarian()` returns `void`
(`MaintenanceService.ts:1031`), the receipts are the host-visible channel in
this step and the lists are internal (Open question 6).

The same PR amends INTENT rule 12's "today" sentence to say the librarian
reports which facts it rewrites or supersedes, with a dated amendment
bullet, as PR #465 did for heal.

### 10. Disclosures the roadmap demands

**No manifest-drawn edges.** A fact typed at write time under this step
carries **no** edges: the classifier is asked no edge question (step 10's
edge screen is fenced to the backfill site by its OQ1 ruling,
`specs/edge-suggestions-system-one/spec.md:661-667`), the engaged prompt
carries no manifest so the generative model proposes none (§5), and edges
it might volunteer without a type are not revived (§4). Because a typed
fact never re-enters the backfill pool (`okf_type IS NULL`), **backfill
will never add outgoing edges to such a fact later either**. It can still
be an edge *target*: it joins the title index and the shortlist pool at
once (`findTitleIndexByEntityId`, `findShortlistRowsByEntityId`,
`EntryRepository.ts:1878-1896`, both `okf_type IS NOT NULL`), so other
facts' backfill passes may draw edges to it. Outgoing edges for write-typed
facts wait for a later step that brings step 10's screen to the write site
or adds an edge-only pass; neither is this step. The docs state this in
the opt-in's own paragraph, not a footnote.

**Extraction-quality risk.** When engaged, the generative model extracts
without the ontology block it sees today. Whether it extracts the same
facts is **unmeasured**: the roadmap removed the extraction-quality
benchmark from the step list and ruled that this step's docs disclose the
risk instead (`docs/ROADMAP.md`, Exploratory). The docs say: the engine
makes no claim either way; a host that enables `typeOnWrite: 'auto'` should
compare extraction on its own data before and after, with its own model
(rule 11, "How well that model works on your data is yours to measure").

**Cost profile, unmeasured.** Under `'auto'` the generative prompt loses
the manifest and the pass gains one classify call per candidate (§3),
including the wasted calls §3 discloses. Net cost is unmeasured and may go
either way; no number is claimed.

**Emergent proposals.** While engaged, the write path sends no
`ontology_updates` invitation, so the librarian proposes no new types for
that pass; the backfill's generative path still does (Open question 3).

### 11. Interactions

- **Backfill (ontologyBackfill):** a write-typed fact is never a candidate
  and is never re-typed (§4). A fact the write-time step left untyped is
  eligible immediately (no stamp). If the backfill also runs
  `typing: 'auto'` with the same classifier, it will ask the same question
  of the same state once more and most likely get the same answer, then
  stamp the cooldown — one duplicate classify call per such fact per
  backfill pass, disclosed; under `onLowConfidence: 'llm'` the backfill's
  generative step is where the second opinion lives.
- **Resolution (step 11):** the resolve screen runs first; NOOP-settled
  candidates are not asked (§3). Both classifier sites share `ctx.meter`.
- **Edge suggestion (step 10):** backfill-only; no edge question at the
  write site (§10). Write-typed facts become candidate targets at once.
- **Heal (step 12):** untouched; heal reads `okf_type` nowhere.
- **Import/export:** `importDump` restores `okf_type` verbatim and is not
  a write door (`specs/ontology-curation` §PR boundaries); untouched.
- **`remember()` / `upsertGraph`:** person doors, not the librarian; untouched.
- **Ingest:** untouched in behavior; moved to the write context type with
  `engaged: false` (§5) as the step-14 seam (§13).
- **Guidance and grounding:** unchanged in position and text; the null
  context branch appends them exactly as today.

### 12. Compatibility lock

With no `systemOne.typeOnWrite` key (or `'llm'`), with the key set but no
`classify` function, or with an unrepresentable manifest: no classify call
is made, every write prompt — both strategies, with and without guidance,
grounding, and runtime overrides — is byte-identical to today, every row is
written as today, `LibrarianResult.typing` is absent, and
`EntityMaintenanceReport.typedOnWrite` is absent. The backfill prompt is
byte-identical in every mode (Test plan 1). Two deliberate default-host
deltas, both diagnostics-only and both `info`: `node_type_assigned
{ writer: 'llm' }` at the write door for generative-typed facts (§8, Open
question 4), and the rule-12 receipts `librarian_rewritten` /
`librarian_superseded` for the ops strategy (§9). Neither changes a
prompt, a row, a counter a host reads today, or a return type's existing
fields.

### 13. The step-14 seam

Everything ingest will need is site-independent and lands in one new
module, `packages/core/src/services/typing/typeOnWrite.ts` (name is detail,
not ruling):

- `canEngageWriteTyping(config, provider, mode, manifest)` — §2;
- `buildTypingQuestion(manifest)` — the backfill's question
  (`MaintenanceService.ts:2663-2670`) moved here and imported back by the
  backfill, so the two sites ask one question text;
- `classifyFactsForWrite(options, ctx, facts, manifest, floor)` — §3's
  outcomes, taking `ctx.operation` so ingest can pass `'ingest'`;
- `typingReceipts(...)` — §8's table as a pure mapping.

`buildWritePromptContext(entityId, { engaged })` is the prompt seam. Step
14's spec decides whether `typeOnWrite` itself widens to ingest or a
sibling key governs it; this spec documents the key's scope as "the
librarian write path, both strategies" and does not pre-decide (Open
question 7).

### 14. Release

`feat(core)`: a minor release. No `BREAKING CHANGE` footer: defaults are
byte-identical, all type changes are additive and optional. The commit body
carries the two disclosures of §10 in one sentence each.

## Files touched

- `packages/core/src/config/systemOne.ts` — `typeOnWrite?: 'auto' | 'llm'`
  with its docstring (§1); fence comment (`:2-10`, `:13`).
- `packages/core/src/utils/engineDefaults.ts` — `resolveSystemOneTypeOnWrite`
  (§1), beside `resolveSystemOneHealScreen` (`:300-310`).
- `packages/core/src/services/typing/typeOnWrite.ts` — new (§13):
  predicate, question builder, classify step, receipt mapping.
- `packages/core/src/prompts/ontology.ts` — `buildWriteOntologyAppendix`
  (§5); `buildOntologyPromptAppendix` unchanged.
- `packages/core/src/types.ts` — `WriteOntologyPromptContext` (§5);
  `WikiDiagnosticCode` + `librarian_rewritten`, `librarian_superseded`
  (§9); `WikiDiagnosticDetail.replacementId?` (§9);
  `EntityMaintenanceReport.typedOnWrite?` (§8).
- `packages/core/src/utils/diagnostics.ts` — `SEVERITY`/`MESSAGE` for the
  two new codes (§9).
- `packages/core/src/services/OntologyService.ts` —
  `buildWritePromptContext(entityId, { engaged })` (§5).
- `packages/core/src/services/PromptService.ts` — write/backfill context
  types on the builders; split `appendOntology`/`buildSystemPrompt`
  helpers; `buildInstructionTemplates` takes both contexts (§5).
- `packages/core/src/services/librarian/types.ts` — `LibrarianResult.typing?`,
  `rewrittenIds?`, `supersededIds?` (§8, §9).
- `packages/core/src/services/librarian/legacy.ts` — engagement check and
  write context (`:46`), typing step before the tx (`:107`), accepted-type
  normalization at insert (`:163-167`), `node_type_assigned` at the door
  (`:170-180`), counters (`:260`).
- `packages/core/src/services/librarian/ops/index.ts` — engagement check,
  typing step between `runResolve` and `applyOps` (`:68-90`), counters
  (`:119-122`).
- `packages/core/src/services/librarian/ops/extract.ts` — write context at
  `:77` and `:263` (same `engaged` value both places).
- `packages/core/src/services/librarian/ops/apply.ts` — accepted-type map
  in `insert()` (`:116-129`), `node_type_assigned` at the door,
  `librarian_rewritten` (`:194-210`), `librarian_superseded` (`:224-226`),
  id lists.
- `packages/core/src/services/MaintenanceService.ts` — the backfill's
  classifier question and engagement checks import from the shared module
  (`:2301-2309`, `:2663-2670`); no behavior change; `_runGenerativeBackfill`
  keeps `buildPromptContext` (`:2447`).
- `packages/core/src/services/MaintenanceScheduler.ts` — sum
  `typedOnWrite` into the entity report (`:128`, `:190-191`).
- `packages/core/src/services/IngestionService.ts` — `buildWritePromptContext(entityId, { engaged: false })` at `:183` (byte-identical; seam only).
- `packages/core/src/WikiMemory.ts` — `getInstructions` passes both
  contexts, librarian context reflecting engagement (`:726-742`).
- `packages/core/src/index.ts` — export `resolveSystemOneTypeOnWrite`
  beside the other resolvers (`:28-39`); `WriteOntologyPromptContext` rides
  `export * from './types'`.
- `INTENT.md` — rule 12 "today" sentence and a dated amendment bullet (§9),
  same PR; rebased on PR #465's wording if it has merged, coordinated if not.
- `docs/ROADMAP.md` — step 13 done mark, in the cleanup commit (steps 10–12
  precedent): `Done — merged YYYY-MM-DD, PR #N, spec [type-on-write](../specs/type-on-write/spec.md)`.
- Docs, same PR (`apps/docs/src/content/docs/`):
  `reference/configuration.md` — `systemOne.typeOnWrite` row in the
  `systemOne` table (`:98-106`), a note on the shared `'typing'` floor row
  (`:99`), and the `onLowConfidence` row saying the write site does not read it (`:104`);
  `guides/ontologies.md` — a "Type on write" subsection under "Backfill
  untyped facts" / "Classifier mode" (`:148-215`) carrying §10's three
  disclosures verbatim in intent; `guides/maintenance.md` — the budget and
  deadline notes of §6 and the rule-12 librarian receipts beside the heal
  receipts (`:83`); `guides/diagnostics.md` — the two new codes and
  `node_type_assigned` at the librarian door (`:54-56`); `guides/prompts.md`
  — the ontology block leaves the write prompt when engaged and
  `getInstructions` reflects it (`:97-108`).
- Tests: see Test plan.

Not touched: `EntryRepository` (no query or schema change), `runBatched` /
`BoundedLlmCall`, `config/context.ts`, `resolveEdges` and the edge
pipeline, `OntologyBackfillResult`, `PendingMaintenance`, `WriteService`,
`RememberService`, `ImportExportService`, `package.json` dependencies,
`pnpm-lock.yaml`.

## Test plan

Vitest, red-first, beside the existing suites. Baseline counts are
recorded at lane open; the suite passes as a whole.

1. **Byte identity (the core guarantee).** With no `systemOne.typeOnWrite`
   key, and with `'llm'`: (a) `buildLibrarianPrompt`, `buildOpsExtractPrompt`
   and `buildIngestPrompt` outputs equal fixtures recorded at `dd6e2a4c` for
   mode `'off'`, `'strict'` and `'emergent'`, with and without guidance,
   grounding and a placeholder override; (b) `buildOntologyBackfillPrompt`
   and `buildInstructionTemplates().ontologyBackfill` equal their recorded
   fixtures on the appended and the placeholder branch; (c) the
   `librarianLegacyParity` snapshot is unchanged (never run with `-u`).

2. **Split holds under change.** A test mutates the write appendix (a
   module mock returning different text) and asserts the backfill prompt is
   unchanged; and vice versa. A type-level test (`// @ts-expect-error`)
   asserts a `WriteOntologyPromptContext` is rejected by
   `buildOntologyBackfillPrompt`, and that a plain `OntologyPromptContext` is
   accepted by all four public write builders.

3. **Resolver.** `resolveSystemOneTypeOnWrite`: unset → `'llm'`;
   `'auto'`/`'llm'` pass through; invalid warns once and resolves `'llm'`;
   the floor read is `resolveTypingMinConfidence` (a configured
   `minConfidence.typing: 0` is honored — `??` not `||`).

4. **Engagement predicate.** Each of §2's four conditions alone disables the
   step: no classify call, today's appendix sent (prompt equals test 1's
   fixture), no new receipt. 254 slugs plus the sentinel engages; 255 does
   not; a manifest carrying `none_of_these` does not. The backfill site
   imports the same predicate and its existing boundary tests stay green.

5. **Engaged prompt.** Under engagement the librarian system prompt (both
   strategies) equals the mode-`'off'` prompt for the same inputs, byte for
   byte, with guidance and grounding present; `selectBatch`'s reserve
   estimate is computed from the same prompt `extractOnce` sends; a
   placeholder override has its ontology placeholders stripped;
   `getInstructions().librarian` equals the engaged prompt while
   `.ontologyBackfill` is unchanged.

6. **Accepted type reaches the row.** Ops and legacy: a classifier answer
   at or above the floor stores `okf_type` on the inserted row, emits one
   `node_type_assigned { writer: 'classifier', confidence }` with the
   inserted `factId`, increments `typing.typed`, and the fact is absent
   from `findUntypedByEntityId`. A model-volunteered valid slug is not
   asked and receipts `writer: 'llm'`. No edge row is written for a
   write-typed fact (§10).

7. **Every non-accept outcome.** Abstain, below-floor (`confidence` exactly
   equal to the floor is accepted; `floor − ε` is not), `choice_not_offered`,
   `kind_mismatch`, malformed, thrown, and context-overflow answers each:
   write the fact untyped, leave `ontology_checked_at` NULL, emit exactly
   the §8 receipt, and leave the fact eligible for an immediate backfill
   pass (assert `countUntypedByEntityId(...).eligible` counts it). The
   sentinel at confidence `1.0` is an abstain, not an accept.

8. **Budget.** A meter that admits extraction and resolution but exhausts
   during typing: the first facts are typed, the rest are written untyped,
   `typing.unattempted` counts them, `LibrarianResult.budgetStop` is
   absent, the watermark advances, and the next scheduler unit reports
   `budget_exhausted`. A meter that exhausts before extraction still returns
   `budgetStop` with nothing written (unchanged). `llm_usage` fires per
   classify call under `reportLlmUsage`, `estimated: true` when the
   provider reports no counts.
9. **Candidate set.** Ops: gate-NOOP and resolve-NOOP (generative and
   classifier-settled) candidates are not asked; ADD, UPDATE, SUPERSEDE,
   rejected and failed candidates are; the UPDATE-in-place branch spends one
   call and stores nothing from it. Legacy: every valid fact is asked; a
   fact the in-tx dedupe skips spends one call and stores nothing.
10. **In-transaction re-validation.** A manifest edit between the engagement
    check and the transaction that removes the accepted slug stores the fact
    untyped with `node_type_dropped { reason: 'not_in_manifest' }` and no
    `node_type_assigned`; a mode flip to `'off'` stores untyped with no
    ontology receipt.
11. **Rule-12 receipts.** Ops: an UPDATE of a `librarian_inferred` target
    emits one `librarian_rewritten { factId: existingId }`; a SUPERSEDE
    emits one `librarian_superseded { factId: oldId, replacementId: newId }`;
    a `WikiSupersedeError` emits `librarian_op_rejected` and no
    `librarian_superseded`; an UPDATE of an `immutable_document` target emits
    `contradicts_document` and no `librarian_rewritten`; `rewrittenIds` /
    `supersededIds` match. Legacy emits neither code. Receipts fire with
    `typeOnWrite` unset. A pass whose transaction throws emits none.
12. **Vocabulary.** `ontologyReceiptVocabulary.test.ts` (or the diagnostics
    map test) grows by the two codes' fixed severity and message; messages
    carry no content.
13. **Scheduler.** `runPendingMaintenance` with an engaged entity reports
    `typedOnWrite` on `EntityMaintenanceReport` equal to the sum of the
    passes' `typing.typed`; `typed` (backfill) is unaffected; with the key
    unset the field is absent.
14. **Backfill interaction.** A write-typed fact is not returned by the next
    `runOntologyBackfill`; a write-time abstained fact is, and is typed or
    stamped by it as today.
15. **Compatibility full pass.** The complete `opsLibrarian`, `legacy`,
    `librarianGuidance`, `groundingLibrarian` and `librarianBudget` suites
    pass unchanged except for the two disclosed receipt deltas (§12), which
    are asserted explicitly.
16. **Docs pin (light).** The ontologies guide contains the three §10
    disclosures (string presence), so the disclosure ships with the code.
17. **Typecheck.** `pnpm --filter @equationalapplications/core-llm-wiki typecheck` clean; full `pnpm test` green.

## Out of scope / rejected alternatives

Out of scope:

- Ingest-time typing (step 14) — this spec only prepares the seam (§13).
- Edge questions at the write site, an edge-only pass over typed facts, or
  reviving generative edges under a classifier's type (§10).
- Any change to the backfill's behavior, prompt, counters or scheduling;
  it only imports the shared predicate and question text.
- Widening `runLibrarian()`'s `void` return, or a host verb to read a
  pass's id lists (Open question 6).
- Posture changes to the `'typing'` floor domain ([0, 1], default 0.5).
- A write-time `ontology_updates` substitute (the classifier cannot propose
  types).

Rejected alternatives:

- **Inline generative escalation at the write site** (honoring
  `onLowConfidence: 'llm'` with a backfill-shaped `generateText` call in the
  same pass). Rejected: a second generative call per pass with its own
  overflow and budget ladder, and it puts a backfill-shaped prompt back into
  the write path — the coupling the template split exists to prevent. The
  backfill pass is the generative second opinion (§7).
- **Returning `budgetStop` when the meter exhausts during typing.**
  Rejected: a budget-stopped pass writes nothing and holds the watermark,
  so paid extraction and resolution would be re-paid next pass to type a
  few more facts. Typing is additive; the unattempted facts are written
  untyped and backfill reaches them (§3).
- **Stamping `ontology_checked_at` on write-time non-accepts.** Rejected as
  default (Open question 2): it would hold the fact out of backfill for
  `ONTOLOGY_BACKFILL_RECHECK_MS` (7 days), turning "typing earlier" into
  "typing less" for exactly the facts the generative backfill is best at.
- **Keeping the manifest in the engaged write prompt and only filling
  gaps.** Rejected: the roadmap text — "a write-time manifest change", the
  edges gap, the extraction-quality risk — describes the manifest leaving
  the write prompt; filling gaps alone would leave typing with the
  generative model and make the classifier a footnote.
- **Reproducing `applyOps`'s branch logic before the transaction** to avoid
  the wasted UPDATE-in-place call. Rejected: two copies of the branch table
  drift; one wasted call per in-place update is disclosed instead (§3).
- **A new `systemOne.typing` value** (e.g. `'write'`) instead of a key.
  Rejected: S1-0 §10 reserved `typeOnWrite` as its own key, and the
  backfill mode and the write mode are independent choices.
- **An `'off'` mode.** Rejected for the reasons steps 10–12 gave: `'llm'`
  is today's path; an `'off'` would be a discard path with suppression
  receipts nobody asked for.
- **New diagnostic codes for typing outcomes.** Rejected: every outcome
  already has a code and a content-free detail shape (§8); the two new
  codes of §9 exist because rule 12 names moves that had none.

## Open questions for Kurt

Each carries the recommended default and a one-line reason. **Owner
ruling 2026-11-23: every recommended default is accepted** (answers
recorded per question below). Owner note 2026-11-23: the
`librarian_rewritten` / `librarian_superseded` receipts shipped here are the
single per-update receipt; PR #469 (issue #450) dropped its proposed
`librarian_updated` in favour of them.

1. **Floor posture at the write site.** Reuse the `'typing'` chain with its
   `0.5` default (recommended), or require an explicit
   `minConfidence.typing` under `typeOnWrite: 'auto'` (posture A, as
   edges/resolve/heal did)? — S1-0 §1 reserved exactly this reuse, and an
   N-way `choice` at 0.5 is the signal the backfill classifier already
   accepts today; a wrong type is a wrong stamp, not data loss.
   **Answer (2026-11-23): Reuse the `'typing'` chain, 0.5 default.**
2. **Cooldown stamp on write-time non-accepts.** Do not stamp
   (recommended) or stamp like the backfill's completed reviews? — Not
   stamping keeps the generative backfill as the immediate second opinion;
   the price is one duplicate classify call per such fact when the backfill
   also runs `typing: 'auto'`, disclosed in §11.
   **Answer (2026-11-23): Do not stamp.**
3. **Emergent mode under engagement.** Engage in `'emergent'` too and lose
   the write path's `ontology_updates` for the pass (recommended), or
   engage only in `'strict'`? — One prompt shape and one rule; the backfill's
   generative path keeps proposing types, and the host opted in knowingly.
   **Answer (2026-11-23): Engage in `'emergent'` too.**
4. **`node_type_assigned { writer: 'llm' }` at the write door for
   generative-typed facts, in every mode.** Yes (recommended) — it is the
   missing third leg of the typing audit the ontology-curation spec built,
   and step 12 ruled receipts fire for default hosts too; it is a new `info`
   diagnostic on default hosts, which §12 discloses.
   **Answer (2026-11-23): Yes.**
5. **Counter shape.** `EntityMaintenanceReport.typedOnWrite?` beside
   backfill's `typed` (recommended), or fold into `typed`? — Two writers
   stay distinguishable in the host's report; folding would hide which path
   did the typing.
   **Answer (2026-11-23): `typedOnWrite?` beside `typed`.**
6. **Rule-12 librarian report channel.** Receipts plus internal
   `rewrittenIds`/`supersededIds` on `LibrarianResult`, with
   `runLibrarian()` still `void` (recommended), or also widen `runLibrarian`
   to return the lists? — Receipts are the channel hosts already consume
   (step-11 OQ6 declined new `LibrarianResult` surface for the resolve site);
   a return-type widening is its own small spec if a host asks.
   **Answer (2026-11-23): Receipts plus internal id lists; `runLibrarian()` stays `void`.**
7. **Does this step ship the rule-12 receipts at all,** or do they get
   their own cycle? Ship here (recommended) — PR #465's INTENT amendment
   assigns them to step 13, they are two codes at two existing branches,
   and the same PR must amend rule 12's "today" line either way.
   **Answer (2026-11-23): Ship here.**
8. **Step-14 key scope.** Leave `typeOnWrite` documented as librarian-only
   and let step 14 decide widen-vs-sibling (recommended), or pre-declare
   that it will cover ingest? — Step 14 has its own gate and spec; this spec
   should not rule for it.
   **Answer (2026-11-23): Leave documented as librarian-only; step 14 decides.**
