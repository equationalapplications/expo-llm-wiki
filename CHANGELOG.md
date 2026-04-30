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
