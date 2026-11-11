# Import follow-ups: hook isolation, default `valid_from`, deterministic OKF event ids

**Status:** Draft
**Date:** 2026-11-11
**Issues:** #367, #366, #365. Issue #278 (the upstream sprintf-js /
node-forge watch) is out of scope: there is nothing to do until upstream
publishes.
**Intent check:** Checked against `INTENT.md` on 2026-11-11. No
contradiction found. Rule by rule:
- **Rule 6 (honest reporting).**
  - #367 is a direct breach today: a failed host hook produces no
    diagnostic and aborts the import. The fix emits the existing
    `hook_failed` code.
  - #365: the engine inserts events with `INSERT OR IGNORE`, so two
    different events that hashed to one id would lose the second one with
    no signal. The id therefore needs a hash where that does not happen in
    practice (§3.3). A derived id is also a hash of content. No diagnostic
    carries an event id today (`WikiDiagnosticDetail`,
    `packages/core/src/types.ts:845-846`), and none may start to.
- **Rule 3 (never mixed).** The events table has one primary key for all
  entities (`packages/core/src/db/schema.ts:101`). #365 puts the entity id
  inside the hash, so the same log imported into two entities gives two
  sets of rows and neither import swallows the other.
- **Rule 7 (no invisible spend).** #365 stops a re-import from adding
  events that the librarian would then read again. It makes no numeric
  claim. One repeat remains for some existing stores (§3.5).
- **Rule 8 (dependency surface).** No new dependency. The hash is written
  inside `core-okf`, which keeps "no runtime dependencies" true.
- **Rule 2 (your database stays yours).** No schema change, no migration.
- **Rule 11 (benchmarks gate behavior changes).** #366 changes a date the
  ops librarian writes, and #365 changes how many events a re-import adds.
  Neither makes an accuracy or cost claim, so no benchmark gates them.
  Docs and release notes must not add one.
- **Rule 10 (spec first).** This is the spec. §4 lists the Status notes
  that older specs need in the implementing PR.
- **Charter rule 8** ("a standard, documented format"): the id derivation
  is written into `docs/okf-profile.md` (open question 1).
- **Rulings already made.** The owner ruled on 2026-11-11 that OKF must
  derive deterministic ids (#365) and that the default `valid_from` is the
  newest date in the batch (#366); both are recorded in
  `specs/import-past-dated-events/spec.md` under "Open questions". Where
  this spec goes past the words of those rulings, the point is listed in
  §5 and not decided here.

## The fixes in plain words

1. **#367.** After an import, the engine tells the host's vector index
   about each fact. One of those calls has no safety net. If the host's
   function throws there, the whole import stops halfway. The fix gives
   that call the same safety net its two neighbours already have: log it,
   report `hook_failed`, carry on.
2. **#366.** When the ops librarian cannot tell which event a fact came
   from, it dates the fact by the last event in the batch. "Last" means
   last stored, which is not always the newest by real-world date. The fix
   uses the newest real-world date in the batch.
3. **#365.** A log line in an OKF file may have no id. Today the parser
   invents a random id each time it reads the file, so importing the same
   file twice stores every such event twice. The fix computes the id from
   the line itself, so the same line always gets the same id and the second
   import skips it.

## How this was checked

- All line numbers are on `main` at `daa62c3f` (the merge of #364), read on
  2026-11-11.
- **The engine was not run.** The worktree had no installed dependencies,
  so every root cause below comes from reading the source. The first test
  in each test plan is the reproduction and must fail on `main` before the
  fix goes in.
- Two throwaway Node scripts were run, outside the repo:
  - one copied the log-line escape and unescape code out of
    `formatOkfBundle.ts` and `parseOkfBundle.ts` to confirm §3.6;
  - one computed the test vectors in §3.3 with Node's built-in SHA-256.
- Issues #365, #366 and #367 have no comments.

## §1 #367: a throwing `onEmbeddingPersisted` hook aborts `importDump`

### Problem

- **Who hits it:** a host that passes `vectorRanker.onEmbeddingPersisted`
  and calls `importDump`, when the hook throws or rejects for a fact whose
  embedding was not stored during the import.
- **What happens:**
  - `importDump` rejects with the hook's error, after that entity's rows
    are already committed.
  - The rest of that entity's facts are neither embedded nor announced to
    the hook.
  - Every later entity in the dump is not imported at all.
  - No `hook_failed` diagnostic is delivered.

### Root cause (with evidence)

1. `doImportEntity` commits the entity in one transaction
   (`packages/core/src/services/ImportExportService.ts:148-475`), then
   runs three hook loops outside it.
2. The first loop embeds each live fact that has no preserved blob
   (`:504-525`). When `embedFact` returns `false`, it tells the hook that
   the fact has no vector:

   ```ts
   // ImportExportService.ts:521-523
   if (!embedded) {
     await this.embeddingService.notifyEmbeddingPersisted(entityId, fact.id, null);
   }
   ```

   Nothing catches a throw from this call.
3. `notifyEmbeddingPersisted` awaits the host's function directly
   (`packages/core/src/services/EmbeddingService.ts:260-268`), so a throw
   or a rejected promise comes straight back.
4. The two loops that follow wrap the same call in `try/catch`,
   `console.warn` and `reportHookFailed`: preserved-blob facts
   (`:527-553`) and soft-deleted facts (`:555-575`).
5. `importDump` runs the entities one after another with no per-entity
   catch (`:72-74`). The error leaves the loop; only the locks are
   released (`:75-77`).

**The issue's diagnosis is correct.** Two points it leaves out:

- **No embedding failure is needed.** `embedFact` also returns `false` when
  the host passed no `embed` function at all
  (`EmbeddingService.ts:138`, kind `no_provider`). A host with a hook and
  no embedder reaches line 522 for every imported fact that has no blob.
- **More is skipped than the issue lists.** The throw also skips, for the
  same entity:
  - both later hook loops (`:527-575`);
  - the embedding-dimension bookkeeping for preserved blobs (`:577-644`);
  - the vector-cache eviction in that block's `finally` (`:645-647`).

**This is the only unguarded call.** Every other direct caller of
`notifyEmbeddingPersisted` catches and reports: `EmbeddingService.ts:208-213`,
`IngestionService.ts:468-478`, `MaintenanceService.ts:876-883` and
`:1159-1166`.

**This is not a deletion path.** `forget()` and `runPrune()` use
`notifyEmbeddingPersistedOrThrow` and reject on purpose, so a deleted fact
cannot stay in an outside index. Line 522 reports a live fact that has no
usable vector. Catching there matches the neighbouring loops and removes
no guarantee.

### Proposed change

Wrap the call at `:521-523` the same way as the two loops after it:

- `catch (hookErr)`;
- `console.warn` with the fact id and the error, like the neighbours;
- `this.embeddingService.reportHookFailed({ operation: 'importDump', trigger: 'call' }, entityId, fact.id)`;
- continue with the next fact.

Signature, checked at `EmbeddingService.ts:231`:
`reportHookFailed(ctx: EmbedDiagnosticContext, entityId: string, factId: string): void`.
It emits code `hook_failed` (severity `warn`,
`packages/core/src/utils/diagnostics.ts:24`) with
`detail: { factId, reason: 'on_embedding_persisted' }`.

Not changed:

- No new diagnostic code, no new option, no change to the two guarded
  loops.
- `embedFact` itself is not wrapped. Its own failures are already caught
  and reported inside `EmbeddingService`.
- `importDump` still rejects for real errors (a failed transaction, a
  legacy `source_type` row, a busy lock). The diagnostics guide's sentence
  about an entity that throws stays true.

### Files touched

- `packages/core/src/services/ImportExportService.ts`: the `try/catch`.
- `packages/core/__tests__/diagnosticsEmbedding.test.ts`: tests below. The
  sibling test for the two guarded loops is already there (`:55-85`).
- Docs: none. `guides/diagnostics.md:48` already describes `hook_failed`.

### Test plan

All in `packages/core/__tests__/diagnosticsEmbedding.test.ts`, built on
`makeDiagnosticWiki`.

1. **Reproduction (fails on main).** No `embed` function. The hook throws
   for fact `X` only. The dump has entity `e1` with facts `A`, `X`, `B` (no
   blobs) and entity `e2` with one fact. Expect:
   - `importDump` resolves;
   - all four facts are stored;
   - the hook was called for `A`, `X`, `B` and the `e2` fact;
   - exactly one `hook_failed`, with `operation: 'importDump'`,
     `trigger: 'call'`, `entityId: 'e1'`,
     `detail: { factId: X, reason: 'on_embedding_persisted' }`;
   - `expectNoContent` passes (no title, body or error text).
2. **Embedding failure plus hook failure.** `embed` throws and the hook
   throws for the same fact. Expect one `embedding_failed` with reason
   `embed_threw` and one `hook_failed` for that fact, and the import
   resolves.
3. **Rejected promise.** A hook that returns a rejected promise behaves the
   same as one that throws.
4. **Later steps still run.** The dump has fact `P` with a preserved
   2-dimension blob and fact `X` with none; the hook throws only for `X`.
   Expect the hook to receive `P`'s vector, and the stored
   `embedding_dimension` to be `2`. On main the import throws before
   either.
5. **No false positive.** With a hook that never throws, no `hook_failed`
   is delivered. The existing test at `:55` stays green unchanged.

## §2 #366: default `valid_from` is the last event's date, not the newest

### Problem

- **Who hits it:** any ops librarian pass where
  - the model returns a fact with no `source_event`, or with a label that
    is not in the batch, and no usable `valid_from` of its own, **and**
  - the batch's last event is not the newest one by real-world date.
- **When the second condition holds:**
  - a merge import re-stamped old events (#364). They sort at the end of
    the next batch and carry their old date in `occurred_at`;
  - any `write()` with a back-dated `occurred_at` that lands last in a
    batch, for example a queued offline write. The temporal-facts guide
    tells hosts to pass the client's timestamp.
- **What happens:** the fact is stored with the old date as `valid_from`,
  even when it came from one of today's events.
  - An `asOf` read at any time after that old date returns the fact as if
    it had been true then.
  - If the fact supersedes another, the old fact's `valid_to` is set to
    that same old date (`ops/apply.ts:146`, `:158`), so history shows the
    old fact ending years before it did.

### Root cause (with evidence)

1. `selectBatch` reads events in storage order: `getAfter` orders by
   `created_at ASC, id ASC`
   (`packages/core/src/repositories/EventRepository.ts:199`).
2. Each event's date is `occurred_at ?? created_at`
   (`packages/core/src/services/librarian/ops/text.ts:12`), kept as `at`.
3. The default is the last element's `at`:

   ```ts
   // packages/core/src/services/librarian/ops/extract.ts
   74:  const newestAt = batch[batch.length - 1].at;
   85:  const validFrom = parseValidFrom(r.valid_from) ?? (sourceLabel ? byLabel.get(sourceLabel)!.at : newestAt);
   ```

   The order comes from `created_at` and the value from `occurred_at`, so
   "last" is "newest" only when no event in the batch has an `occurred_at`.
4. The value becomes the stored `valid_from` (`ops/apply.ts:95`, `:107`)
   and the default supersession instant (`:146`).

**The issue's diagnosis is correct**, including both line numbers. Three
corrections to its framing:

- **It is not new with #364.** A back-dated `write()` has triggered it
  since the ops librarian shipped. #364 only makes it common, because
  re-stamped events always sort last.
- **It is a gap between code and the original design.** The design says
  "if missing/invalid, the newest event in the batch"
  (`docs/superpowers/specs/2026-09-29-competitive-memory-design.md:179`).
  The code took the last by position. So this fix restores the design; it
  does not change it.
- **The prescribed fix has a side effect the issue does not mention.**
  `write()` accepts a future `occurred_at`: it only checks for a finite
  number >= 0 (`packages/core/src/services/WriteService.ts:68`). A fact
  whose `valid_from` is later than now is left out of current reads
  (`packages/core/src/utils/temporal.ts:14-19`;
  `packages/core/src/services/RetrievalService.ts:80`, `:127`).
  - Today, one future-dated event (an appointment) hides the batch's
    unlabeled facts only when it happens to be last.
  - With a plain maximum, it hides them wherever it sits in the batch.
  - See open question 3.

Existing coverage: `packages/core/__tests__/opsExtract.test.ts:37-58`
asserts the default, but in its batch the last event is also the newest
(dates 7 and 20), so it passes before and after.

### Proposed change

In `runExtract` (`ops/extract.ts`):

1. Replace line 74 with the maximum `at` over the batch. Rename the
   variable so it says what it holds (`defaultValidFrom`).
   - `runExtract` is never called with an empty batch
     (`ops/index.ts:35`), and every `at` is already a usable date by this
     point: the prompt builder calls `new Date(l.at).toISOString()` on each
     one first (`packages/core/src/services/PromptService.ts:277`), which
     throws on an unusable value.
   - Use a loop or `reduce`, not `Math.max(...spread)`.
2. **Pending open question 3 (recommended):** cap it at the time of the
   pass, `Math.min(maxAt, Date.now())`. In words: the newest event date in
   the batch, but never later than now.
3. Line 85 keeps its order of preference: the model's own `valid_from`,
   then the labelled source event's date, then this default.

Not changed:

- A fact with a valid `source_event` label still takes that event's date,
  future or not. That is the designed behaviour (design §179) and outside
  #366. It does mean a correctly labelled fact about a future appointment
  is not returned by current reads until that date. Noted here; not fixed.
- The watermark, the batch order and the prompt.
- The legacy strategy, which writes no `valid_from`.

### Files touched

- `packages/core/src/services/librarian/ops/extract.ts`.
- `packages/core/__tests__/opsExtract.test.ts`,
  `packages/core/__tests__/opsLibrarian.test.ts`.
- `apps/docs/src/content/docs/guides/temporal-facts.md`: one sentence
  under "Record when events really happened" saying how the ops librarian
  dates a fact (the model's date, else its source event's date, else the
  newest date in the batch). The guide does not say this today.
- `docs/superpowers/specs/2026-09-29-competitive-memory-design.md`: append
  a dated Status note only if the cap in step 2 is adopted, since §179 does
  not mention one.

### Test plan

`packages/core/__tests__/opsExtract.test.ts` (`runExtract` directly, using
the file's `mk()` helper):

1. **Reproduction (fails on main).** `evt_a` at `created_at` 100;
   `evt_b` at `created_at` 200 with `occurred_at` 5. The model returns one
   fact with no `source_event` and one with the unknown label `e9`. Expect
   `validFrom` 100 for both. Main gives 5.
2. **Existing test unchanged.** `:37-58` stays green.
3. **Order of preference kept.** In the same batch, a fact labelled `e2`
   gets 5, and a fact with its own `valid_from` gets that value.
4. **Single event.** A batch of one gives that event's date.
5. **Future date** (open question 3). `evt_a` at 100; `evt_b` with
   `occurred_at` 30 days after a mocked `Date.now()`. An unlabeled fact
   gets the mocked now. If the owner rules against the cap, this test
   asserts the future value instead and the guide sentence says so.

`packages/core/__tests__/opsLibrarian.test.ts` (a full pass):

6. **After an import.** One local event written today, then one event
   re-stamped the way #364 does it (`created_at` just after now,
   `occurred_at` in 2023). The model returns an unlabeled fact. Expect the
   stored `valid_from` to be today's event date, and a current `read()` to
   return the fact.
7. **Supersession.** The same batch with an unlabeled candidate resolved
   as `SUPERSEDE` with no date of its own. Expect the old fact's `valid_to`
   to equal the new fact's `valid_from`, and both to be today's date, not
   2023.

## §3 #365: id-less OKF log events get a fresh id on every parse

### Problem

- **Who hits it:** anyone who imports an OKF bundle whose `log.md` has
  lines without an id comment, more than once into the same entity.
  - Hand-written logs.
  - Profile 0 bundles, which never had id comments.
  - Any log that went through a markdown formatter that strips HTML
    comments.
- **Not affected:** bundles this engine exported. `formatOkfBundle` writes
  an id comment on every line
  (`packages/core/src/utils/formatOkfBundle.ts:192`).
- **What happens:**
  - Each import adds every id-less event again.
  - Since #364, a merge import into an entity whose librarian has run also
    re-dates each copy that falls behind the librarian's position, and the
    next pass reads it again. `parseOkfBundle` dates every log event at
    midnight UTC of its heading day (`parseOkfBundle.ts:529`), so most
    copies do fall behind. That is model spend on events that were already
    consolidated.

### Root cause (with evidence)

1. `parseOkfBundle` reads the id comment from each log line
   (`packages/core/src/utils/parseOkfBundle.ts:516`). When there is none,
   it makes a random id:

   ```ts
   // parseOkfBundle.ts:533
   id: eventId ?? generateId('evt_'),
   ```

2. `generateId` is random by design (`packages/core/src/utils/ids.ts:24`).
3. `importDump` inserts events with `INSERT OR IGNORE` on the id
   (`packages/core/src/repositories/EventRepository.ts:53-68`). A new id
   is a new row.
4. An ignored duplicate is not re-dated and not counted: the loop skips
   it (`ImportExportService.ts:445-457`,
   `if (!inserted || stamp.reason === null) continue;`). So a stable id is
   enough to make the second import a no-op for that event.

**The issue's diagnosis is correct**, including the line number. Its
prescription is incomplete or imprecise in four places:

- **It leaves out the event type.** The issue suggests "a hash of entity,
  log date and summary". The profile already names the identity of an
  id-less event: `(event_type, summary, UTC-day)`
  (`docs/okf-profile.md:153`). The hash must cover the event type too.
- **"Idempotent" holds only while the earlier copy is still stored.** Once
  a prune has deleted a consolidated event, a later import of the same log
  inserts it again, and a merge import into an entity with a watermark
  re-dates and re-reads it. This is the same "bounce" that
  `specs/import-past-dated-events/spec.md` records for bundles without a
  source watermark. Events with explicit ids behave the same way today.
  Deterministic ids do not fix it, and this spec does not either.
- **The profile already asked for something, and the engine never did
  it.** `docs/okf-profile.md:153` says a consumer SHOULD deduplicate
  id-less events by that tuple against the events it already holds. No
  code in `ImportExportService.ts`, `parseOkfBundle.ts` or
  `EventRepository.ts` does. The conformance test for the legacy fixture
  only checks that ids start with `evt_`
  (`packages/core/__tests__/okfProfileConformance.test.ts:76-82`). The
  2026-07-05 profile design left that check to the host application.
- **Deterministic ids are not the same as that tuple check.** They cover
  the main case (the same log imported again) and miss two others; see
  §3.5.

### Proposed change

#### §3.1 The rule

In `parseOkfBundle`, a log line with a valid id comment keeps that id,
exactly as today. A log line without one gets a derived id.

#### §3.2 What is hashed

Six fields, in this order:

| # | Field | Value |
|---|---|---|
| 1 | tag | the fixed text `llm-wiki/event-id/1` |
| 2 | entity id | the `entityId` argument passed to `parseOkfBundle` |
| 3 | day | the heading's ten characters, `YYYY-MM-DD`, as written |
| 4 | event type | the type the event is stored with |
| 5 | summary | the summary the event is stored with |
| 6 | occurrence | a count, as decimal digits (below) |

- **Tag.** It separates these hashes from any other use of the hash and
  names the scheme version. A future change to the scheme changes the tag.
- **Entity id.** The id of the entity being imported into, not the
  directory name in the bundle. It is needed because the events table has
  one primary key for all entities (`schema.ts:101`): without it, the same
  log imported into a second entity in the same database would be ignored
  whole.
- **Day.** The heading text, not a day recomputed from `created_at`.
  JavaScript engines differ on calendar-invalid headings: V8 reads
  `2026-02-30` as 2 March (checked in Node 24). The text is the same
  everywhere.
- **Event type.** One of `observation`, `decision`, `action`, `outcome`.
  An unknown type in the file is stored as `observation`
  (`parseOkfBundle.ts:178`), and that stored value is what is hashed. This
  follows the profile's tuple, which a consumer can only compare against
  what it stores.
- **Summary.** The summary exactly as `parseLogEntryText` returns it and
  as it is stored (`parseOkfBundle.ts:170-183`; see §3.6). No Unicode
  normalization is applied.
- **Not hashed:** the linked fact (`related_entry_id`), the time of day,
  and the position of the line in the file.

**Occurrence.** Two identical lines under the same date are two events,
and both are kept.

- Walk the log in file order. Consider only id-less lines that produce an
  event (the line parses and the date is valid).
- A line's occurrence is the number of earlier such lines in the same log
  with the same day, event type and summary. The first is `0`.
- Lines with an explicit id do not count.
- Two headings with the same date share one count.

Why a count and not the line number: the set of ids is then decided by
which lines are in the file, not by their order.

- Reordering lines changes nothing.
- Adding or removing an unrelated line changes no other line's id.
- Removing one of two identical lines leaves occurrence `0`, which is
  already stored.
- Adding a third identical line adds exactly one event.

This settles the question the issue left to the spec: identical entries
do not collapse.

#### §3.3 Encoding and hash

- **Encoding.** Each field is written as its UTF-8 byte length in decimal,
  a colon, the UTF-8 bytes, then a comma. The six are joined with nothing
  between them. A length prefix means no character inside a field can be
  mistaken for a boundary.
  - UTF-8 of a lone UTF-16 surrogate is `EF BF BD` (U+FFFD), as
    `TextEncoder` and Rust's `String::from_utf16_lossy` produce.
- **Hash.** SHA-256 over those bytes.
- **Id.** `evt_okf1_` followed by the first 32 lowercase hex characters of
  the digest (128 bits). That is 41 characters, all inside the id-comment
  alphabet `[A-Za-z0-9._-]` (`packages/okf/src/log-md.ts:28`), so the id
  survives an export.

Example, the first id-less line of the `legacy-profile-0` fixture imported
as entity `demo`:

```text
bytes: 19:llm-wiki/event-id/1,4:demo,10:2026-07-05,11:observation,15:Linked to alpha,1:0,
id:    evt_okf1_02dd42bf329719f258ab93b373f44506
```

**Test vectors** (computed 2026-11-11 with Node's built-in SHA-256):

| entity id | day | event type | summary | occurrence | id |
|---|---|---|---|---|---|
| `demo` | `2026-07-05` | `observation` | `Linked to alpha` | 0 | `evt_okf1_02dd42bf329719f258ab93b373f44506` |
| `demo` | `2026-07-05` | `decision` | `Chose path B` | 0 | `evt_okf1_9a70e3a388247f9c27f96fc3855b3975` |
| `demo` | `2026-07-05` | `decision` | `Chose path B` | 1 | `evt_okf1_549570648f50f8a88e414df0285d1de9` |
| `other` | `2026-07-05` | `decision` | `Chose path B` | 0 | `evt_okf1_0a2faa6618933c9e9d106a5b164bab90` |
| `user-123` | `2023-11-14` | `observation` | `Café ☕ visit — see [docs]` | 0 | `evt_okf1_bb987e1897dec93aec0ac282799ebc58` |
| (empty) | `2026-01-01` | `action` | (empty) | 0 | `evt_okf1_a24645f15c6bdc6a079fb283dfc059eb` |

The first two rows are the two lines of
`packages/okf/fixtures/legacy-profile-0`. The fifth has a 30-byte summary
(`30:` in the encoding). The last is an encoding boundary case only.

**Why SHA-256, and why written by hand.**

- No hash function is a dependency today. `core` depends on `minisearch`
  and `core-okf`; `core-okf` depends on nothing. The task was to prefer an
  existing dependency, and there is none to prefer.
- The one hash in the repo is `shortHash` in
  `packages/core/src/utils/sanitizeForFilename.ts:1-10`: two 32-bit
  multiply-and-xor sums. It is fine for a filename suffix. It is not
  specified anywhere, its two halves are closely related, and a collision
  here means a silently dropped event (rule 6).
- `crypto.subtle.digest` is asynchronous. `parseOkfBundle` is a
  synchronous public function; making it async would break every caller.
  The global `crypto` object is also not guaranteed on Hermes, which is
  why `ids.ts` takes an injected random source.
- `node:crypto` is not available in the browser or in React Native.
- SHA-256 is a published standard with an implementation in every
  language, and the `golden-v2` fixtures already ship a `SHA256SUMS` file
  for other implementations to check. It is about 60 lines of TypeScript
  using 32-bit integer operations only, checked against the FIPS 180-4
  vectors.
- At 128 bits, a chance collision is not a practical concern at any event
  count a store will hold.

**A derived id is not random, on purpose.** `ids.ts:22` says record ids
must be cryptographically random; that sentence is about what
`generateId` may fall back to. Event ids are not secrets and grant
nothing: a bundle can already supply any explicit id it likes. `write()`
keeps using `generateId`.

#### §3.4 Where the code goes

- `packages/okf/src/sha256.ts` (new, internal): `sha256(bytes: Uint8Array): Uint8Array`
  and a UTF-8 encoder. The encoder is written out because `core-okf` is
  built with `lib: ["ES2020"]` only (`packages/okf/tsconfig.json`), and no
  code in `core` or `core-okf` uses `TextEncoder` today. Not exported.
- `packages/okf/src/event-id.ts` (new):

  ```ts
  export function deriveEventId(input: {
    entityId: string;
    date: string;        // the heading text, YYYY-MM-DD
    eventType: string;
    summary: string;
    occurrence: number;  // integer >= 0; a TypeError otherwise
  }): string;
  ```

  Exported from `packages/okf/src/index.ts`. It belongs beside
  `appendEventIdComment` and `parseEventIdComment`: a producer that builds
  OKF from its own data can assign the same ids, and Curated Thoughts'
  TypeScript side gets the same function.
- `packages/core/src/utils/parseOkfBundle.ts`: keep a per-parse
  `Map<string, number>` for the occurrence count, and replace
  `generateId('evt_')` at `:533` with `deriveEventId(...)`. The
  `generateId` import stays; edges still use it (`:390`).

#### §3.5 Compatibility

- **Wire format: unchanged.** No new syntax. Every existing OKF file
  parses to the same events as before, apart from the ids of id-less
  lines.
- **Bundles that already carry ids:** unchanged. An explicit id always
  wins (`docs/okf-profile.md:152`) and is never recomputed or checked,
  even if it happens to start with `evt_okf1_`.
- **An id comment with illegal characters** is dropped by
  `parseEventIdComment` (`log-md.ts:44`), as today. The line then counts
  as id-less and gets a derived id.
- **After one export, the id is explicit.** `formatOkfBundle` writes the
  derived id as an ordinary id comment. From then on the line no longer
  depends on the derivation.
- **Existing stores: no migration, no rewrite.** Rows keep the ids they
  have.
- **Profile version: no bump.** `llm-wiki/2` stays. The profile's own
  policy (`docs/okf-profile.md:17`) asks for a new major only when an
  existing construct changes meaning or is removed. An id-less line means
  what it meant before.
- **Release type.** `deriveEventId` is a new export, so the `core-okf`
  commit is a `feat`. Nothing here is a major: `parseOkfBundle` keeps its
  signature and return type, and ids for id-less lines were never
  documented as random.
- **Same parsed dump, two entities.** A host that parses once and imports
  the same dump under two entity ids gets the second set ignored, as
  today. Parse once per entity.

**Two cases deterministic ids do not cover** (open question 4):

1. **Stores that imported an id-less log before this change.** Those rows
   have random ids. The first import of the same log after upgrading adds
   each event once more, under its derived id. Every later import is a
   no-op. In a merge import into an entity whose librarian has run, that
   one extra set is re-dated and read once; the host sees it as
   `event_created_at_restamped` and, where enabled, `llm_usage`.
2. **A log whose id comments were stripped after its events were
   imported.** The stored rows have the explicit ids; the stripped lines
   now derive different ones. Same one-time duplicate.

Both would need the importer to compare id-less events with stored rows
by `(event_type, summary, day)`. That is not proposed here:

- `importDump` takes a `MemoryDump` and knows nothing of OKF. It would
  need either a marker on the event or a guess from the id prefix.
- Since #364, a stored event's day is ambiguous: `created_at` may be the
  import time, with the real day in `occurred_at`.

**Split bundles.** If a host splits one log across two bundles and each
holds one of two identical lines, both get occurrence `0` and the second
is skipped. Keep a day's entries in one bundle.

#### §3.6 Related defect found while reading: plain summaries are not unescaped

This is outside the three issues. It is here because it decides what
"summary" means in §3.2.

- `formatOkfBundle` escapes `\`, `[` and `]` in every summary, linked or
  plain (`formatOkfBundle.ts:171-179`).
- `parseOkfBundle` unescapes only the linked form
  (`parseOkfBundle.ts:180`). The plain form is returned as written
  (`:182`).
- So a plain summary that contains one of those characters gains
  backslashes on every export and import into a fresh store. The throwaway
  script, using the code copied from those lines, gave:

  ```text
  original            see [docs] at C:\tmp
  after round trip 1  see \[docs\] at C:\\tmp
  after round trip 2  see \\\[docs\\\] at C:\\\\tmp
  linked form         see [docs] at C:\tmp     (correct)
  ```

- The profile requires producers to escape these characters
  (`docs/okf-profile.md:147`), so a consumer must unescape them.
- No test covers a plain summary with these characters.

**Proposed (open question 2):** unescape the plain form too, in the same
PR as §3.1, before the id is derived.

- A hand-written line with no backslashes is unaffected, so its derived id
  is the same with or without this fix.
- If this were fixed later instead, the derived id of every id-less line
  that contains a backslash escape would change once.
- A plain line `[a[b](./facts/x.md)` still falls back to a plain summary
  as the existing test at `parseOkfBundle.test.ts:560` expects; it has no
  backslashes.

#### §3.7 Profile text

Pending open question 1, amend `docs/okf-profile.md` §7 with a dated note,
in the same style as the #364 amendment:

- Idempotency rule 2 gains: "A consumer SHOULD assign an id-less event the
  derived id defined below. Importing it again is then a no-op under rule
  1, for as long as the earlier copy is still stored."
- A new short subsection gives §3.2 and §3.3 of this spec: the six fields,
  the encoding, SHA-256, the prefix, the occurrence count and the test
  vectors.
- The round-trip table row "Event identity" changes from
  "tuple-approximated otherwise" to "derived from the line otherwise".
- The Changelog gets a dated line. The profile identifier does not change.

### Files touched

- `packages/okf/src/sha256.ts` (new), `packages/okf/src/event-id.ts`
  (new), `packages/okf/src/index.ts`.
- `packages/core/src/utils/parseOkfBundle.ts`: §3.1, and §3.6 if ruled.
- `docs/okf-profile.md`: §3.7.
- `packages/okf/README.md` and
  `apps/docs/src/content/docs/packages/core-okf.md`: the new primitive.
- `apps/docs/src/content/docs/guides/okf.md`: a short "Event ids" section.
  It must say that a repeated import is skipped only while the earlier
  events are still stored, and must make no cost claim.
- Tests:
  - `packages/okf/__tests__/sha256.test.ts` (new);
  - `packages/okf/__tests__/event-id.test.ts` (new);
  - `packages/core/__tests__/parseOkfBundle.test.ts`;
  - `packages/core/__tests__/okfProfileConformance.test.ts`;
  - `packages/core/__tests__/okfReimport.test.ts` (new).
- Not touched: `formatOkfBundle.ts`, `ImportExportService.ts`, the schema,
  the fixtures under `packages/okf/fixtures/`.

### Test plan

`packages/okf/__tests__/sha256.test.ts`:

1. FIPS 180-4 vectors: the empty message, `abc`, and the 56-byte
   two-block message.
2. The UTF-8 encoder matches `TextEncoder` for ASCII, two-, three- and
   four-byte characters, and a lone surrogate.

`packages/okf/__tests__/event-id.test.ts`:

3. The six vectors in §3.3, exactly.
4. Every result matches `/^evt_okf1_[0-9a-f]{32}$/` and survives
   `appendEventIdComment` then `parseEventIdComment`.
5. Field boundaries cannot be shifted: entity `a,1:b` with day `d` differs
   from entity `a` with day `b`.
6. A negative or non-integer `occurrence` throws a `TypeError`.

`packages/core/__tests__/parseOkfBundle.test.ts`:

7. **Reproduction (fails on main).** Parse the same id-less log twice
   with `generateId` not mocked. The ids are equal.
8. The existing expectations of `evt_generated` (for example `:436`) are
   replaced with the derived id for that line.
9. An explicit id is used as written. An id comment with illegal
   characters gives a derived id.
10. Two identical lines give two events with different ids. Swapping them
    gives the same two ids.
11. Removing an unrelated line leaves the other lines' ids unchanged.
12. The same line under another date, or parsed for another `entityId`,
    gives another id.
13. Two headings with the same date share the occurrence count.
14. A line with an explicit id that is identical to an id-less line: the
    id-less one gets occurrence `0`.
15. `(approved) X` and `(observation) X` on one day are both stored as
    `observation`, with occurrences `0` and `1`.
16. A line that does not parse, or sits under an invalid date, uses up no
    occurrence.
17. `generateId` is never called with `'evt_'`.
18. If open question 2 is ruled yes: a plain summary containing `\`, `[`
    and `]` is unchanged after three export and import cycles; a plain
    line with no backslashes parses as before.

`packages/core/__tests__/okfProfileConformance.test.ts`:

19. `legacy-profile-0` parsed as `demo` gives exactly the first two ids in
    §3.3. This pins the algorithm to a committed fixture.
20. `golden-v1` and `golden-v2` are unchanged: their ids are explicit.

`packages/core/__tests__/okfReimport.test.ts` (new, a real store):

21. **Reproduction (fails on main).** Import an id-less log with
    `merge: true` twice. The event count after the second import equals
    the count after the first.
22. With a librarian watermark in place, the second import delivers no
    `event_created_at_restamped`, and a pass after it makes no model call.
23. The same log imported into entities `A` and `B` in one database gives
    each entity its own events.
24. Export after import: every `log.md` line carries an
    `<!-- id: evt_okf1_… -->` comment, and parsing the export returns the
    same ids.
25. **Accepted behaviour, case 1 of §3.5.** A row stored under a random
    id, then the same log imported twice: one extra row after the first
    import, none after the second.
26. **Accepted behaviour, after prune.** Import, run the librarian, prune
    the consolidated event, import again: the event is stored again. This
    documents the limit; it is not a target.

## §4 Sequencing

- **The three changes are independent.** They touch different files and
  none needs another:
  - #367: `ImportExportService.ts:521-523`;
  - #366: `librarian/ops/extract.ts:74`;
  - #365: `packages/okf` and `parseOkfBundle.ts`.
- **Recommended: one PR, three commit groups, in this order.** One spec
  folder is one cycle and one PR (`specs/README.md`).
  1. `fix(core)` for #367, test first.
  2. `fix(core)` for #366, test first.
  3. `feat(okf)` for `deriveEventId`, then `fix(core)` for
     `parseOkfBundle`, then the docs commit.

  Merged as a merge commit, each group stays separately revertable. The
  release is one minor, because of the `feat`.
- **When to split.** #367 has no open question and #366 has one small one.
  #365 has three and touches the published profile. An unresolved question
  holds the whole PR. If the owner does not rule on §5 at spec review,
  move §3 into its own folder (`specs/okf-deterministic-event-ids/`) and
  PR, and ship §1 and §2 from this one as a patch.
- **Status notes owed in the implementing PR** (append, never replace):
  - `specs/import-past-dated-events/spec.md`: its "Open questions" text on
    `extract.ts:74` and `parseOkfBundle.ts:533` is superseded by this
    spec.
  - `docs/superpowers/specs/2026-07-05-okf-profile-design.md`: id-less
    events now get derived ids in the engine.
  - `docs/superpowers/specs/2026-09-29-competitive-memory-design.md`: only
    if the cap in §2 is adopted.
- **Curated Thoughts.** It pins an exact core version, so it takes these
  on its next bump. Nothing here changes the wiki tables' schema. Its Rust
  importer keeps its own id-less behaviour until it adopts §3.2 and §3.3;
  until then the two sides can assign different ids to the same id-less
  line.
- **No release mechanics in the PR.** No edit to `CHANGELOG.md` or any
  `"version"` field, and no major-release footer.

## §5 Open questions for owner

Each has a recommendation. None is decided by this spec.

1. **(#365, published format.) Does the id derivation go into
   `docs/okf-profile.md` as a rule for all consumers, or stay an
   implementation detail of this engine?**
   - It decides whether other implementations, Curated Thoughts' Rust side
     first, are expected to produce the same ids, and it fixes the hash,
     the encoding and the entity-id field as part of the published
     contract.
   - *Recommendation:* put it in the profile as a SHOULD with the test
     vectors, as a dated amendment to §7, with no profile bump (§3.7). An
     id that only one implementation can compute does not deduplicate
     across implementations.
2. **(#365, scope.) Fix the plain-summary unescape defect (§3.6) in the
   same PR?**
   - It is a fourth bug, not one of the three issues. It changes what an
     import stores for a plain log line that contains `\[`, `\]` or `\\`.
   - *Recommendation:* yes. Fixing it later changes the derived id of
     every affected line once, and it is a few lines with one test.
3. **(#366, wording of the ruling.) Cap the default at the time of the
   pass?**
   - The ruling says "the maximum date in the batch". Taken literally, one
     event with a future `occurred_at` gives every unlabeled fact in its
     batch a future `valid_from`, and current reads leave those facts out
     until that date (§2, root cause).
   - *Recommendation:* yes, `min(newest date in the batch, now)`. It keeps
     the ruling's meaning for every past date and removes the one case
     where it hides facts.
4. **(#365, compatibility.) Accept a one-time duplicate in the two cases
   of §3.5?**
   - The alternative is an importer-side match on
     `(event_type, summary, day)` against stored events, which is what the
     profile's SHOULD literally describes. It needs `importDump` to learn
     about OKF, and a rule for which day a re-dated event has.
   - *Recommendation:* accept and document. The duplicate happens once per
     affected log and is visible in diagnostics. Its facts go through the
     ops librarian like those of any repeated event.

## Out of scope

- #278 (sprintf-js / node-forge): waiting on upstream.
- Re-import after prune (§3, root cause): needs a record of pruned event
  ids, which is a schema change.
- A labelled fact's future `valid_from` (§2, "Not changed").
- Explicit event ids that collide across entities in one database: the
  second is ignored with no warning today. Facts and tasks warn; events do
  not. Not caused by this work.
- Calendar-invalid log headings, which V8 accepts and normalizes.
- Edge ids, which `parseOkfBundle` also generates at random (`:390`). The
  profile says edge identity does not survive a round trip.
