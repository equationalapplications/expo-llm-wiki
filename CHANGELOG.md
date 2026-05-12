# [4.2.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v4.1.0...v4.2.0) (2026-05-12)


### Bug Fixes

* address PR review feedback for multi-entity contracts ([81f9599](https://github.com/equationalapplications/expo-llm-wiki/commit/81f95993b84c5b7baad2a5af8d6e1f63d19e9e0c))


### Features

* **core:** add multi-entity read contracts ([6e38474](https://github.com/equationalapplications/expo-llm-wiki/commit/6e38474b5449475610406bafb6321eaf6a421b9b))

# [4.1.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v4.0.0...v4.1.0) (2026-05-09)


### Bug Fixes

* **core:** add context to status callback errors ([0c3eb84](https://github.com/equationalapplications/expo-llm-wiki/commit/0c3eb84695d133fbec978d16effe2846ddd05c6c))
* **core:** harden subscribeEntityStatus delivery ([5c76300](https://github.com/equationalapplications/expo-llm-wiki/commit/5c76300dd4a3a808c1c463471172a4ace4833159))
* **core:** notify entity status on manual librarian/heal ([c03a60b](https://github.com/equationalapplications/expo-llm-wiki/commit/c03a60bf1409e1d28e0950f59052ae0649694cce))
* **core:** preserve re-entrant status transitions in subscribeEntityStatus ([ed87a0b](https://github.com/equationalapplications/expo-llm-wiki/commit/ed87a0b79bcb4df6c84e904ad65a5c23b1c8a08d))
* **core:** subscribeEntityStatus review — always initial, copy status ([103146c](https://github.com/equationalapplications/expo-llm-wiki/commit/103146ce2dd8a7b779e0342ffa54e53f06ff0fdb))
* **test:** use flag instead of length check to avoid race in re-entrancy test ([e85a7dc](https://github.com/equationalapplications/expo-llm-wiki/commit/e85a7dca95823bdf85d1eb123e1ebe71e3afcdd0))


### Features

* **core:** add subscribeEntityStatus initial emission scaffold ([2ee33ae](https://github.com/equationalapplications/expo-llm-wiki/commit/2ee33ae69c5f26e80d70f6a1f101911761bc6e91))
* **core:** isolate listener errors and re-entrant subscribe/unsubscribe ([3bb90f8](https://github.com/equationalapplications/expo-llm-wiki/commit/3bb90f83292d27e5c3fe83e8403ec4dac9c470c6))
* **core:** notify entity-status subscribers on auto-heal transitions ([05b1325](https://github.com/equationalapplications/expo-llm-wiki/commit/05b1325de222a0781941dd2318baaf1b93266ca7))
* **core:** notify entity-status subscribers on auto-librarian transitions ([ad9cd04](https://github.com/equationalapplications/expo-llm-wiki/commit/ad9cd04139ed41645a6f3138c45a66712ca97a01))
* **core:** notify entity-status subscribers on ingest transitions ([9ff5a24](https://github.com/equationalapplications/expo-llm-wiki/commit/9ff5a24682f318ad40022fa9652dd240c8d69530))

# [4.0.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v3.2.0...v4.0.0) (2026-05-09)


* refactor(core)!: rename source_type enum values for clarity ([f399091](https://github.com/equationalapplications/expo-llm-wiki/commit/f3990911eda2a7c71b63263a9a51ee4e079be2ae))


### Bug Fixes

* address PR [#18](https://github.com/equationalapplications/expo-llm-wiki/issues/18) Copilot follow-ups ([77ca0dd](https://github.com/equationalapplications/expo-llm-wiki/commit/77ca0dd3ccf9333198ec136b4413b50d5d14f289))
* **core:** address PR [#18](https://github.com/equationalapplications/expo-llm-wiki/issues/18) review feedback ([d217b47](https://github.com/equationalapplications/expo-llm-wiki/commit/d217b47302ade993b819f19ff2c717b2ff6d3bbe))
* **core:** close importDump lock race and align spec ([9c966df](https://github.com/equationalapplications/expo-llm-wiki/commit/9c966dffe63ba6aee85e3222030ddbba73e7aa90))
* **core:** export parseEmbedding for public consumers ([1644c88](https://github.com/equationalapplications/expo-llm-wiki/commit/1644c881d3d243290438ff6b83115d051f85a7e0)), closes [#18](https://github.com/equationalapplications/expo-llm-wiki/issues/18)
* **core:** handle legacy source_type in importDump ([4204bcc](https://github.com/equationalapplications/expo-llm-wiki/commit/4204bcc2023c71c3d1bc139a534ab7fc58240f95))
* **core:** include entity and fact id in importDump source_type errors ([4bc6f30](https://github.com/equationalapplications/expo-llm-wiki/commit/4bc6f305f179dfa9d415888cd7c61301ca8fcbf2))
* **core:** preflight legacy source_type before importDump writes ([5ae457f](https://github.com/equationalapplications/expo-llm-wiki/commit/5ae457fadd141ffb3cd2c77f03a7aebd24d16266))
* **core:** run legacy source_type probe before source_ref pass ([4e8b6df](https://github.com/equationalapplications/expo-llm-wiki/commit/4e8b6df53990c58b335c8282bae738ad0116b535))
* **core:** use <= instead of < for soft-delete pruning to handle zero retention ([07a2198](https://github.com/equationalapplications/expo-llm-wiki/commit/07a219898401ea87ac7d17f100d4fce08f00f71b))
* **embed-scifact:** read embeddings from embedding_blob ([b4a3c87](https://github.com/equationalapplications/expo-llm-wiki/commit/b4a3c876b63bf44ad1da4516a7788f2d909d4d74)), closes [#18](https://github.com/equationalapplications/expo-llm-wiki/issues/18)
* **integration:** avoid formatMemoryDump in fixture export; restore blobs in benchmark ([865193d](https://github.com/equationalapplications/expo-llm-wiki/commit/865193d7a5359aa5288d0dac49d4f6f296a90e71))
* **integration:** strip embedding blobs in scifact fixture export ([9f1560f](https://github.com/equationalapplications/expo-llm-wiki/commit/9f1560f778eae829b6cc01ab8abc9a3aad26cf1f))
* **integration:** tighten embed-scifact dump/strip and blob parse ([abe85c7](https://github.com/equationalapplications/expo-llm-wiki/commit/abe85c7b7b1cca92a605be71b1d6def6de0cf1bb))


### Performance Improvements

* **core:** probe legacy source_type before COUNT in setup guard ([6495553](https://github.com/equationalapplications/expo-llm-wiki/commit/6495553717c21c2da1405321917a822ac39e77cf))


### BREAKING CHANGES

* Existing databases use the old enum string values
and are incompatible without manual SQL migration. See migration
guide in docs/superpowers/specs/2026-05-08-source-type-rename-design.md.

Run to migrate (adjust tablePrefix if customized):
  UPDATE llm_wiki_entries SET source_type = 'immutable_document'
    WHERE source_type = 'user_document';
  UPDATE llm_wiki_entries SET source_type = 'librarian_inferred'
    WHERE source_type = 'agent_inferred';

# [3.2.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v3.1.0...v3.2.0) (2026-05-08)


### Bug Fixes

* **core:** address Copilot review feedback on prune/docs ([83d0164](https://github.com/equationalapplications/expo-llm-wiki/commit/83d0164547e208ff2ab344b590c3ae45f9c985ca))
* **core:** address Copilot review feedback on sanitization and chunking ([15090f3](https://github.com/equationalapplications/expo-llm-wiki/commit/15090f3553078358a58bd7e8fa16dbe9c021aa17))
* **core:** address Copilot review on argument parsing, timeout validation, and docs ([6a17ed3](https://github.com/equationalapplications/expo-llm-wiki/commit/6a17ed3e392f9f0b45dc6259f154ce4db178f15c))
* **core:** address Copilot review on DELETE race condition and version drift ([4ed0d24](https://github.com/equationalapplications/expo-llm-wiki/commit/4ed0d242584e72010fd294400eb9767c8cb2b9df))
* **core:** address Copilot review on ES2022 Error.cause and brittle error parsing ([959b920](https://github.com/equationalapplications/expo-llm-wiki/commit/959b9208fa162964a2e03f837a376ac343a8e627))
* **core:** address Copilot review on runPrune and forget error handling ([477a68d](https://github.com/equationalapplications/expo-llm-wiki/commit/477a68d0536a49d1e543e1260d244a23f9184d96))
* **core:** address remaining Copilot review feedback on VectorRanker ([94e002c](https://github.com/equationalapplications/expo-llm-wiki/commit/94e002cd3e97bd4421689701a01dcf254a02ea2f))


### Features

* **core:** add _notifyEmbeddingPersistedOrThrow helper with timeout ([a8182ab](https://github.com/equationalapplications/expo-llm-wiki/commit/a8182ab248929a93a619ab4d7f04772ab48aea4b))
* **core:** add sanitizeRankerErrors, deletionHookTimeoutMs, forceDeleteIgnoreRankerHook options ([8bba512](https://github.com/equationalapplications/expo-llm-wiki/commit/8bba512379d4f841490c9867856fd11dd5de0030))
* **core:** defensive copy of embedding vector before onEmbeddingPersisted hook ([f22ef5b](https://github.com/equationalapplications/expo-llm-wiki/commit/f22ef5b19596c2798ac76cbcdacb670eaf043a2b))
* **core:** defensive copy of queryVec at ranker and JS-cosine entry points ([367777c](https://github.com/equationalapplications/expo-llm-wiki/commit/367777c78331257a3aa845d5d8594e1df7f443f5))
* **core:** sanitize VectorRanker errors before mirroring via error.cause ([91975be](https://github.com/equationalapplications/expo-llm-wiki/commit/91975be1c84c957303518813ba80bcd0938859c0))

# [3.1.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v3.0.0...v3.1.0) (2026-05-08)


### Bug Fixes

* address PR review comments ([f77aed9](https://github.com/equationalapplications/expo-llm-wiki/commit/f77aed9c3c4c6039ac2c7fe5c1101221493743c0))
* **core:** address PR [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16) code review - type safety and performance ([0cb35a5](https://github.com/equationalapplications/expo-llm-wiki/commit/0cb35a50a367ba9a88d4e1d5872b1fa11701b996))
* **core:** address PR [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16) code review feedback ([f0dd13d](https://github.com/equationalapplications/expo-llm-wiki/commit/f0dd13d378fdf8947f71d9c2b5df3c9ef1f2a6de))
* **core:** address PR [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16) review - onRetrievalFallback docs and replace-mode vector cleanup ([5ac8bcf](https://github.com/equationalapplications/expo-llm-wiki/commit/5ac8bcfb5f06b31bafd7ceda2fdf47e8a189c45c))
* **core:** address PR [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16) review comments ([756f1a1](https://github.com/equationalapplications/expo-llm-wiki/commit/756f1a13ffd7c35a7fb2737b83ea316cb24d60b9))
* **core:** address remaining PR [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16) review comments ([e249f3c](https://github.com/equationalapplications/expo-llm-wiki/commit/e249f3c4a4f6b97ad57edf345d32cd215b014266))
* **core:** clarify vector ranker oversampling comment ([e4d434a](https://github.com/equationalapplications/expo-llm-wiki/commit/e4d434aeb9b82a7f13fd6de518f77c519cefd61f))
* **core:** defer onRetrievalFallback until after Phase 2 hydration ([ea6a837](https://github.com/equationalapplications/expo-llm-wiki/commit/ea6a8373295e662bac59ba0c85da2c9b84504b86)), closes [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16)
* **core:** enable oversampling for vectorRanker and defer embedding load ([9fb4207](https://github.com/equationalapplications/expo-llm-wiki/commit/9fb42079dbb020fe9e34036b5d74ec761c4f724a))
* **core:** hybrid backfill, fallback constraints, soft-delete notification filter ([0711968](https://github.com/equationalapplications/expo-llm-wiki/commit/0711968be3560f1483ae921c212693c115c64ae9)), closes [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16)
* **core:** isolate hook failures, fix entity_id consistency, optimize keyword fallback ([a244082](https://github.com/equationalapplications/expo-llm-wiki/commit/a24408248de0d049953fbcb8b3f0e7e6e8fdc11c)), closes [#8](https://github.com/equationalapplications/expo-llm-wiki/issues/8)
* **core:** notify external index for preserved-blob imports ([7206ec5](https://github.com/equationalapplications/expo-llm-wiki/commit/7206ec5b89a1cc64bcee3b67ba1c000ed89011ca))
* **core:** optimize ranker performance and clarify onRetrievalFallback scope ([88eff32](https://github.com/equationalapplications/expo-llm-wiki/commit/88eff32e39ec53e0e53e8a5b170d96680d2c071a)), closes [#16](https://github.com/equationalapplications/expo-llm-wiki/issues/16)
* **core:** replace sentinel with local boolean, add pure-semantic fallback test ([e653249](https://github.com/equationalapplications/expo-llm-wiki/commit/e6532493a1970f5aa9b8fa7495bd0147151157d0))
* **core:** sort before slice in _rankWithVectorRanker, backfill omitted ids, fix README distance semantics ([416ed38](https://github.com/equationalapplications/expo-llm-wiki/commit/416ed3851d5a9c85fc486f65c3982ef340c4b103))
* **core:** store aligned blob copy to prevent Float32Array alignment errors ([6b3b8f8](https://github.com/equationalapplications/expo-llm-wiki/commit/6b3b8f856b02f054cd0bfa002a6c106cab0e0228))
* notify vector hook on soft deletes ([c035198](https://github.com/equationalapplications/expo-llm-wiki/commit/c03519835275776fe92df580647b965d8aa291ee))
* optimize vector-ranker backfill and refresh lockfile ([93bfaae](https://github.com/equationalapplications/expo-llm-wiki/commit/93bfaae7516433ef8c4a17351cac33a19bb2a439))
* **react:** resolve vitest React hooks test failures ([0ee2068](https://github.com/equationalapplications/expo-llm-wiki/commit/0ee2068201fd31ffa6253baf3cdff2c37f41bca5))


### Features

* **core:** add VectorRanker failure policies and fallback callbacks ([15554d6](https://github.com/equationalapplications/expo-llm-wiki/commit/15554d68d35fb0db562f16bf7a67a361c1742051))
* **core:** add VectorRanker option types and fallback policy surface ([5f0c13e](https://github.com/equationalapplications/expo-llm-wiki/commit/5f0c13e12e689ea7bc19d31df6dee343841ce38d))
* **core:** delegate semantic ranking via optional VectorRanker ([31ecbcf](https://github.com/equationalapplications/expo-llm-wiki/commit/31ecbcf8590c76b50be2c56e3ab0ed7d3b7f9a31))
* **core:** notify VectorRanker on embedding persistence changes ([85e9975](https://github.com/equationalapplications/expo-llm-wiki/commit/85e99755e60a8d558a9c9b036861ab20794b6ed3))

# [Unreleased]

### Features

* **core:** add `VectorRanker` interface for pluggable semantic ranking (sqlite-vec, sqlite-vss, external ANN) with fallback policies and eventual consistency hook; closes #15
* **core:** add `sanitizeRankerErrors`, `deletionHookTimeoutMs`, `forceDeleteIgnoreRankerHook` config options for VectorRanker security and GDPR compliance
* **core:** defensive copy of `queryVec` at ranker and JS-cosine entry points to prevent mutation of WikiMemory's internal vector cache
* **core:** defensive copy of embedding `vector` before `onEmbeddingPersisted` hook to prevent adapter mutations
* **core:** sanitize VectorRanker errors before mirroring via `error.cause` (credential scrubbing)
* **core:** add `_notifyEmbeddingPersistedOrThrow` helper with configurable timeout for deletion hook reliability

### BREAKING CHANGES

* **core:** `forget()` now rethrows `onEmbeddingPersisted` hook failures instead of silently continuing. This ensures GDPR right-to-erasure compliance by preventing "forgotten" facts from remaining retrievable in external ANN indexes. Applications MUST handle deletion failures with retry or reconciliation queues. Set `forceDeleteIgnoreRankerHook: true` ONLY when the ANN backend is permanently decommissioned.
* **core:** `_doPrune()` awaits deletion hook before executing DELETE. Partial failures (some rows deleted, others failed) now throw `PrunePartialFailureError` with structured properties: `deleted` (number of successfully deleted rows), `failedAt` (fact ID where failure occurred), `remaining` (number of unprocessed rows), and `cause` (sanitized underlying error). Callers should catch this error type, access the structured properties for retry logic, log/queue failed rows, then resume or abort.

### Documentation

* **docs:** add comprehensive `SECURITY.md` with VectorRanker adapter security guidance (SQL injection, entity isolation, credential scrubbing, resource limits) and host application security best practices
* **docs:** add Security sections to root and core package READMEs covering input sanitization, data integrity, GDPR compliance, and VectorRanker security

# [3.0.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.6.0...v3.0.0) (2026-05-06)


### Bug Fixes

* address importDump mismatch flag and runReembed accuracy issues ([0e7eb5f](https://github.com/equationalapplications/expo-llm-wiki/commit/0e7eb5f53434f07e021f4832c581f926d4dd4b6b))
* address review — exportDump blobs, runReembed force, Float32 alignment, mismatch detection, WikiBusyOperation type ([ae04a33](https://github.com/equationalapplications/expo-llm-wiki/commit/ae04a332f5adb0f8a2c9932695fefba8e49b3713))
* address review-4231397290 — remove debug log, fix runReembed/canCache/blob-validation/importDump atomicity ([8c8f391](https://github.com/equationalapplications/expo-llm-wiki/commit/8c8f391080c70222f7b25a9d94c3228854a48b6a))
* apply review feedback — hybrid scoring, ReadOptions forwarding, runReembed hook, README corrections ([e7e8b84](https://github.com/equationalapplications/expo-llm-wiki/commit/e7e8b84ee8329c6f69bb01cf3c986ddb1d05c13d))
* clarify miniSearchScores safety, document options ref pattern in useMemoryRead ([01f3287](https://github.com/equationalapplications/expo-llm-wiki/commit/01f3287d47bcfdea7d9798f6786f8d559c2f8603))
* **core/react:** review 4228558241 — forget import guard, write() import skip, null maxResults/hybridWeight key ([1c5b0f6](https://github.com/equationalapplications/expo-llm-wiki/commit/1c5b0f668d67c4cec3e6a294c5d7aa24c18fb47e))
* **core:** add forget busy key — importDump throws when forget is in-flight ([bd68375](https://github.com/equationalapplications/expo-llm-wiki/commit/bd683751ef87273616a2492ef22a014e538227ea))
* **core:** add post-loop vectorCache flush in importDump to prevent stale-cache race ([4ecaa88](https://github.com/equationalapplications/expo-llm-wiki/commit/4ecaa885c353e435eeac81785fa54db6aa414b75))
* **core:** apply review 4230242346 — runReembed, runHeal cache, importDump blob, WikiBusyError docs, fastembed alias, README URLs ([d53eb0d](https://github.com/equationalapplications/expo-llm-wiki/commit/d53eb0d332d6fea7d4bd77bf6434387fa796004e))
* **core:** clamp non-finite hybridWeight; update README API label/comment ([f75b468](https://github.com/equationalapplications/expo-llm-wiki/commit/f75b4689e30f710965649f0d8e9beaccbe14ead5))
* **core:** clear stale embeddings on importDump failure; fix embedFact comment ([5b93563](https://github.com/equationalapplications/expo-llm-wiki/commit/5b93563dcf7988d5a05c5f148d98879cd47a9e54))
* **core:** runReembed() second vectorCache flush in finally so it runs on error too ([b2a2f40](https://github.com/equationalapplications/expo-llm-wiki/commit/b2a2f406025138c782ba7e072150ad244d22f2bd))
* **core:** scope import lock check globally, per-entity mismatch skip, fix stale mismatch before reconcile ([d563588](https://github.com/equationalapplications/expo-llm-wiki/commit/d5635888ac5f3b6a5a6f3b169949a63d85e9d34e))
* **core:** validate JSON array in parseEmbedding TEXT path; add non-numeric test ([bbbff8d](https://github.com/equationalapplications/expo-llm-wiki/commit/bbbff8d76f1fd0e6667f964231c33a56b40899d2))
* correct blob copy, import mismatch reconciliation, and runReembed test coverage ([181319c](https://github.com/equationalapplications/expo-llm-wiki/commit/181319ce74d1b63c77593b7c75844abea9c352dd))
* **docs:** address code review nits — JSDoc wording, hyphenation, cache eviction docs ([8190b8f](https://github.com/equationalapplications/expo-llm-wiki/commit/8190b8f67d736560ca60638a912fd6f009d6f7d7))
* double-invalidate cache in runReembed, fix flowcharts in core/expo READMEs, add cache boundary tests ([991b954](https://github.com/equationalapplications/expo-llm-wiki/commit/991b954b0438e34306241e9149bc816f34c876b8))
* forget busy-key for all mutators, chunk keyword-only IN queries, optimize Array.from, enable react tests ([778256f](https://github.com/equationalapplications/expo-llm-wiki/commit/778256f424c62e9360d626ce4bb1ea10f7bc6437))
* gate dimension promotion on full reconciliation, copy export blobs, widen embedding_blob type, add manifest-strip test, update spec breaking changes ([ac93915](https://github.com/equationalapplications/expo-llm-wiki/commit/ac93915f035d093ec3b2b56ffa2d35a2e654814f))
* global import lock for meta race, unembedded score in pure-semantic, revert version to 2.6.0 ([6cb5217](https://github.com/equationalapplications/expo-llm-wiki/commit/6cb5217f46d3bd7deef1475edcca0b74c2cabd5e))
* **importDump:** busy-key checks, move rebuildMiniSearch before embed loop, clear stale embeddings in UPDATE SQL ([41395dd](https://github.com/equationalapplications/expo-llm-wiki/commit/41395ddb43f16657d1f91f9ba7503f8b58201630))
* **integration:** fix prune timing bug and fastembed alias ([15aa85f](https://github.com/equationalapplications/expo-llm-wiki/commit/15aa85f3f0cc56062db33458101283d213d17338))
* **integration:** resolve test skipping by mocking fastembed and preserving embedding blobs ([8bcd0ca](https://github.com/equationalapplications/expo-llm-wiki/commit/8bcd0ca12aa10f5f5b2614293131911a4510babd))
* JSON-safe blob roundtrip, mixed-dim rejection, auto-force on mismatch, react force option ([acc9347](https://github.com/equationalapplications/expo-llm-wiki/commit/acc9347a6a2b093dc0bb11d92713c97a7a38721e))
* make DB spy assertion more robust with explicit destructuring and type checks ([4ff271c](https://github.com/equationalapplications/expo-llm-wiki/commit/4ff271c45ae9e4d5c3c9d9366560dd6374df0149))
* non-breaking MaintenanceResult, re-enable react hook tests, fix assertions ([068d53a](https://github.com/equationalapplications/expo-llm-wiki/commit/068d53aebe05a148e601dcb0b0951b0835e3addf))
* normalizeReadOptionsKey includes non-finite overrides; maxResults=0 skips embed ([7d0dd7e](https://github.com/equationalapplications/expo-llm-wiki/commit/7d0dd7eca65542a9649fa0bd79c24ce7bade1fb4))
* per-entity mismatch check, cosine clamp, README hook sig, spec return shape, skipExisting docs ([46c0556](https://github.com/equationalapplications/expo-llm-wiki/commit/46c055638b664dad16c258d9da74d2088a695682))
* preserve import blob dimensions, bump core to v3.0.0, clean docs examples ([9c6089d](https://github.com/equationalapplications/expo-llm-wiki/commit/9c6089dcb8595fcd5aa8bd1d284c4da3e871dcee))
* prevent dimension mismatch deadlock in importDump ([61f8658](https://github.com/equationalapplications/expo-llm-wiki/commit/61f8658177554380f6d49167a9dede1b9fba74fe))
* probe-based model-switch detection, partial-reconcile safety, reembed lock in write(), MiniSearch-before-embed order ([5115ecf](https://github.com/equationalapplications/expo-llm-wiki/commit/5115ecf9ce6a7b8d47a446544c858f0f7f68c7f5))
* re-embed all by default, Buffer JSON blobs, strip blobs from formatMemoryDump, preserve mixed-dim blobs ([f535713](https://github.com/equationalapplications/expo-llm-wiki/commit/f5357137041864e640306667690797f997dda4da))
* **react,core:** auto-refetch on options value change; clear importDump cache before embed loop ([44c5d61](https://github.com/equationalapplications/expo-llm-wiki/commit/44c5d6114631aae7322f23e0f0378c8325114b22))
* **react/docs:** revert react test re-enable; correct importDump() cache docs to per-entity ([ce84695](https://github.com/equationalapplications/expo-llm-wiki/commit/ce8469532d82feeac54faa6026dfe82f09037b83))
* **react:** normalize ReadOptions before stringifying; add importDump cache-invalidation test ([7657929](https://github.com/equationalapplications/expo-llm-wiki/commit/7657929b116c8cffa674d7d1a2fa3599172956d2))
* **react:** remove unnecessary eslint-disable from useMemoryRead effect ([b28b111](https://github.com/equationalapplications/expo-llm-wiki/commit/b28b111ecbe9232bb6a5a30050103a73e1a14807))
* **react:** stable options serialization — sort keys before JSON.stringify; update lifecycle docs ([31d6a64](https://github.com/equationalapplications/expo-llm-wiki/commit/31d6a644000fea3e00ce4469fbf04dac3fbd0d67))
* reconcile all stale vectors before clearing mismatch flag, restore runPrune < cutoff, clarify import blob and runReembed docs ([bc5ea70](https://github.com/equationalapplications/expo-llm-wiki/commit/bc5ea70a0895d63aba387a4bdbfea7693cda2f35))
* runReembed clears lastResult, zero-preFilterLimit safe SQL, js read() forwrds options, Expo README absolute URL ([02d03a0](https://github.com/equationalapplications/expo-llm-wiki/commit/02d03a035d80c1e8ab925d5188fb25b83cf37006))
* runReembed invalidates cache before loop, per-entity cache cap, no-refetch test, README flowchart/doc fixes ([6ca96ff](https://github.com/equationalapplications/expo-llm-wiki/commit/6ca96ffff2551ef2228163cf822f6aff26c8d28b))
* six retrieval-tuning review corrections ([65eaa78](https://github.com/equationalapplications/expo-llm-wiki/commit/65eaa788d4d302e53cec1d4b9cadcb8b57b8047b))
* skip mixed-dim storeEmbeddingDimension on import, rebuild MiniSearch before heal embed loop, deduplicate README runReembed example ([888644f](https://github.com/equationalapplications/expo-llm-wiki/commit/888644f5d9023d0af6536d1957a89b03833be4ed))
* strip embedding_blob from public outputs, record dim on blob import, fix docs/tests ([c32f339](https://github.com/equationalapplications/expo-llm-wiki/commit/c32f339782fe5e3158f0ed239c0343ae8393c787))
* **tests:** update vectorCache boundary tests to match actual caps, add BLOB adapter test, fix react README flowchart ([773ebef](https://github.com/equationalapplications/expo-llm-wiki/commit/773ebeffeec084a0f5d3fe2f2523904d70ad2296))
* tighten WikiMemory locking, vector cache bounds, and export/import embedding blob handling ([8c5431b](https://github.com/equationalapplications/expo-llm-wiki/commit/8c5431b3b7e2bc3d581778437d483e3a161e56a0))
* use act() instead of setTimeout in no-refetch test, remove duplicate README comment ([9defef1](https://github.com/equationalapplications/expo-llm-wiki/commit/9defef17e7a26adae5540354cbc487b656b0d289))
* use logic-based comment instead of line numbers for miniSearchScores invariant ([5839b96](https://github.com/equationalapplications/expo-llm-wiki/commit/5839b965bed9a4b767f6cc9e19eca2eaed0e5758))
* vector cache size cap, stronger tests, hybridWeight docs, README redeclaration fix ([5c08e59](https://github.com/equationalapplications/expo-llm-wiki/commit/5c08e598bfbb116ad0bd7f77e431c103e63198ee))


### Features

* **core:** add parseEmbedding utility, widen cosineSimilarity to ArrayLike ([7671dde](https://github.com/equationalapplications/expo-llm-wiki/commit/7671dde9ac7c0f6e75b160a89ac080feefa5d363))
* **core:** add ReadOptions per-call overrides to read() ([714d80c](https://github.com/equationalapplications/expo-llm-wiki/commit/714d80c62b42eb906dd398ef1687e8ec143cca35))
* **core:** add ReadOptions, WikiConfig.preFilterLimit/hybridWeight, embedding_blob schema and migration v3 ([21586fa](https://github.com/equationalapplications/expo-llm-wiki/commit/21586fac8dd6b263d1b9d1638420dbc3c63bf5ce))
* **core:** add vector cache and embedding_blob parsing to read() cosine path ([a84398e](https://github.com/equationalapplications/expo-llm-wiki/commit/a84398ec200085666ae53e169764dc96f993cd46))
* **core:** embedFact writes BLOB, clears TEXT; add blobEmbeddings tests ([dec46e2](https://github.com/equationalapplications/expo-llm-wiki/commit/dec46e230602f301d43ca1e857d3b4619b9239cb))
* **core:** implement hybridWeight scoring and hybridWeight:0 embed skip fast-path ([6e42621](https://github.com/equationalapplications/expo-llm-wiki/commit/6e42621699e3fc08117601eeee3fb26970a69996))
* **core:** implement preFilterLimit — MiniSearch pre-filter before cosine scan ([8d272b6](https://github.com/equationalapplications/expo-llm-wiki/commit/8d272b6346bdcd440c5f0c4cda626bf0711622a3))
* **core:** invalidate vector cache on all fact mutations; add vectorCache invalidation tests ([64762e8](https://github.com/equationalapplications/expo-llm-wiki/commit/64762e85b5c8fc934544e0269dd57356c5a9d6cc))


### BREAKING CHANGES

* **core:** WikiBusyOperation union now includes 'import' and 'forget'. TypeScript consumers that exhaustively switch on WikiBusyError.operation without a default arm must add cases for both new values or add a default arm to compile without errors.
* WikiBusyError.operation now includes 'import' and 'forget' in addition to the
previous five values. TypeScript consumers with exhaustive switches must add a default arm or
update to the new WikiBusyOperation type alias.

# [2.6.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.5.0...v2.6.0) (2026-05-05)


### Bug Fixes

* **ci:** resolve lockfile mismatch and remove private root from publish ([d21b341](https://github.com/equationalapplications/expo-llm-wiki/commit/d21b341ea98e0a6aba105a5db64dd8ff1db6ec63))
* tighten mutex assertion to WikiBusyError + operation; override tar to >=7 ([803137c](https://github.com/equationalapplications/expo-llm-wiki/commit/803137c57d3cae7ffab2e216067d5620341b0d70))
* update BLOB wording to dim-3 embeddings in maintenance test comments ([ceb10fe](https://github.com/equationalapplications/expo-llm-wiki/commit/ceb10fec403ea3ca5ef3e3de487377fef0a9b8b8))


### Features

* add root-level integration-test and benchmark scripts ([730aa5b](https://github.com/equationalapplications/expo-llm-wiki/commit/730aa5bfc9987d88f03beb9e3a3bc633366c7ee5))
* **integration:** add db, llm, and wiki test helpers ([aec5ab1](https://github.com/equationalapplications/expo-llm-wiki/commit/aec5ab11ad0eefb698eadb70df7554b37dcbd67e))
* **integration:** scaffold integration test package ([852c79d](https://github.com/equationalapplications/expo-llm-wiki/commit/852c79d0655de7b38e5834e6174bc332050b6c0e))

# [2.5.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.4.0...v2.5.0) (2026-05-04)


### Bug Fixes

* add reciprocal reembed conflict checks in runPrune() and ingestDocument() ([8f537f4](https://github.com/equationalapplications/expo-llm-wiki/commit/8f537f4a1f578dd7e7ecade32771461dcfcd8d01))
* address PR review feedback - embedding quality, read() correctness, locking, migrations, README ([c363347](https://github.com/equationalapplications/expo-llm-wiki/commit/c363347118fb7c22bc7ba4a393623f0f4adc0dea))
* **core:** cast MiniSearch filter result to access storeFields at runtime ([e56a692](https://github.com/equationalapplications/expo-llm-wiki/commit/e56a692c99ea2f5cb238231251f933e0d83d7e98))
* **core:** correct ALTER TABLE transaction comment in migration 2 ([6294131](https://github.com/equationalapplications/expo-llm-wiki/commit/6294131b2540ea8636a271d7697fdb9021a270b7))
* **core:** remove FTS5/synonymMap tests; update migration version assertions to v2 ([66f9046](https://github.com/equationalapplications/expo-llm-wiki/commit/66f9046b0c04981d0bee5ff79ffa26039a23adfc))
* detect embedding dimension mismatch in read() and fall back to MiniSearch ([e5d9b2f](https://github.com/equationalapplications/expo-llm-wiki/commit/e5d9b2f34664041a4d86b87caea82c5ecf79ec9f))
* entity/global runReembed() cross-check, two-phase embedding retrieval, strip embedding from bundle/LLM paths ([56b2a6b](https://github.com/equationalapplications/expo-llm-wiki/commit/56b2a6beac06662857852b05e0438bfef32e38f9))
* fix global prune check and add librarian/heal/ingest blocking in runReembed() ([a771ef2](https://github.com/equationalapplications/expo-llm-wiki/commit/a771ef209904534a994ba6bd0538bc52babd9ded))
* reconcile embedding_dimension after runReembed() completes ([8e72fd9](https://github.com/equationalapplications/expo-llm-wiki/commit/8e72fd9cb09ec9fc09b74822b9abeb033b2d7670))
* reject empty/invalid vectors in read() and embedFact() ([c3a2252](https://github.com/equationalapplications/expo-llm-wiki/commit/c3a2252223bc7c2d42c97952adcd29b5223992f6))
* use accurate type annotation for phase-2 full-row fetch in read() ([a421dcb](https://github.com/equationalapplications/expo-llm-wiki/commit/a421dcb94cee9421d5486099c8deb68054637193))
* validate embedding vectors before cosine scoring; add reembed guards to librarian/heal ([aff8d72](https://github.com/equationalapplications/expo-llm-wiki/commit/aff8d72a63df7d028056a1e1329bacccc75604b7))
* validate queryVec from embed(); update onRetrievalFallback docs ([468300b](https://github.com/equationalapplications/expo-llm-wiki/commit/468300b168c4f2cbe0c432e15411daf9bc515dec))


### Features

* **core:** add cosineSimilarity utility with tests ([4b718e5](https://github.com/equationalapplications/expo-llm-wiki/commit/4b718e57ce88a05f8a9afd42fde8f0c9d17cc186))
* **core:** add embed/onRetrievalFallback to types; add minisearch dep ([4ffec9f](https://github.com/equationalapplications/expo-llm-wiki/commit/4ffec9f061d3135a806b15c77fc3287316a08418))
* **core:** add embedFact and storeEmbeddingDimension private methods ([5771424](https://github.com/equationalapplications/expo-llm-wiki/commit/577142487764e55c0c4840530bebc9f72c792a83))
* **core:** add MiniSearch field and rebuildMiniSearchIndex to WikiMemory ([ec1ee96](https://github.com/equationalapplications/expo-llm-wiki/commit/ec1ee9627f0b5481de0857f1f86e606c8c53f82a))
* **core:** add runReembed() public method with concurrency guard ([5c8faad](https://github.com/equationalapplications/expo-llm-wiki/commit/5c8faad1bae491a0d48411c23c6ed07b2d7c465a))
* **core:** remove FTS5 schema; add embedding column; migration 2 ([1fa4ac8](https://github.com/equationalapplications/expo-llm-wiki/commit/1fa4ac8e84664a424bba31842ada82c8ca588207))
* **core:** replace FTS5 read() with cosine similarity + MiniSearch fallback ([4b101f8](https://github.com/equationalapplications/expo-llm-wiki/commit/4b101f8f333914e508a1e9b04b1559fadf76c82a))
* **core:** wire embed+MiniSearch rebuild into ingest, importDump, forget, prune ([5c37db8](https://github.com/equationalapplications/expo-llm-wiki/commit/5c37db8b6bf6a74b9578bbd38b9204f335dc4742))
* **core:** wire embed+MiniSearch rebuild into setup, librarian, heal ([a430a3a](https://github.com/equationalapplications/expo-llm-wiki/commit/a430a3a228955349e5e86cdbe9eb54d1c039e06b))

# [2.4.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.3.0...v2.4.0) (2026-05-02)


### Bug Fixes

* ./react entrypoint re-exports @eq/wiki-expo; remove @eq/wiki-react optional peer ([a2c85e3](https://github.com/equationalapplications/expo-llm-wiki/commit/a2c85e3b4d2ba3a0a21325b7d84d683d7b9c4ada))
* address code review issues [#1](https://github.com/equationalapplications/expo-llm-wiki/issues/1)-5 (round 2) ([dc142f2](https://github.com/equationalapplications/expo-llm-wiki/commit/dc142f2ea18eb081d933646b8511c7e81ff11bdf)), closes [#1-5](https://github.com/equationalapplications/expo-llm-wiki/issues/1-5)
* address code review issues [#1](https://github.com/equationalapplications/expo-llm-wiki/issues/1)-6 ([1317e56](https://github.com/equationalapplications/expo-llm-wiki/commit/1317e56b09befc8ed7bb538d0a1fc5e53365901f)), closes [#1-6](https://github.com/equationalapplications/expo-llm-wiki/issues/1-6) [#6](https://github.com/equationalapplications/expo-llm-wiki/issues/6)
* address pr review issues [#1](https://github.com/equationalapplications/expo-llm-wiki/issues/1)-6 (adapter claims, type fields, react re-export, examples) ([e3111c3](https://github.com/equationalapplications/expo-llm-wiki/commit/e3111c3e2b5253306c0e6390a56cd6d69d64dd65)), closes [#1-6](https://github.com/equationalapplications/expo-llm-wiki/issues/1-6)
* address review feedback - expo re-exports react hooks, correct README examples ([0a2020b](https://github.com/equationalapplications/expo-llm-wiki/commit/0a2020ba20440e81ac4644bdf77bf122b9715ef2))
* backward-compat createWiki, optional react peer, full hook tests, fix vitest glob ([6ec8825](https://github.com/equationalapplications/expo-llm-wiki/commit/6ec882568ef19944f4bdfa25ee9d97c3837ba056))
* **ci:** clarify shell var expansion in workspace publish step ([c4a255e](https://github.com/equationalapplications/expo-llm-wiki/commit/c4a255e4d09ca1e03b3665b74c2a1eada51d947c))
* **ci:** include workspace versions in release tag; add expo adapter tests ([53af260](https://github.com/equationalapplications/expo-llm-wiki/commit/53af2602daad8040613464969dae20c7dfed7bfe))
* **ci:** publish all workspace packages in release workflow ([f8586cc](https://github.com/equationalapplications/expo-llm-wiki/commit/f8586ccb6e44eca990dd881b04ebffc61aa0df6f))
* **ci:** publish packages in dependency order, fix quoting, fix react peer ([aebc1b2](https://github.com/equationalapplications/expo-llm-wiki/commit/aebc1b2e55721845894c810547eab99303cb9b1a))
* clean up workspace root package.json ([140fd7e](https://github.com/equationalapplications/expo-llm-wiki/commit/140fd7e3b1780455645e7cebe3d4434ec6d0658c))
* **core:** align dep versions and fix tsconfig rootDir conflict ([18ea207](https://github.com/equationalapplications/expo-llm-wiki/commit/18ea207e199f98a04a3bd6bf66f563fd5faf1183))
* **core:** remove expo-sqlite references from test suite ([2a73b20](https://github.com/equationalapplications/expo-llm-wiki/commit/2a73b200067b1fc92ebdedbdf5468e301ec6088c))
* decouple ./react from expo, fix README heading and sourceRef examples ([0bbb493](https://github.com/equationalapplications/expo-llm-wiki/commit/0bbb493bdf2009a6b22f27c623987c22267dfa00))
* disable React hook tests due to vitest 4.1.5 + React 19 + jsdom incompatibility ([b6366e5](https://github.com/equationalapplications/expo-llm-wiki/commit/b6366e5f47a1d0331da14211944de71cd14209cc))
* expo/factory subpath for React-free createWiki, README headings, vitest env isolation ([31ec862](https://github.com/equationalapplications/expo-llm-wiki/commit/31ec86203c4163dfc9a60bf84436277245950eaf))
* **expo:** remove type casts from withTransactionAsync adapter ([4f3cb90](https://github.com/equationalapplications/expo-llm-wiki/commit/4f3cb905e5762dacc9ce8a435da311fbcbc6249d))
* extract RELEASE_VERSION once with empty-string guard in publish step ([276ef62](https://github.com/equationalapplications/expo-llm-wiki/commit/276ef62b881e0dd4625f79b5869787b9f77a70c0))
* generateText return in expo README; move @eq/wiki-react to optional peerDep ([44143bd](https://github.com/equationalapplications/expo-llm-wiki/commit/44143bdc3a09ac341cfb0a00e07bf1c1da7a88da))
* narrow ./react subpath to React hooks only; fix release version from git tag ([cb39f32](https://github.com/equationalapplications/expo-llm-wiki/commit/cb39f32fa8e160549ee08bbe1f6db6bf8bba2d8a))
* patch on-disk package.json version to RELEASE_VERSION before pnpm publish ([7f15ae3](https://github.com/equationalapplications/expo-llm-wiki/commit/7f15ae3660a8489d883c91eb4e76151767006ea7))
* react README setup example, root entry React isolation, add react hook tests ([f87599c](https://github.com/equationalapplications/expo-llm-wiki/commit/f87599c135d075c82808811d9cc80e25a43675dd))
* **react:** put types first in exports field for Node16 compat ([b40b63d](https://github.com/equationalapplications/expo-llm-wiki/commit/b40b63d80835aee2c008f52b4ead4401cd3d718b))
* readme doc fixes and release workflow pnpm upgrade ([9bf50d1](https://github.com/equationalapplications/expo-llm-wiki/commit/9bf50d1c971741f504b494108505593d02fc17f8))
* remove runtime deps from workspace root ([d26dead](https://github.com/equationalapplications/expo-llm-wiki/commit/d26dead3d3d6463197a1eff938156daf1f259d6c))
* use sql.js getRowsModified() in runAsync adapter example ([83d3dfd](https://github.com/equationalapplications/expo-llm-wiki/commit/83d3dfd8b9b85102336bc6dd68abc946f46f507a))


### Features

* **core:** add SQLiteAdapter interface and core types ([d728921](https://github.com/equationalapplications/expo-llm-wiki/commit/d728921de1c66ce437fe0c235132ed5b3cea712f))
* **core:** add utils and index — @eq/wiki-core buildable ([8825405](https://github.com/equationalapplications/expo-llm-wiki/commit/882540509cc64ea36d7158f9a1e3971d630afc0f))
* **core:** move db schema and migrations to @eq/wiki-core ([445f437](https://github.com/equationalapplications/expo-llm-wiki/commit/445f437fc66149716a7d653823618a39abfa71b3))
* **core:** move WikiMemory to @eq/wiki-core with SQLiteAdapter ([9b0481f](https://github.com/equationalapplications/expo-llm-wiki/commit/9b0481f7552013b1053eb32e1e1d86ac4e4a9630))
* **expo:** add @eq/wiki-expo with expo-sqlite adapter ([6c5fa8f](https://github.com/equationalapplications/expo-llm-wiki/commit/6c5fa8faedfd7beb850e0cb19103ce0f9ac8688b))
* make root a backward-compat alias pointing to workspace packages ([bc4c6a7](https://github.com/equationalapplications/expo-llm-wiki/commit/bc4c6a7bcbb2ed346e88d6de55c48e58f9fb0c45))
* **react:** add @eq/wiki-react hooks package ([2ed2727](https://github.com/equationalapplications/expo-llm-wiki/commit/2ed2727cf370d0685071bbc7855204b884970e63))

# [2.3.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.2.0...v2.3.0) (2026-05-01)


### Bug Fixes

* address code review feedback on v2.2.0 ([b3da2e6](https://github.com/equationalapplications/expo-llm-wiki/commit/b3da2e678eac84901a23a93aac27a99473368eca))
* derive CURRENT_SCHEMA_VERSION from MIGRATIONS and assert strictly-increasing order ([d1f3a87](https://github.com/equationalapplications/expo-llm-wiki/commit/d1f3a87832b20ecb7e39e1bb0bf328136667792f))
* indent multi-line body/description/summary continuation lines in markdown renders ([836bab4](https://github.com/equationalapplications/expo-llm-wiki/commit/836bab4fbec333167f9f7eeb0945edde27c93792))
* **package:** use npx tsc in typecheck script to avoid global tsc v4 ([49562a0](https://github.com/equationalapplications/expo-llm-wiki/commit/49562a0b77ebf6e34839262c07cc03cd3fa043f3))
* re-export MaintenanceResult from src/react/index.ts barrel ([9a424db](https://github.com/equationalapplications/expo-llm-wiki/commit/9a424db11c57c54f7ae10fd4051017fec21b8b37))
* remove redundant npx from typecheck script ([0d4c391](https://github.com/equationalapplications/expo-llm-wiki/commit/0d4c391439f4b95bd3b4a994a1d04ef9f24f00d4))
* **test:** disambiguate indexOf for priority tie-break; suppress moduleResolution deprecation warning ([921d56d](https://github.com/equationalapplications/expo-llm-wiki/commit/921d56d1915bf4a17ec113c1bba5abf422bceec9))
* **tsconfig:** upgrade moduleResolution to node16 ([364a9b3](https://github.com/equationalapplications/expo-llm-wiki/commit/364a9b3299a6dd429819af67e110ac28216809fb))
* **tsconfig:** use moduleResolution bundler for ESNext/Expo compatibility ([1f5c998](https://github.com/equationalapplications/expo-llm-wiki/commit/1f5c998c250583b66f1de36598d63bd40aaa4b4b))
* update sourceHash error message and validate runPrune option values ([4a0f4c2](https://github.com/equationalapplications/expo-llm-wiki/commit/4a0f4c20d7e4b9ca2422166b0b4b49836e4726e4))
* use undefined instead of void in MaintenanceResult discriminated union ([05f7fc4](https://github.com/equationalapplications/expo-llm-wiki/commit/05f7fc4322e1ff5cad034d57bed89beb8aa09f3b))
* WikiBusyError reports blocking operation, not requested operation ([827e7f8](https://github.com/equationalapplications/expo-llm-wiki/commit/827e7f8031514847d1d6f773a72fe5847c41af93))


### Features

* **db:** add meta table and migration registry; refactor setup() to version-driven migrations ([fa70c22](https://github.com/equationalapplications/expo-llm-wiki/commit/fa70c2286bb0642b92679f8dfdf639826677ea03))
* **react:** add useWikiHasChanged hook; extend useWikiMaintenance with runPrune ([c01a8f0](https://github.com/equationalapplications/expo-llm-wiki/commit/c01a8f0ed71c17ddb53ab3e3ad3cc9ed59a15890))
* **utils:** add formatContext for LLM prompt injection ([0a44f6e](https://github.com/equationalapplications/expo-llm-wiki/commit/0a44f6ee66aec38aa0fd4afce4b1b1dd956848e9))
* validate maxFacts/maxTasks/maxEvents in formatContext; throw for negative/non-finite values ([9793e25](https://github.com/equationalapplications/expo-llm-wiki/commit/9793e25e5b9bf8dada4d1588563b942a8568134f))
* **wiki:** add hasChanged() for skip-ingest on unchanged sources ([d1e2899](https://github.com/equationalapplications/expo-llm-wiki/commit/d1e28996fca8e2eb5dabf655ea4f300e6af96798))
* **wiki:** add runPrune() for hard-delete of aged soft-deleted rows and events ([db22dd4](https://github.com/equationalapplications/expo-llm-wiki/commit/db22dd49fdeb7fdbdbb0eb56626c5a8277ffec62))

# [2.2.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.1.0...v2.2.0) (2026-05-01)

### Features

* **utils:** add `formatContext(bundle, options?)` for LLM prompt injection with confidence/recency/access-count ranking
* **wiki:** add `hasChanged(entityId, sourceRef, sourceHash)` to skip re-ingest of unchanged documents
* **wiki:** add `runPrune(entityId, options?)` to hard-delete aged soft-deleted entries/tasks and old events; activates previously dead `pruneEventsAfter` config key
* **db:** schema versioning via `{prefix}meta` table; migrate porter rebuild to numbered migration registry
* **react:** add `useWikiHasChanged` hook
* **react:** extend `useWikiMaintenance` with `runPrune`; `lastResult` now carries `{ entries, tasks, events }` counts after a prune
* **types:** add `FormatContextOptions`, `pruneRetainSoftDeletedFor` config key, extend `WikiBusyError` operation union with `'prune'`

### Bug Fixes

* **wiki:** `runPrune` used `SELECT COUNT` + conditional `DELETE` per table; replaced with single `DELETE` using `result.changes` — eliminates 3 extra round-trips and closes a soft-delete/hard-delete race between the two statements
* **wiki:** prune lock was one-way; `runLibrarian`, `runHeal`, auto-librarian, and `ingestDocument` now block when a prune is active for the same entity, making the mutex fully bidirectional
* **utils:** `formatContext` plain mode emitted no section labels, making facts/tasks/events indistinguishable; restored `KNOWN FACTS:` / `OPEN TASKS:` / `RECENT EVENTS:` headings
* **utils:** `formatContext` markdown mode lacked blank lines between `## Memory` and each `###` section; blank line separators restored
* **utils:** `Date.now()` was called inside the fact sort comparator (O(N log N) times); captured once before sort

### Internal

* **tsconfig:** `moduleResolution` flipped from `node` to `bundler` to support `import type * as SQLite` from `expo-sqlite`

# [2.1.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.0.2...v2.1.0) (2026-05-01)


### Bug Fixes

* align FTS rebuild to match trigger behavior; drop lint from plan; clean imports ([e7ed13f](https://github.com/equationalapplications/expo-llm-wiki/commit/e7ed13fa083fd9931651b1b602a73c12bf72eaa6))
* **import:** deduplicate synonym values; batch-load updated_at for LWW; cache after write for intra-bundle dupes ([23d3004](https://github.com/equationalapplications/expo-llm-wiki/commit/23d300434fdad9ae770e0edd9514b20571fa68ef))
* **import:** guard LWW updated_at against NaN/non-finite; add regression tests ([84ce5e9](https://github.com/equationalapplications/expo-llm-wiki/commit/84ce5e96d76c6129f8eb753a22cddee98599394b))
* normalize updated_at once per row; persist safe value (0) not NaN to DB ([5de01b3](https://github.com/equationalapplications/expo-llm-wiki/commit/5de01b32a53bc0fd766e622f165c9bb28678d733))
* sanitize synonym values via normalizeTokens; guard with Array.isArray and typeof string ([f8de488](https://github.com/equationalapplications/expo-llm-wiki/commit/f8de488fc868f65e13ebc28000f0eb225e7be1e6))
* **setup:** use regex for porter tokenizer detection to prevent false positives ([3a076c1](https://github.com/equationalapplications/expo-llm-wiki/commit/3a076c13f140af5a9a96fa7bdf71de86243b0375))


### Features

* **fts:** add porter tokenizer to entries_fts ([8e03fa7](https://github.com/equationalapplications/expo-llm-wiki/commit/8e03fa760e4a656b2b101d5ebe8ede7e52786817))
* **import:** row-level LWW merge for facts and tasks by updated_at; lock event append-only dedup contract ([7a8b77e](https://github.com/equationalapplications/expo-llm-wiki/commit/7a8b77e0d5ef5f874d5e72545fc941a3912a0226))
* **search:** synonymMap expansion with 12-token cap ([c2a877a](https://github.com/equationalapplications/expo-llm-wiki/commit/c2a877aab335843f56c6d16f3e4ba375e7bd3614))
* **setup:** rebuild pre-porter FTS5 table inside transaction ([aac7e8b](https://github.com/equationalapplications/expo-llm-wiki/commit/aac7e8bbceac884cc24129d96fb83e13eb2e40fd))
* **types:** add WikiConfig.synonymMap ([fde85e8](https://github.com/equationalapplications/expo-llm-wiki/commit/fde85e8f37213109314937e60d200726e45f3075))


### Performance Improvements

* break synonym inner loop when pushNormalized returns false (cap reached) ([2b2b7f0](https://github.com/equationalapplications/expo-llm-wiki/commit/2b2b7f029b17a84e88a82b60348d3a904b3c2f9a))
* use pushNormalized return value to skip synonym lookup when cap reached ([b8d21f9](https://github.com/equationalapplications/expo-llm-wiki/commit/b8d21f9b9ec74fefff8e5e334d49af4d10384184))

## [2.0.2](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.0.1...v2.0.2) (2026-04-30)


### Bug Fixes

* add registry to publishConfig ([386aff2](https://github.com/equationalapplications/expo-llm-wiki/commit/386aff2df6bcd114c5f3f57b49b0796633147760))
* **ci:** add explicit repositoryUrl to semantic-release config ([4a5d07d](https://github.com/equationalapplications/expo-llm-wiki/commit/4a5d07d602cf9c610801fa7607a578405973fbc2))
* **ci:** retrigger release with updated NPM_TOKEN ([17556c7](https://github.com/equationalapplications/expo-llm-wiki/commit/17556c70b1c91a638158eae07ed1e48ed02babbd))

## [2.0.1](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.0.0...v2.0.1) (2026-04-30)


### Bug Fixes

* **ci:** pass NPM_TOKEN to semantic-release publish step ([752fdd9](https://github.com/equationalapplications/expo-llm-wiki/commit/752fdd93c023a5df8d611ca760bfe66df4551997))

# [2.0.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v1.1.0...v2.0.0) (2026-04-30)


### Bug Fixes

* add cross-entity collision warnings, fix comment accuracy ([7bf0b04](https://github.com/equationalapplications/expo-llm-wiki/commit/7bf0b0493e60f8ed2d36b56928d4ec581c374cab))
* auto-heal mutex, full event export, useWikiExport hook contract ([2f99606](https://github.com/equationalapplications/expo-llm-wiki/commit/2f99606f7c2c6c44a5872948dfd9a31129feba2e))
* coerce fact.tags to array before JSON.stringify in importDump ([f795a6d](https://github.com/equationalapplications/expo-llm-wiki/commit/f795a6d2bbe3e912de87064a664ae5250cf61691))
* correct reserved-chars comment to ~20, document merge-skips-soft-deleted intent ([11067cf](https://github.com/equationalapplications/expo-llm-wiki/commit/11067cf5e6888b6d62168603da1038acdcb7ba12))
* exportDump concurrency limit, importDump PK safety, 64-bit shortHash, filename length cap ([fabeb50](https://github.com/equationalapplications/expo-llm-wiki/commit/fabeb507f3d1eb5948c237c5d796db62579a54d4))
* move MockSQLiteDatabase inside vi.mock factory, use dynamic imports for WikiMemory ([b8d10d3](https://github.com/equationalapplications/expo-llm-wiki/commit/b8d10d3cabbd1f5dd4eee88e9385c7e1bce98c05))
* remove chunkText public export, clamp chunkOverlap, expand expo-sqlite peer range ([8ac595c](https://github.com/equationalapplications/expo-llm-wiki/commit/8ac595cddc244e4ce89db149e95744e2115838c3))
* use slice().reverse() to avoid mutating DB result array ([9345228](https://github.com/equationalapplications/expo-llm-wiki/commit/9345228c70596e2e7dff10e9b6ee9255fd99e8a8))
* **wiki:** abort withConcurrency on first error, normalize chunkConcurrency ([6a23781](https://github.com/equationalapplications/expo-llm-wiki/commit/6a237818719044ed0852f0b9a15443ad0eb50449))
* **wiki:** getEntityStatus key scanning and exportDump ordering ([7eefeed](https://github.com/equationalapplications/expo-llm-wiki/commit/7eefeeddfeeb1e75e988864130aab9f626b32163))


### Documentation

* add badges, update defaults, and attribution footer ([765b54c](https://github.com/equationalapplications/expo-llm-wiki/commit/765b54c81c38c1d276f15b321f8a66d7aef391d4))


### Features

* **react:** add useWikiExport hook ([b5a6f00](https://github.com/equationalapplications/expo-llm-wiki/commit/b5a6f00829ed2260c78798605d1ea4b13aab5542))
* **wiki:** add chunkText helper with paragraph-first splitting and overlap ([57e228e](https://github.com/equationalapplications/expo-llm-wiki/commit/57e228e095b521be548836823d361f223fc64727))
* **wiki:** add formatMemoryDump pure helper ([3f6e72a](https://github.com/equationalapplications/expo-llm-wiki/commit/3f6e72a0fe90daa8e04b08d445dd5eb26fde5e4c))
* **wiki:** add getEntityStatus snapshot ([b0c7b16](https://github.com/equationalapplications/expo-llm-wiki/commit/b0c7b16ad1d114d9eb05260514dc1c16b7173391))
* **wiki:** add importDump method ([12a39db](https://github.com/equationalapplications/expo-llm-wiki/commit/12a39db2fd381d64fc9caafeca204069933877b6))
* **wiki:** add MemoryDump type and exportDump method ([995bc75](https://github.com/equationalapplications/expo-llm-wiki/commit/995bc75f0b57ec3e97cd206c5b67ab57462aab39))
* **wiki:** add type definitions and prompt annotations ([03a625a](https://github.com/equationalapplications/expo-llm-wiki/commit/03a625a34e95efe56971c70923b7d5a3df78ab2d))
* **wiki:** add WikiConfig.chunkOverlap ([52ebe12](https://github.com/equationalapplications/expo-llm-wiki/commit/52ebe122b4bde0b7ee2f0925eca9edd5c8b19d9b))
* **wiki:** parallel ingest, chunkText integration, cross-chunk dedup, ingest job guard ([58b7357](https://github.com/equationalapplications/expo-llm-wiki/commit/58b73576a27000228446c67fbbc742eee19927d7))
* **wiki:** raise fact body budget 200 -> 800 chars ([a89b596](https://github.com/equationalapplications/expo-llm-wiki/commit/a89b59625f5b25e568def2ab45aed829e687718c))
* **wiki:** split librarian/heal mutex keys, add WikiBusyError ([6956182](https://github.com/equationalapplications/expo-llm-wiki/commit/6956182e2f9e39afbe7cf43ed431af81b384b78b))


### BREAKING CHANGES

* runLibrarian() and runHeal() now throw WikiBusyError when a run is already active for that entity and operation, instead of silently returning.

# [1.1.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v1.0.0...v1.1.0) (2026-04-30)


### Bug Fixes

* **db:** fix backslash JS escape in source_ref migration SQL ([bae3306](https://github.com/equationalapplications/expo-llm-wiki/commit/bae3306d5a6189f0a34c591d396dad6fdd8dcae7))
* **db:** improve migration comment clarity in setupDatabase ([bc09984](https://github.com/equationalapplications/expo-llm-wiki/commit/bc099844655157bafbcc9af1654e3bc00e6f1aa8))
* **db:** migrate existing source_ref values on setup to match normalizeSourceRef ([32b855d](https://github.com/equationalapplications/expo-llm-wiki/commit/32b855d02ca8a57248df65f307f49bfa74c7fe34))
* **deps:** bump react to 19, add expo/react-native dev deps ([d1e854d](https://github.com/equationalapplications/expo-llm-wiki/commit/d1e854d5258025aa6df06b99c3f0bf6dede28699))
* ensure scoped package publishes to npm ([d58aa66](https://github.com/equationalapplications/expo-llm-wiki/commit/d58aa6621fad1e8485c26fbf279fbc42e88b3e51))
* **hooks:** rethrow errors in useWikiMaintenance runLibrarian/runHeal ([1cb4787](https://github.com/equationalapplications/expo-llm-wiki/commit/1cb47877325d354b0b3bf1061f6352878a561c90))
* **ingest:** include actual type in documentChunk validation error message ([04c69e1](https://github.com/equationalapplications/expo-llm-wiki/commit/04c69e1f44776415075edcc810ccb64748177710))
* **ingest:** validate documentChunk is a string before chunking loop ([e1c5401](https://github.com/equationalapplications/expo-llm-wiki/commit/e1c5401d23ac33af30c1724107c9725223bc42aa))
* update parseJsonResponse errors and README sourceRef normalization notes ([22f9252](https://github.com/equationalapplications/expo-llm-wiki/commit/22f925268a1cddb58b11dcd30f4aa922eb5a7cf7))
* use Array.isArray guards for LLM result arrays; add string check to normalizeSourceHash ([b63eb8b](https://github.com/equationalapplications/expo-llm-wiki/commit/b63eb8b9f03eebf1b08ca32a9fb2955dda5265ba))
* widen normalizeSourceHash param to unknown to match runtime validation ([369afeb](https://github.com/equationalapplications/expo-llm-wiki/commit/369afebf3b12ac6a005a0cabf90b90c7069a2b6a))
* **wiki:** address PR review feedback on memory hardening ([b9e57c7](https://github.com/equationalapplications/expo-llm-wiki/commit/b9e57c78495245ec5559c8a6c51b4da39d4a8747))
* **wiki:** address second PR review feedback ([6f3df98](https://github.com/equationalapplications/expo-llm-wiki/commit/6f3df98faf8625471f28aa28ebe43e149c8ae85f))
* **wiki:** align normalizeSourceRef to allowlist and migrate existing rows via JS ([d8a5a4b](https://github.com/equationalapplications/expo-llm-wiki/commit/d8a5a4b92a87675c67586f6a812157b2a8d2b446))
* **wiki:** align normalizeSourceRef with hardening spec ([1b2d6a0](https://github.com/equationalapplications/expo-llm-wiki/commit/1b2d6a0e887d0662942312763332ef56423eeb4f))
* **wiki:** apply PR hardening review feedback ([b0c9992](https://github.com/equationalapplications/expo-llm-wiki/commit/b0c9992a235d3daa59a8c836ebeba93cdd23d60e))
* **wiki:** fix chunking boundary, execute return types in hooks ([4a5afc2](https://github.com/equationalapplications/expo-llm-wiki/commit/4a5afc2695eecda49cae74f84a9b1c30bfbcd12a))
* **wiki:** fix GLOB pattern to include space in allowlist; use per-row timestamp ([78150a1](https://github.com/equationalapplications/expo-llm-wiki/commit/78150a1d46f8049bd983f9f4be2b6fa98d022771))
* **wiki:** merge duplicate safeSlice into single implementation ([5d2f926](https://github.com/equationalapplications/expo-llm-wiki/commit/5d2f926d67c2261a099916227bf8eff40dda500f))
* **wiki:** move hyphen to end in GLOB class; wrap migration updates in transaction ([70898d2](https://github.com/equationalapplications/expo-llm-wiki/commit/70898d24b25ff3b2b66e5c244896dd281460a1d5))
* **wiki:** remove definite assignment assertions in parseJsonResponse ([56664ca](https://github.com/equationalapplications/expo-llm-wiki/commit/56664ca8241dd07dc5ec7a554f5ab69415a55723))
* **wiki:** use stack-based JSON extraction in parseJsonResponse to handle trailing braces ([9f48747](https://github.com/equationalapplications/expo-llm-wiki/commit/9f4874703a515717aa0a4820d2ba5d18372e8e7d))
* **wiki:** use unambiguous [^-A-Za-z0-9._ ] GLOB char class for migration pre-filter ([0b7292d](https://github.com/equationalapplications/expo-llm-wiki/commit/0b7292d6611512b6c5db794694ca416bf2f3232f))


### Features

* implement memory hardening spec ([c37c22b](https://github.com/equationalapplications/expo-llm-wiki/commit/c37c22bfd6c7b6727663b76a0f6252d62dbf36d6))


### Performance Improvements

* **wiki:** add WHERE pre-filter to source_ref migration to avoid scanning all rows ([d84dc13](https://github.com/equationalapplications/expo-llm-wiki/commit/d84dc13cc4ab18b1a9d0d5aeb9d5bac423b1fa12))
