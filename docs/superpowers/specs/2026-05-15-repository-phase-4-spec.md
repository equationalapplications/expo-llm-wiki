## Phase 4: Prompt & Context Management Extraction.

> **Note:** This spec was written pre-implementation and describes the state of the codebase _before_ Phase 4 was applied. The "Current implementation state" section below is historical context. All items listed as missing have been implemented in this branch.

### Current implementation state (pre-implementation snapshot)

The current code base does not yet implement this Phase 4 design. Core services still rely on static prompt constants and manual prompt construction, so the planned prompt abstraction layer is currently absent.

Key mismatches:

- `packages/core/src/services/PromptService.ts` does not exist.
- `PromptOverrides` is not defined in `packages/core/src/types.ts`.
- `WikiConfig` does not include `prompts?: PromptOverrides`.
- `packages/core/src/services/IngestionService.ts` imports `INGEST_SYSTEM_PROMPT` and builds `userPrompt` manually in `ingestDocument()`.
- `ingestDocument()` does not accept a `promptOverride` parameter.
- `packages/core/src/services/MaintenanceService.ts` imports `LIBRARIAN_SYSTEM_PROMPT` and `HEAL_SYSTEM_PROMPT`.
- `doRunLibrarian()` and `doRunHeal()` still serialize raw JSON into `userPrompt` strings.
- `runLibrarian()` and `runHeal()` do not accept runtime override options.
- `packages/core/src/WikiMemory.ts` does not instantiate or pass a `PromptService`.
- `WikiMemory` public APIs `runLibrarian()`, `runHeal()`, and `ingestDocument()` do not accept `promptOverride`.
- `WikiMemoryTestAccess` does not expose a `promptService`.

Additional note:

`WriteService` already calls `maintenanceService.doRunLibrarian()` and `maintenanceService.doRunHeal()` internally. A proper `PromptService` must therefore be passed into `MaintenanceService` so global prompt overrides are available for internal auto-runs as well as manual calls.

### 1. Define the Configuration Interfaces

First, we need to define a standard configuration object for these prompts. We should allow developers to set **global overrides** (when instantiating `WikiMemory`) and **runtime overrides** (per method call).

TypeScript

```
export interface PromptOverrides {
  ingestSystemPrompt?: string;
  librarianSystemPrompt?: string;
  healSystemPrompt?: string;
}

// Update WikiOptions to accept global default overrides
export interface WikiConfig {
  // ... existing config (tablePrefix, maxResults, etc.)
  prompts?: PromptOverrides; 
}
```

### 2. Create the `PromptService`

Instead of letting `IngestionService` and `MaintenanceService` directly import from `../prompts`, we will extract a `PromptService`. This service's job is to resolve the correct prompt (Runtime Override → Global Config → Base Default) and handle any hydration/variable injection.

TypeScript

```
import { 
  INGEST_SYSTEM_PROMPT, 
  LIBRARIAN_SYSTEM_PROMPT, 
  HEAL_SYSTEM_PROMPT 
} from '../prompts';
import type { PromptOverrides } from '../types';

export class PromptService {
  constructor(private globalOverrides?: PromptOverrides) {}

  getIngestPrompt(runtimeOverride?: string): string {
    return runtimeOverride ?? this.globalOverrides?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT;
  }

  getLibrarianPrompt(runtimeOverride?: string): string {
    return runtimeOverride ?? this.globalOverrides?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT;
  }

  getHealPrompt(runtimeOverride?: string): string {
    return runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
  }
}
```

### 3. Wire Up the Domain Services

Now we update `IngestionService` and `MaintenanceService` to accept the `PromptService` in their constructors and use it to fetch the prompts dynamically.

**Example: Updating `IngestionService.ts`**

TypeScript

```
// Add `promptOverride` to the runtime params
async ingestDocument(
  entityId: string,
  params: {
    sourceRef: string;
    sourceHash: string;
    documentChunk: string;
    promptOverride?: string; // <-- New optional runtime param
    // ...
  }
) {
  // ... lock acquisition ...
  
  // Resolve the prompt exactly when we need it
  const systemPrompt = this.promptService.getIngestPrompt(params.promptOverride);

  const chunkResults = await withConcurrency(
    chunks.map((chunk) => async () => {
      const userPrompt = `Document Chunk:\n${chunk}`;
      return this.options.llmProvider.generateText({
        systemPrompt, // <-- Injecting the dynamic prompt
        userPrompt,
      });
      // ...
```

**Example: Updating `MaintenanceService.ts`**

TypeScript

```
async doRunLibrarian(entityId: string, promptOverride?: string): Promise<void> {
  // ... fetch events and facts ...

  const systemPrompt = this.promptService.getLibrarianPrompt(promptOverride);
  
  const responseText = await this.options.llmProvider.generateText({
    systemPrompt, // <-- Injecting the dynamic prompt
    userPrompt: `Events:\n${JSON.stringify(events)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts)}`,
  });
  // ...
```

### 4. Update the `WikiMemory` Facade

Finally, update the public methods on `WikiMemory` to accept these optional overrides and pass them down.

TypeScript

```
export class WikiMemory {
  private promptService: PromptService;

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    // ...
    this.promptService = new PromptService(options.config?.prompts);
    // Pass this.promptService down to IngestionService and MaintenanceService
  }

  async ingestDocument(entityId: string, params: IngestParams & { promptOverride?: string }) {
    return this.ingestionService.ingestDocument(entityId, params);
  }

  async runLibrarian(entityId: string, options?: { promptOverride?: string }) {
    return this.maintenanceService.runLibrarian(entityId, options?.promptOverride);
  }
  
  async runHeal(entityId: string, options?: { promptOverride?: string }) {
    return this.maintenanceService.runHeal(entityId, options?.promptOverride);
  }
}
```

> Note: `runLibrarian` and `runHeal` currently return `Promise<void>` and accept only `entityId`. This refactor explicitly changes the public API to accept an optional `options?: { promptOverride?: string }` object, so tests and public method signatures must be updated to match.

---

By isolating this into a `PromptService`, the design creates a clear testing boundary for prompt generation and leaves room for future enhancements such as dynamically calculating token limits before sending prompts.

For consistency with existing prompt hydration patterns, `PromptService` should own both responsibilities: injecting variables into prompt templates (for example `{{context}}` and `{{tasks}}`) and serializing structured payloads into the final prompt text sent to the LLM.

This keeps domain services such as `IngestionService` and `MaintenanceService` independent of prompt-formatting details. They should provide raw domain data, while `PromptService` is responsible for template hydration, JSON serialization, and final prompt assembly.

This approach also aligns background-task prompt construction with the existing `hydrateLibrarianPrompt` read-side pattern, preserving a consistent `{{variable}}` template convention across the SDK.

The implementation plan below reflects this design.

---

## 1. The `PromptService` Implementation

We will build a service that takes raw objects/arrays, safely serializes them, and injects them into `{{mustache}}` style tags. If a developer provides a custom template, they can place `{{events}}` or `{{documentChunk}}` exactly where they want it.

Create `packages/core/src/services/PromptService.ts`:

TypeScript

```
import { 
  INGEST_SYSTEM_PROMPT, 
  LIBRARIAN_SYSTEM_PROMPT, 
  HEAL_SYSTEM_PROMPT 
} from '../prompts';
import type { PromptOverrides, WikiFact, WikiTask, ExtractedFact } from '../types';

export class PromptService {
  constructor(private globalOverrides?: PromptOverrides) {}

  /**
   * Replaces {{key}} in the template with the stringified value from the variables object.
   */
  private hydrate(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
      const value = variables[key];
      if (value === undefined) return match; // Leave un-hydrated if missing
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    });
  }

  buildIngestPrompt(documentChunk: string, runtimeOverride?: string): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.ingestSystemPrompt ?? INGEST_SYSTEM_PROMPT;
    
    // If the template contains {{documentChunk}}, inject it directly into the system prompt.
    // Otherwise, fall back to the standard User Prompt separation.
    if (template.includes('{{documentChunk}}')) {
      return { 
        systemPrompt: this.hydrate(template, { documentChunk }), 
        userPrompt: 'Please extract the facts.' 
      };
    }

    return {
      systemPrompt: template,
      userPrompt: `Document Chunk:\n${documentChunk}`
    };
  }

  buildLibrarianPrompt(events: unknown[], currentFacts: unknown[], runtimeOverride?: string): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.librarianSystemPrompt ?? LIBRARIAN_SYSTEM_PROMPT;
    
    if (template.includes('{{events}}') || template.includes('{{currentFacts}}')) {
      return {
        systemPrompt: this.hydrate(template, { events, currentFacts }),
        userPrompt: 'Please synthesize the context.'
      };
    }

    return {
      systemPrompt: template,
      userPrompt: `Events:\n${JSON.stringify(events, null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`
    };
  }

  buildHealPrompt(
    healCandidates: unknown[], 
    documentAnchors: unknown[], 
    allTasks: unknown[], 
    recentEvents: unknown[], 
    runtimeOverride?: string
  ): { systemPrompt: string; userPrompt: string } {
    const template = runtimeOverride ?? this.globalOverrides?.healSystemPrompt ?? HEAL_SYSTEM_PROMPT;
    
    if (template.includes('{{healCandidates}}') || template.includes('{{documentAnchors}}')) {
      return {
        systemPrompt: this.hydrate(template, { healCandidates, documentAnchors, allTasks, recentEvents }),
        userPrompt: 'Please heal the memory graph.'
      };
    }

    return {
      systemPrompt: template,
      userPrompt: `Heal Candidates:\n${JSON.stringify(healCandidates, null, 2)}
\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(documentAnchors, null, 2)}
\nAll Tasks:\n${JSON.stringify(allTasks, null, 2)}
\nRecent Events:\n${JSON.stringify(recentEvents, null, 2)}`
    };
  }
}
```

**Why this design?** It is backward compatible. If a developer just passes a plain string override without `{{}}` variables, the `PromptService` gracefully falls back to appending the raw JSON as the `userPrompt`, preserving the default behavior.

---

## 2. Stripping Formatting from Domain Services

Now look at how clean your background tasks become. The Domain Services no longer care about `JSON.stringify` or formatting instructions.

**In `IngestionService.ts`:**

TypeScript

```
// Inside the chunk loop
const { systemPrompt, userPrompt } = this.promptService.buildIngestPrompt(chunk, params.promptOverride);

const responseText = await this.options.llmProvider.generateText({
  systemPrompt,
  userPrompt,
});
```

**In `MaintenanceService.ts` (Librarian):**

TypeScript

```
async doRunLibrarian(entityId: string, promptOverride?: string): Promise<void> {
  const events = await this.eventRepo.getRecent(entityId, 50);
  const currentFactsRows = await this.entryRepo.findRecentByEntityId(entityId, 100);
  
  // Strip out embeddings before sending to LLM
  const currentFacts = currentFactsRows.map(f => { /* ... */ });

  // Let PromptService handle all hydration and JSON formatting
  const { systemPrompt, userPrompt } = this.promptService.buildLibrarianPrompt(
    events, 
    currentFacts, 
    promptOverride
  );

  const responseText = await this.options.llmProvider.generateText({
    systemPrompt,
    userPrompt,
  });
  
  // ... rest of librarian logic
}
```

---

## 3. The Developer Experience (App Level)

With this merged, a developer building _Curated Thoughts_ can inject highly specific domain templates at runtime:

TypeScript

```
const customLibrarianPrompt = `
You are an expert curator for Equational Applications LLC.
Your job is to read the user's raw thoughts and format them into 'Curated Insights'.
Never invent information.

Recent Thoughts (Events):
{{events}}

Existing Insights:
{{currentFacts}}

Respond ONLY with a JSON object containing the new insights.
`;

// Runtime Override!
await wiki.runLibrarian('user-123', { 
  promptOverride: customLibrarianPrompt 
});
```

### 3.1 Global vs Runtime Overrides

When we document this feature, make the distinction explicit:

- `options.config.prompts` is the only source of prompts that will persist for background auto-runs triggered by `WikiMemory.write()` or `WriteService` internals.
- `promptOverride` is a one-off runtime override that applies only to the manual `runLibrarian`, `runHeal`, or `ingestDocument` call in which it is provided.

That means if your app relies on automatic maintenance from `WriteService`, custom prompt templates must be configured globally during `WikiMemory` instantiation. Runtime overrides are powerful for ad hoc, manual executions, but they do not flow through the internal auto-run path.

For developer guidance, this Phase 4 spec must also require:
- JSDoc on `WikiMemory.runLibrarian()`, `WikiMemory.runHeal()`, and `WikiMemory.ingestDocument()` warning that `options.promptOverride` applies only to that manual call and does not affect `WriteService`-triggered internal auto-runs.
- README examples that explicitly separate:
  - global prompt config for auto-runs via `options.config.prompts`
  - one-off prompt overrides for manual maintenance calls via `promptOverride`

This makes the developer experience dummy-proof: global prompts control auto-run behavior, and runtime prompts control manual, one-off operations.

This effectively turns `@equationalapplications/core-llm-wiki` from a rigid assistant memory layer into a highly malleable data-extraction engine.

---

To successfully unleash multiple AI agents on this refactor, the biggest threat is **Git merge conflicts**. If two agents try to update the `WikiMemory.ts` constructor at the same time, you will spend more time resolving conflicts than you saved by parallelizing them.

To achieve maximum parallelism with zero file overlaps, you should break Phase 4 into **4 PRs executed across 3 sequential steps**.

Here is the exact blueprint to hand off to your agents:

### Step 1: The Contract (Agent 1)

Before the other agents can do their work, they need the shared types and the new service to import. This must be merged (or at least branch-shared) first.

- **PR 1: Foundation (`PromptService` & Types)**
    
    - **Files Touched:** `types.ts`, `prompts.ts`, `services/PromptService.ts`, `PromptService.test.ts`
        
    - **Agent Task:** Define the `PromptOverrides` interface in `types.ts`. Build the `PromptService` class with the `hydrate()` utility and the `buildIngestPrompt`, `buildLibrarianPrompt`, and `buildHealPrompt` methods. Write isolated unit tests verifying the mustache `{{variable}}` replacements work correctly.
        

---

### Step 2: Parallel Domain Updates (Agents 2 & 3)

Once PR 1 is available, you can spin up two agents simultaneously. Because they are working in completely different files, they will not step on each other's toes.

- **PR 2: Ingestion Overhaul (Agent 2)**
    
    - **Files Touched:** `services/IngestionService.ts`, `IngestionService.test.ts`
        
    - **Agent Task:** Update the constructor to accept `PromptService`. Modify the `ingestDocument` signature to accept `promptOverride`. Gut the manual string formatting inside the chunk loop and replace it with a call to `this.promptService.buildIngestPrompt()`.
        
- **PR 3: Maintenance Overhaul (Agent 3)**
    
    - **Files Touched:** `services/MaintenanceService.ts`, `MaintenanceService.test.ts`
        
    - **Agent Task:** Update the constructor to accept `PromptService`. Modify `doRunLibrarian` and `doRunHeal` to accept `promptOverride`. Strip out all `JSON.stringify` logic for the LLM inputs and delegate entirely to `this.promptService.buildLibrarianPrompt()` and `this.promptService.buildHealPrompt()`.
        

---

### Step 3: The Facade Wiring (Agent 4 or Human)

Once PRs 2 and 3 are merged, the final step is to connect the new pipes to the public API.

- **PR 4: `WikiMemory` Integration**
    
    - **Files Touched:** `WikiMemory.ts`, `README.md`
        
    - **Agent Task:** Instantiate `PromptService` in the `WikiMemory` constructor using `options.config?.prompts`. Pass it down into the instantiation of `IngestionService` and `MaintenanceService`. Update the public methods (`ingestDocument`, `runLibrarian`, `runHeal`) to accept the new optional `promptOverride` argument and pass it through to the services.
    - **Documentation Task:** Add explicit JSDoc warnings to `WikiMemory.ts` that runtime `promptOverride` values apply only to manual calls, and ensure `README.md` clearly separates global prompt config (for auto-runs) from runtime overrides (for manual executions).
        

---

By isolating `WikiMemory.ts` to the very last step, your agents can run PRs 2 and 3 concurrently without locking up your repository.

The following section provides exact system prompts for Agents 2 and 3 that can be copied into Cursor, GitHub Copilot Workspace, or a similar AI agent workflow.

---

Here are the exact system prompts you can feed into Cursor, GitHub Copilot Workspace, or your AI agent of choice.

These prompts are designed to be **highly restrictive**—they give the agent exactly the context it needs while explicitly forbidding it from touching unrelated logic like database transactions or concurrency locks.

---

### Prompt for Agent 2 (PR 2: Ingestion Overhaul)

**Copy and paste this into the agent working on `IngestionService`:**

Plaintext

```
You are executing PR 2 of our Prompt Management Refactor. 
Your scope is strictly limited to `packages/core/src/services/IngestionService.ts` and its corresponding test file.

Assume `PromptService` already exists and is exported from `../services/PromptService` (or equivalent types file). It has the following method:
`buildIngestPrompt(documentChunk: string, runtimeOverride?: string): { systemPrompt: string; userPrompt: string }`

Execute the following changes:
1. Update the `IngestionService` constructor to accept `private promptService: PromptService`.
2. Update the `ingestDocument` method signature so the `params` object accepts an optional `promptOverride?: string`.
3. Inside `ingestDocument`, locate the LLM generation step inside the `chunks.map` loop.
4. Remove the manual construction of `userPrompt` (`const userPrompt = 'Document Chunk:\n' + chunk;`) and the direct usage of `INGEST_SYSTEM_PROMPT`.
5. Call `const { systemPrompt, userPrompt } = this.promptService.buildIngestPrompt(chunk, params.promptOverride);`
6. Pass those returned values into `this.options.llmProvider.generateText({ systemPrompt, userPrompt })`.
7. Remove the import for `INGEST_SYSTEM_PROMPT` at the top of the file if it is no longer used.

CRITICAL CONSTRAINTS:
- Do NOT alter any `JobManager` lock acquisition or release logic.
- Do NOT alter the chunking math or concurrency loops.
- Do NOT alter any database transaction, upsert, or `searchService.sync()` logic.
- Only output the exact modifications requested.
```

---

### Prompt for Agent 3 (PR 3: Maintenance Overhaul)

**Copy and paste this into the agent working on `MaintenanceService`:**

Plaintext

```
You are executing PR 3 of our Prompt Management Refactor. 
Your scope is strictly limited to `packages/core/src/services/MaintenanceService.ts` and its corresponding test file.

Assume `PromptService` already exists and is exported from `../services/PromptService`. It has the following methods:
- `buildLibrarianPrompt(events: any[], currentFacts: any[], runtimeOverride?: string): { systemPrompt: string; userPrompt: string }`
- `buildHealPrompt(healCandidates: any[], documentAnchors: any[], allTasks: any[], recentEvents: any[], runtimeOverride?: string): { systemPrompt: string; userPrompt: string }`

Execute the following changes:
1. Update the `MaintenanceService` constructor to accept `private promptService: PromptService`.
2. Update the public `runLibrarian(entityId: string, options?: { promptOverride?: string })` and `runHeal(entityId: string, options?: { promptOverride?: string })` methods to accept the new options object, and pass the override down to `doRunLibrarian` and `doRunHeal`.
3. Update `doRunLibrarian(entityId: string, promptOverride?: string)`:
   - Remove the manual `userPrompt` stringification (`Events:\n${JSON.stringify(...)}`).
   - Call `const { systemPrompt, userPrompt } = this.promptService.buildLibrarianPrompt(events, currentFacts, promptOverride);`.
   - Pass these into `this.options.llmProvider.generateText`.
4. Update `doRunHeal(entityId: string, promptOverride?: string)`:
   - Remove the massive manual `userPrompt` stringification block.
   - Call `const { systemPrompt, userPrompt } = this.promptService.buildHealPrompt(healCandidates, documentAnchors, allTasks, recentEvents, promptOverride);`.
   - Pass these into `this.options.llmProvider.generateText`.
5. Remove the imports for `LIBRARIAN_SYSTEM_PROMPT` and `HEAL_SYSTEM_PROMPT` if they are no longer used.

CRITICAL CONSTRAINTS:
- Do NOT alter any `JobManager` lock acquisition or release logic.
- Do NOT alter the database threshold logic (orphan/stale checks).
- Do NOT alter the database upsert, downgrade, or transaction logic.
- Only output the exact modifications requested.
```

---

With PR 1 acting as the anchor, these agents will safely gut the formatting logic out of your core services in parallel.

---

## Post-Phase 4 Roadmap

With the core engine built and tested (Phases 1–4), the natural next tracks are developer experience (DX) and integration.

### Track A: The React / Expo Integration Layer (Hooks & Context)

Right now, `WikiMemory` is a pure Vanilla JS/TypeScript class. To make it ergonomic for an Expo app, you need a reactivity layer.

- **Context Provider:** A `<WikiProvider>` that initializes the DB and holds the `WikiMemory` singleton.
    
- **Data Hooks:** `useWikiRead()`, `useWikiWrite()`.
    
- **Status Hooks:** A `useEntityStatus(entityId)` hook that natively wraps your `subscribeEntityStatus` method so the UI can show spinners when the Librarian or Ingestion services are actively churning in the background.
    

### Track B: Background Task Orchestration (Expo TaskManager)

The `Librarian` and `Heal` jobs run in the background, but right now they run in the JS thread while the app is active.

- **Integration:** Wiring the `MaintenanceService` into Expo's `TaskManager` or `BackgroundFetch` APIs.
    
- **Goal:** Allowing the LLM to prune, heal, and synthesize memories while the app is backgrounded or when the device is plugged in, so it doesn't block the UI thread during active use.
    

### Track C: DevTools & Observability (The "Memory Explorer")

Because vector databases and LLM summaries are essentially "black boxes" to the user, debugging them during app development is notoriously difficult.

- **Implementation:** Building a drop-in `<WikiDevTools />` component or a CLI script.
    
- **Goal:** Allowing a developer to visually inspect an entity's timeline, see the vector dimension mismatches, trigger a manual `runReembed()`, or view the Outbox queue.
    

### Track D: API Polish & NPM Publishing

If the goal is to get this in the hands of other developers ASAP.

- Writing the READMEs, setting up the monorepo build pipeline (if not fully done), locking down the public exports in `index.ts`, and cutting a `v1.0.0-rc.1`.
    

---

### 1. Update Imports

At the top of `packages/core/src/WikiMemory.ts`, import the new `PromptService`.

TypeScript

```
// ... existing imports
import { RetrievalService } from './services/RetrievalService';
import { WriteService } from './services/WriteService';
import { PromptService } from './services/PromptService'; // <-- NEW
```

### 2. Update the `WikiMemoryTestAccess` Interface

To maintain your pristine testing environment, expose the new service.

TypeScript

```
export interface WikiMemoryTestAccess {
  embeddingService: EmbeddingService;
  importExportService: ImportExportService;
  ingestionService: IngestionService;
  maintenanceService: MaintenanceService;
  retrievalService: RetrievalService;
  writeService: WriteService;
  promptService: PromptService; // <-- NEW
  entryRepo: EntryRepository;
  metadataRepo: MetadataRepository;
}
```

### 3. Update the `WikiMemory` Class Properties & Constructor

Add the `promptService` to the class properties, initialize it using `options.config?.prompts`, and pass it into the `IngestionService` and `MaintenanceService`.

TypeScript

```
export class WikiMemory {
  // ... existing properties
  private importExportService: ImportExportService;
  private retrievalService: RetrievalService;
  private writeService: WriteService;
  private promptService: PromptService; // <-- NEW

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';

    // 1. Initialize PromptService with global overrides
    this.promptService = new PromptService(options.config?.prompts); // <-- NEW

    // ... existing repo initializations

    // 2. Pass promptService to IngestionService
    this.ingestionService = new IngestionService(
      this.db,
      this.prefix,
      this.options,
      this.entryRepo,
      this.searchService,
      this.jobManager,
      this.embeddingService,
      this.promptService // <-- NEW
    );

    // 3. Pass promptService to MaintenanceService
    this.maintenanceService = new MaintenanceService(
      this.db,
      this.prefix,
      this.options,
      this.entryRepo,
      this.taskRepo,
      this.eventRepo,
      this.metadataRepo,
      this.searchService,
      this.jobManager,
      this.embeddingService,
      this.promptService // <-- NEW
    );

    // ... existing service initializations
  }
  
  get __testAccess(): WikiMemoryTestAccess {
    // ... existing warning logic
    return {
      embeddingService: this.embeddingService,
      importExportService: this.importExportService,
      ingestionService: this.ingestionService,
      maintenanceService: this.maintenanceService,
      retrievalService: this.retrievalService,
      writeService: this.writeService,
      promptService: this.promptService, // <-- NEW
      entryRepo: this.entryRepo,
      metadataRepo: this.metadataRepo,
    };
  }
  // ...
```

### 4. Update the Public Methods

Finally, update the specific methods at the bottom of the file to accept the optional overrides and pass them through.

TypeScript

```
  // Update runLibrarian to accept options
  async runLibrarian(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    return this.maintenanceService.runLibrarian(entityId, options);
  }

  // Update runHeal to accept options
  async runHeal(entityId: string, options?: { promptOverride?: string }): Promise<void> {
    return this.maintenanceService.runHeal(entityId, options);
  }

  // Update ingestDocument params to accept promptOverride
  async ingestDocument(
    entityId: string,
    params: {
      sourceRef: string;
      sourceHash: string;
      documentChunk: string;
      maxChunkLength?: number;
      chunkOverlap?: number;
      chunkConcurrency?: number;
      promptOverride?: string; // <-- NEW
    }
  ): Promise<{ truncated: boolean; chunks: number }> {
    return this.ingestionService.ingestDocument(entityId, params);
  }
```