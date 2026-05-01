# [2.2.0](https://github.com/equationalapplications/expo-llm-wiki/compare/v2.1.0...v2.2.0) (2026-05-01)


### Features

* **types:** add FormatContextOptions, pruneRetainSoftDeletedFor, extend WikiBusyError prune op ([9d72e00](https://github.com/equationalapplications/expo-llm-wiki/commit/9d72e00e55ca04d10ac54acc9f78484454a01417))

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
