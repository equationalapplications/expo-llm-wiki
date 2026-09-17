# Native GraphRAG Engine: Vertical Slice & Boundary Design

**Date:** 2026-09-17
**Status:** Draft revision 4 — review rounds 1–3 incorporated; ready for plan on approval; native direction accepted, implementation not started
**Builds on:** [Knowledge Graph Traversal API](./2026-06-23-graph-traversal-api-design.md) (implemented); precedence is defined in REQ-DOC-01.
**Branch:** `spec/native-graphrag-vertical-slice`
**Repository:** `expo-llm-wiki` (authoritative shared contract)
**Source baseline:** `2e7d9bacbf1f5128a3021a48b1f138f44c7c057f` (core 7.1.1)

## 1. Decision and scope

Build a portable Rust GraphRAG engine owned by this repository. Prove one read-only fact-neighborhood operation in native CT and React Native before committing to a full engine migration. The slice is a retained implementation with explicit adoption gates, not approval for a wholesale rewrite.

The objectives are shared semantics, independent headless distribution, and removal of renderer-authored SQL from privileged interfaces during the subsequent migration. CT's existing SQL bridge is an overly powerful interface; this spec does not claim a demonstrated exploitable vulnerability. SQL execution already occurs in native SQLite. Moving query strings into a package without moving its execution outside the renderer does not change that trust boundary.

### Ownership [REQ-OWN-01]

- The shared native core owns graph algorithms, graph SQL, typed results, and operation-level consistency contracts. Reusable retrieval and mutation semantics follow in later slices.
- The core has no Tauri, windowing, Node, or React Native dependency. Rust CLI/MCP consumers link it directly.
- Platform bindings adapt the shared implementation; they must not become independently maintained graph engines.
- Hosts own caller permissions, permitted database/vault selection, credentials, UI, and connection lifecycle. The shared crate must not discover `~/.brain`, select a vault, or consult CT environment variables.
- Existing TypeScript/Expo APIs remain operational during migration. Native-backed JS APIs are the target for supported platforms, not an immediate breaking replacement. Browser/WASM and Node binding support require later platform decisions; this slice does not silently drop existing consumers.

### Consumer responsibilities [REQ-OWN-02]

| Repository | Responsibility |
|---|---|
| expo-llm-wiki | Canonical contracts, native crate, compatibility fixtures, binding proof, upstream acceptance evidence |
| curated-thoughts | Typed Tauri integration, direct Rust headless consumption, vault/connection ownership, desktop and headless packaging |
| clanker | Expo/React Native binding integration, existing SQLite interoperability, iOS/Android acceptance evidence |
| curated-thoughts-integrations | Compatibility consumer: preserve MCP contracts and account for read-only schema/provenance diagnostics |

In-repository compatibility consumers include `packages/react/src/useWikiTraversal.ts`, core's exported `formatGraphContext`, and `core-llm-tools`' `wikiTraverseGraphManifest` (`memory:read`). Preserve their existing API/DTO expectations and test them against representative native results. A tool manifest is a schema declaration, not proof that its host executor performs runtime validation; native boundary validation remains mandatory.

CT's current headless binaries do not require a running desktop, but their builds still inherit Tauri dependencies. A Tauri-independent crate is not proof that CT's entire existing executable is dependency-free. Separate desktop/CLI processes also retain separate connections and require SQLite/lifecycle coordination.

## 2. Bounded operation

### Contract [REQ-SLICE-01]

Implement `traverse_graph_neighborhood` as the native equivalent of core 7.1.1's public `WikiMemory.traverseGraph` operation. Its input/output mapping is defined by the pinned baseline's `GraphTraversalOptions`, `GraphNeighborhood`, `WikiFact`, and `WikiEdge` declarations in `packages/core/src/types.ts`, and by:

- `packages/core/src/services/GraphTraversalService.ts`
- `packages/core/src/repositories/EdgeRepository.ts` (`getNeighborhood`)
- `packages/core/src/repositories/EntryRepository.ts` (fact hydration)

Use the existing entity scope and source fact identifiers, not a new generic `root_record_id`. Native naming may use snake_case, but the JS binding preserves existing field meanings. The verified public call is `traverseGraph(entityId, options)`, with required `sourceId` and optional `maxDepth`, `direction`, `edgeTypes`, `maxTraversalNodes`, `minTraversalConfidence`, and `excludeSourceTypes`. Direction already supports `inbound`, `outbound`, and `both`; it is not a new feature.

The compatibility contract is:

- Depth defaults to 1 and is clamped with `Math.max(1, Math.min(maxDepth ?? 1, 3))`, without integer rounding. Preserve finite fractional input behavior: accept `f64` at the native boundary and bind the clamped real-valued bound to `depth < bound`, or use its ceiling for an integer-depth walk. For example, 1.5 allows discovery at depth 2. Never truncate before traversal or substitute an integer-only wire type. Reject non-finite numbers at the native boundary as an explicit input-hardening difference, not a successful parity case.
- Direction resolves from call option, then engine configuration, then `both`. Minimum confidence resolves similarly, defaulting to `tentative`; excluded source types default to an empty list. An explicit empty exclusion list overrides configuration.
- The node cap includes the root and defaults to 20. Configuration/call values must be finite and at least 1 to apply, and are floored; invalid call values fall back to the sanitized configuration default. There is no API-level fixed upper cap or edge-count cap, but the baseline's unchunked induced-edge query binds one variable per selected node plus entity and can exceed the connection's variable limit. Preserve normalization, not that failure; REQ-SCALE-01 defines the native correction. Any deployment-specific cap must be declared separately, not presented as parity.
- A well-formed source ID that names a missing, deleted, or foreign-entity root returns empty nodes/edges; malformed or empty IDs instead follow REQ-INPUT-01. A valid root is retained even when isolated or excluded by confidence/source-type criteria. Those exemptions do not extend to other nodes. **Anchor node first** is a public ordering guarantee. The baseline can lose the root between walk and hydration during concurrent deletion; the native snapshot contract prevents that inter-query inconsistency.
- `edgeTypes` is a per-call list of opaque persisted strings. Omission means no discovery filter; an explicit empty list returns only the valid root and no edges, including no self-loop. Unknown types are not errors, and strings are not trimmed or case-normalized.
- Discovery follows the requested direction and filters, and cannot pass through missing, deleted, foreign-entity, low-confidence, or excluded-source-type facts. Confidence order is tentative < inferred < certain; unknown stored confidence ranks below tentative.
- After discovery, unique nodes are ordered by shortest discovered depth ascending, then `updated_at` descending, and only then capped. Equal-depth/equal-timestamp ties are unspecified. The cap is a result limit, not an early traversal-work limit.
- Returned edges form the induced subgraph on the selected nodes within the entity: the final edge query does **not** reapply discovery direction or `edgeTypes`. Reverse, nonrequested-type, cycle-closing, and self-loop edges may be returned. Preserve this distinction and the explicit-empty-filter exception. Edges have no baseline ordering guarantee.
- Hydration preserves selected node order and returns the full `WikiFact` DTO, not raw database rows or a reduced node type. Missing facts are omitted without refill; edges whose endpoints did not hydrate are dropped. The DTO excludes `embedding_blob`, normalizes metadata, and derives staleness/trust fields. Baseline `findByIds` deterministically maps rows in selected-node order, sampling the clock once per row at mapping time; native must map and sample in the same order. Native tests use an injectable clock, never JS-controlled production time: a fixed clock for ordinary fixtures, and a scripted advancing clock for staleness boundaries — which becomes a deterministic test under this ordering contract. This pins today's single-threaded mapper; a future parallel hydration design must preserve the contract or be revised explicitly.
- The root, traversed edges, discovered nodes, final edges, and hydrated facts remain in the single requested entity. There is no cross-partition mode in this operation.

The baseline cycle guard uses a comma-delimited visited string although IDs are API strings. A root `a,b` can incorrectly suppress a distinct neighbor `a`. Native traversal must treat IDs as opaque strings and use collision-free identity tracking; this is a declared baseline-defect correction, covered by separate expected native results, not silently called parity.

The baseline CTE's `UNION` deduplicates `(node_id, depth, visited)`, not node IDs alone. It enumerates alternative simple paths through depth 3 before grouping/capping; a small output cap does not bound that work. A native breadth-first per-node visited set (or equivalent shortest-depth algorithm) is permitted and preferred to avoid repeated path expansion. It must preserve reachable nodes, shortest depths, gates, ordering/capping, and the final induced-edge set. Mark nodes on breadth-first discovery, not arbitrary depth-first discovery. Output may differ only in explicitly declared defect/input cases or unspecified ties; compute-work parity is not required.

This operation concerns core's fact graph. It is not an alias for CT's entity-seeded cross-partition traversal, structural chunk impact graph, or semantic-search/context pipeline. Those contracts must not be substituted for each other merely because each returns nodes and edges.

The native implementation owns traversal and SQL and binds data values. A recursive CTE is the baseline mechanism, not a mandatory native implementation: a breadth-first Rust walk over native SQL queries is allowed under the semantic constraints above. The complete operation includes node selection, edge retrieval, and fact hydration; it is not required to be a single SQL statement. Do not advertise the existing implementation as one total query simply because its walk uses a recursive CTE.

### Native input matrix [REQ-INPUT-01]

Validation applies to native public entrypoints, JS/IPC decoding, and host defaults. TypeScript types alone are not validation. Reject malformed inputs with a structured `invalid_argument` error identifying the field before traversal SQL executes.

| Field/case | Native rule and compatibility status |
|---|---|
| `entityId`, `sourceId` | Required nonempty strings. Reject missing, null, non-string, and empty values. Preserve other contents without trimming, UUID checks, or delimiter bans. Baseline binds these without validation and may return empty/matching rows or adapter-dependent errors: rejection is a declared difference. |
| Options container | Required object, not null/array/scalar. Reject malformed containers rather than reproducing JS property-access failures. |
| Optional fields omitted/null | Treat as absent for existing nullish-defaulted fields (depth, direction, confidence, exclusions, cap). Null `edgeTypes` also means absent, matching baseline falsy no-filter behavior. |
| `maxDepth` | Finite number only when provided; reject other types, NaN, and infinities. Preserve finite clamping/fractions. Direct/native tests cover non-finite values that ordinary JSON cannot represent. |
| `direction` | Only `inbound`, `outbound`, `both`. Unknown baseline strings effectively traverse both directions; native rejection is a declared difference. |
| `minTraversalConfidence` | Only `certain`, `inferred`, `tentative`. Baseline invalid values produce an undefined rank (NULL or a binding error depending on adapter), not a reliable validation error; native rejection is a declared difference. |
| `edgeTypes` | Array of strings; preserve empty array, opaque strings, duplicates, and no normalization. Reject nonarrays/non-string members. |
| `excludeSourceTypes` | Array of strings; reject only nonarrays and non-string members. Treat values as opaque text, like `edgeTypes`: unknown values are valid and simply match nothing. Baseline has no runtime enum (the column is unconstrained TEXT; only the OKF import path validates), so strict native enum rejection would be a capability regression, not hardening. Empty array excludes nothing. |
| `maxTraversalNodes` | Preserve sanitized fallback/floor behavior, including invalid nonnumeric/non-finite values falling back rather than failing deserialization. Decode the JSON number as binary64 (`f64`, JS `Number` semantics) — never a direct i64 read — so values between 2⁵³ and 2⁶³ round identically to baseline; then floor and range-check. Accept floor values within the signed 64-bit range and reject the rest with `unsupported_limit`, never wrapping or silently clamping: on the desktop adapter (measured, better-sqlite3 12.11.1/SQLite 3.53.2) i64-domain values bind to `LIMIT` but 2⁶³ and above fail raw `SQLITE_MISMATCH`, so rejection there matches observed desktop behavior; the mobile adapter's behavior is characterized separately per REQ-SQL-03. Fixtures pin both sides (floor near 2⁵³, 2⁶³, 1e20). |
| Unknown option keys | Ignore, matching property-based baseline consumption; they confer no behavior. |

Test malformed fields with absent roots and empty edge filters: early-return paths must not bypass validation. The frozen TS reference stays unchanged for characterization; native-only validation expectations are not identical-output parity.

### Variable-limit-safe reads [REQ-SCALE-01]

Native must not reproduce the baseline's `N + 1` induced-edge bind ceiling. Use bounded queries respecting the connection limit, within the same snapshot and with full induced-edge semantics. One suitable strategy chunks selected **source** IDs, reads same-entity outgoing edges for each chunk, and keeps only targets in the complete selected-node set. Chunking both endpoints into matching subsets alone loses cross-chunk edges. Deduplicate full edge identities and do not reapply discovery filters.

Keep batch sizes compatible with the baseline where practical: hydration already batches 500 IDs per query (`EntryRepository.chunkSize = 500`), so reuse 500 for hydrated-ID chunks unless a measured reason exists, and keep per-query chunk query counts comparable so REQ-PERF-01's matched suite does not silently attribute a batch-size change to native performance. Document any different batch size as a declared difference. The CTE's discovery-filter lists (`edgeTypes`, `excludeSourceTypes`) are unchunked in the baseline and can hit the same ceiling: bind them in bounded groups that preserve union/exclusion semantics, and cover an oversized `edgeTypes` list with a fixture.

Add a fixture selecting more nodes than the baseline query's variable budget. Prefer a test connection with a deliberately lowered supported limit, plus a real platform-limit case where practical. Record limit and build: 5,000 nodes is not a universal failure threshold. Characterize the unchanged TS error and require the complete native result from an independent oracle. Test cross-chunk edges, self-loops, and fixed-parameter accounting. Variable limits are not API node caps; genuine unsupported resource/representation limits must produce explicit errors, never partial success.

### Compatibility fixtures [REQ-SLICE-02]

Before implementing traversal, derive checked-in JSON fixtures from and cross-check them against `packages/core/__tests__/repositories/EdgeRepository.test.ts`'s real-SQL neighborhood cases, then extend the missing coverage below. Each fixture contains seed state, request, and independently reviewed expectations. Run real SQL and hydration through both implementations; do not generate expectations exclusively from native output. `GraphTraversalService.test.ts` mocks both repositories: it supports option-merging/orchestration claims but is not SQL or end-to-end parity evidence.

Classify fixtures as (a) identical-contract parity, (b) declared native differences, or (c) algorithmic robustness. Category (b) records separate baseline observations and native expectations for invalid inputs, delimiter IDs, variable-limit failure, and snapshot strengthening. Report each category separately; '100% parity' refers only to category (a), not an assertion that baseline defects must pass native expectations.

Cover root-only and missing-root cases, empty neighborhoods, depth boundaries and normalization, cycles/self-loops, diamonds/multiple paths, directed-edge behavior, omitted/empty/nonempty filters, entity isolation, parallel edge kinds, and hydration of absent endpoints where the schema permits such states. Include returned edge attributes and fact payloads, not just IDs.

Define whether each array has an observable ordering guarantee. Where baseline ordering is unspecified, compare sets through a documented canonical sort in the test harness, and use a stable native output order; do not infer traversal priority from incidental SQL row order. Preserve any explicitly guaranteed ordering. Nodes are unique by fact identity within scope; edges by the baseline's full edge identity, not just an endpoint pair. Fixed fixture timestamps and embeddings eliminate incidental nondeterminism.

Concurrent-read snapshot consistency is an explicit native contract in section 3, tested separately from quiescent TS/native semantic parity. Baseline public `traverseGraph` does not start a transaction: its walk, edge query, and hydration are separate reads. Snapshot consistency is therefore a deliberate strengthening, not an existing TS guarantee.

Add fixtures specifically for induced edges outside the discovery filter, explicit-empty filters, root exemptions, fractional depth, node-cap fallback/flooring, time-derived fact fields, capped equal-rank node ties, a persisted out-of-enum `source_type` value (category (a): both engines treat it as opaque text that matches exclusions only on exact equality), and oversized `edgeTypes`/node-count lists per REQ-SCALE-01. Explicit `excludeSourceTypes: []` must exclude nothing: baseline SQLite accepts `NOT IN ()`, but native may omit that predicate instead. Test anchor-first ordering and concurrent root deletion across walk/hydration as part of the snapshot suite. For a tie at the cap boundary, validate the required ordered prefix and membership in the eligible tied group; do not require both engines to choose the same unspecified tied subset. Canonical sorting alone cannot reconcile different valid capped subsets.

### Consumption proof [REQ-SLICE-03]

1. **CT native/headless:** exercise the crate directly from a Rust test or headless executable without GUI initialization, using a fixture database.
2. **CT renderer boundary:** add one bounded typed traversal operation that reaches the shared crate, with an integration caller that sends only typed arguments. Compare it to the existing adapter-backed core traversal. Do not claim an existing production traversal call was replaced unless an actual matching call site is identified. This proof does not require rerouting CT's semantically different MCP traversal.
3. **Clanker:** run the native operation through a minimal binding against an app SQLite database on both iOS and Android. A mock JS module or desktop Node binding is not mobile evidence.

The CT IPC and mobile binding accept no SQL, arbitrary database path, native pointer, or raw table name from JS. Hosts supply a scoped engine handle. Arguments are validated at the native boundary, not only by TypeScript types. Reject malformed values with structured errors; close or invalidate handles when their database lifecycle ends.

## 3. SQLite ownership experiment

### Native host contract [REQ-SQL-01]

Use a borrowed host-provided SQLite connection; the shared engine does not take ownership of CT's connection or open another database implicitly. CT currently uses a mutex-protected database connection, not an established connection pool.

Define two distinct entry paths:

- **Connection entry:** called with exclusive host access to a connection not already in a transaction; the engine begins a deferred read transaction, performs all neighborhood queries in one snapshot, and ends that transaction before returning.
- **Transaction entry:** called with an existing host-owned transaction; the engine performs all reads within it and never commits, rolls back, or starts a nested transaction. The host retains the transaction's lifetime and outcome.

The implementation may use `rusqlite` connection/transaction types, with one compatible dependency version across CT and the crate. Do not expose both entry paths as an ambiguous function that guesses transaction ownership. No transaction spans separate JS/IPC requests. Connection serialization and thread affinity must be documented and enforced by the host wrapper. Errors must release operation-owned locks/statements without ending a caller-owned transaction.

### Mobile strategy [REQ-SQL-02]

The first mobile experiment uses a separately owned native read connection to the same app database file, opened through host-controlled configuration. The binding keeps the connection on its owning execution context and returns asynchronous results without running substantial SQLite work on the JS/UI thread.

Opening the same file is not sufficient proof of interoperability. Record the Expo SDK, expo-sqlite, React Native architecture, Rust binding mechanism, SQLite versions/build flags, encryption/extensions if present, and database journal mode used in the tested builds. Native and Expo libraries must have compatible file formats, locking behavior, and linking/symbol configuration.

Do **not** extract or wrap an undocumented expo-sqlite `sqlite3*` in `rusqlite`. Sharing a pointer across independently linked SQLite builds, thread owners, or close lifetimes is not an acceptable shortcut. A shared-handle alternative is permitted only through a documented supported native API, compatible SQLite linkage, explicit ownership, and dedicated tests; otherwise an unsuccessful separate-connection experiment blocks adoption and prompts a design revision.

Binding technology is selected during the proof based on the supported Expo/React Native configuration. JSI/TurboModules, an Expo native module, or generated bindings are implementation candidates, not interchangeable promises. A development/native build may be required; compatibility with stock Expo Go is not assumed.

### Required mobile and lifecycle tests [REQ-SQL-03]

- Await a committed JS/expo-sqlite write, start a new native traversal, and observe the committed graph state.
- Keep a JS write uncommitted: the native reader must not observe it. After rollback it remains absent; after a subsequent commit a new native snapshot observes it.
- Coordinate a writer between the operation's walk and hydration reads: the result must remain consistent with one snapshot. Tests use synchronization hooks, not timing sleeps.
- Exercise concurrent reads/writes, bounded lock waits with surfaced busy errors, and successful retry after the lock is released. No indefinite wait or app-thread blockage is acceptable.
- Close/reopen the database and invalidate outstanding engine handles. CT additionally tests vault switch/restore coordination so an old operation cannot be reported as a result for a newly selected vault.
- Run the `maxTraversalNodes` boundary probe (2⁵³-band floor, 2⁶³, 1e20) through the mobile binding. Record each platform's observed adapter behavior — truncate, accept, or throw — before any 'matches observed behavior' claim is made for mobile; the desktop characterization does not transfer across binding layers.

Record evidence on iOS and Android with a real persistent database. Simulator/emulator runs are acceptable for the slice if labeled; they do not constitute physical-device performance measurements.

### Schema responsibility [REQ-SQL-04]

This read-only slice executes no migrations and creates no schema. It validates the required schema contract and fails explicitly on incompatible/missing schema, leaving the database unchanged. Hosts arrange migration before creating a usable engine handle, using the existing authoritative migration path rather than copying migrations into each consumer.

Core's existing `WikiMemory.setup()` owns schema creation and migrations; its version marker is `${prefix}meta` key `schema_version`, not `PRAGMA user_version`. The contract check must work alongside CT's host-specific watermark, validate required tables/columns and the core marker, and never invoke mutating setup as an implicit read prerequisite. Support the existing validated table-prefix configuration through trusted host initialization (default `llm_wiki_`), not per-request JS table names. Full native migration ownership is a later design decision; 'host invokes migration' does not mean each host owns a separate schema definition.

## 4. Non-goals and migration constraints

### Scope limits [REQ-COMPAT-01]

- No full TypeScript rewrite, new ranking algorithms, inference/embedding port, mutation engine, or schema redesign.
- No forced production switch in Clanker or CT before the adoption gate passes; the baseline remains usable.
- No conflation of core fact IDs with CT entity IDs or chunk IDs.
- No claim that changing implementation language alone eliminates security issues, synchronization work, or platform dependencies.
- No permanent duplicate Rust and TS GraphRAG implementations as the end state. Temporary dual execution exists for migration/parity validation.

### Later security completion [REQ-BOUNDARY-01]

The slice leaves `wiki_exec`, `wiki_run`, `wiki_get_all`, and `wiki_get_first` available to their existing CT callers. They are removed from production renderer access only after all required callers have supported replacements; removal need not wait for unrelated engine functionality to be ported.

Subsequent completion requires inventorying every raw SQL caller, migrating setup/reads/mutations/transactions, and testing that renderer requests cannot select arbitrary SQL or databases. Typed operations still require host authorization, validation, and lifecycle checks. CSP remains a separate defense-in-depth change.

## 5. Adoption gates

### Required evidence [REQ-GATE-01]

All gates must pass before proposing production adoption or a full port:

1. **Parity and declared differences:** both implementations satisfy all identical-contract fixtures; native additionally satisfies every declared-difference and robustness expectation in REQ-SLICE-02. Record baseline defects/errors separately rather than requiring their reproduction or masking them with snapshot updates.
2. **Headless:** native crate builds/tests in isolation without Tauri, windowing, or JS runtime dependencies; CT proof executes without desktop initialization.
3. **Mobile:** real binding and persistent-database tests pass on iOS and Android, including section 3's transaction/visibility/lifecycle cases.
4. **Boundary:** CT integration uses typed requests and a host-selected connection, and malformed requests fail at the native boundary.
5. **Lifecycle:** operation-owned transactions clean up on error; caller-owned transactions survive; stale handles/results cannot cross a vault switch.
6. **Packaging:** document required native artifacts, build toolchains, runtime shared libraries, and deployment changes for CT headless and Clanker. No unsupported 'single dependency-free executable' claim.
7. **Performance:** satisfy REQ-PERF-01 with published local benchmark results, not an assumed native speedup.

### Performance experiment [REQ-PERF-01]

Measure complete public-operation latency, including validation, SQLite walk, edge/fact hydration, and result serialization. Separately measure native execution and CT/RN transport costs to locate overhead. Compare CT's existing TS/SQL-IPC route against typed native traversal, and Expo's existing TS adapter route against the mobile binding on the same device/build configuration.

Use fixed seeded graphs with at least 5,000 and 50,000 edges, including chain, branching, and cyclic shapes; record reachable result sizes, depth, graph degree/path multiplicity, database settings, SQLite build, hardware, and release/debug mode. Edge count alone does not characterize workload: baseline path enumeration can expand combinatorially within three hops. Predeclare two suites before collecting results:

- **Matched latency suite:** bounded fan-out/reachable neighborhoods that both implementations can complete. Include both graph sizes; do not silently remove slow measured cases or reduce depth after seeing results. After warm-up, collect at least 100 samples per case in each of three repetitions; report median/p95 and result bytes.
- **Robustness suite:** high-path-multiplicity graphs and bind-limit cases with an independent expected-result oracle. Set a 30-second per-operation wall deadline and an enforceable 1 GiB worker-memory ceiling in the desktop harness before execution. Interrupt/terminate timed-out isolated workers; classify outcomes as completed, timeout, resource limit, or SQL error. If the harness cannot enforce a budget, report the case as not run, not passed. Native must produce the correct result within the same budgets. Baseline noncompletion demonstrates a scalability difference, not a latency ratio, and cannot replace the matched suite.

Projection is an explicit benchmark dimension. Baseline `findByIds` uses `SELECT *`, fetching `embedding_blob` before the mapper discards it. Native may select only DTO columns, but resulting savings must not be attributed solely to Rust or IPC removal. Report the unchanged-baseline comparison and a controlled projection ablation (same engine/query shape with only the projection changed), using identical populated embedding blobs and cache conditions. Either use identical projections for the controlled language/transport comparison or report the projection contribution separately and refrain from an isolated language-speedup claim. Label modified TS benchmark variants; never substitute them for the pinned reference without disclosure. Likewise separate a BFS/path-enumeration algorithm change from a language-only claim. Record snapshot/transaction differences rather than weakening native consistency to win a benchmark.

Never compare different node limits, projections without attribution, or graph semantics as an undifferentiated native speedup. Keep time-derived fixture fields away from clock boundaries during timing runs. Measure cold-start and memory separately.

The provisional latency acceptance budget for every matched case is no greater than 10% median or p95 end-to-end regression against the unchanged baseline, with a 1 ms absolute tolerance for sub-millisecond noise; all three repetitions must meet it. A matched-case timeout/error is not a pass and requires a reviewed workload/gate revision. The robustness suite has its separate absolute budgets and correctness gate above. Failures block adoption pending explanation and explicit review; do not weaken gates retroactively. Faster results are desirable, not presumed: the original CTE already executes in native SQLite.

## 6. Specification and delivery governance

### Stable references [REQ-DOC-01]

This file is authoritative for the **native slice**, not a replacement for every existing traversal specification. It builds on the implemented [2026-06-23 Knowledge Graph Traversal API design](./2026-06-23-graph-traversal-api-design.md), which remains authoritative for the existing JS API, React hook, formatter, and tool-manifest responsibilities outside this slice. For native behavior, this document's explicit contracts and declared differences take precedence; where silent, preserve the pinned baseline's behavior. If the older design disagrees with that baseline, record the discrepancy rather than quietly treating prose as observed behavior. This draft does not change the shipped JS implementation. Adoption that changes a public contract must reconcile the older spec and public API documentation in the implementation PR.

CT and Clanker integration specs reference these requirement IDs and a reviewed upstream commit (later, an engine release). They document local responsibilities and tests without copying or redefining graph semantics. IDs are never reused for different requirements; changed contracts require explicit revisions and downstream impact review.

Downstream specs are written after this shared contract is reviewed. CT covers desktop and standalone CLI/MCP distribution, including its two existing MCP build paths; Clanker covers binding/storage compatibility. Integrations need a separate spec only if their MCP or diagnostic contracts change.

Each repository keeps its spec, implementation plan, code, and tests on the same implementation branch/PR. This upstream branch name does not authorize a spec-only PR. Cross-repository PRs record dependency commits/releases and distinguish 'upstream ready' from 'all consumer gates passed'. There is no assumption of an atomic cross-repository merge.

### Revision history

**Revision 4 (2026-09-17, review round 3):** pinned `maxTraversalNodes` decode to binary64 (JS `Number` semantics, f64-then-floor) so the 2⁵³-band fixture is unambiguous; scoped the `SQLITE_MISMATCH` characterization to the measured desktop adapter; added the mobile boundary probe to REQ-SQL-03 evidence.

**Revision 3 (2026-09-17, review round 2):** `excludeSourceTypes` reclassified as opaque text (strict-enum rejection was a capability regression, inconsistent with `edgeTypes`); hydration mapping/clock order pinned to selected-node order (baseline-deterministic); `maxTraversalNodes` boundary pinned to signed 64-bit with measured better-sqlite3 12.11.1/SQLite 3.53.2 characterization (`SQLITE_MISMATCH` at 2⁶³); hydration batch size (500) named in REQ-SCALE-01 with oversized-filter fixtures added; stale rev-1 summary replaced by this history.

**Revision 2 (2026-09-17, review round 1):** added REQ-INPUT-01 (runtime input matrix), REQ-SCALE-01 (bind-variable-safe reads), two predeclared benchmark suites with projection ablation and enforced robustness budgets, BFS-vs-path-enumeration allowance, delimiter-ID defect classification, anchor-first ordering, spec precedence under REQ-DOC-01, and named in-repo consumers.
