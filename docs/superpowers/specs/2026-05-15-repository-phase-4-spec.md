# Phase 4 Technical Specification: DX, Integrations, & Prompt Management

## 1. Executive Summary

With the core `WikiMemory` engine successfully decoupled into cohesive domain services (Ingestion, Maintenance, Retrieval, etc.) and backed by robust test coverage, Phase 4 focuses on **Developer Experience (DX) and App Integration**. This phase bridges the gap between the isolated domain logic and the consumer applications building on top of it, introducing dynamic prompt management, React/Expo bindings, and background task orchestration.

## 2. Core Architecture Update: Prompt & Context Management

Hardcoded system prompts limit the engine to a generic assistant persona. To support domain-specific apps (like *Curated Thoughts*), we will extract all LLM instruction logic into a dedicated `PromptService`.

### 2.1 Configuration Interfaces

Introduce standardized configuration objects allowing developers to define global defaults and runtime overrides.

```typescript
export interface PromptOverrides {
  ingestSystemPrompt?: string;
  librarianSystemPrompt?: string;
  healSystemPrompt?: string;
}

export interface WikiConfig {
  tablePrefix?: string;
  prompts?: PromptOverrides; 
  // ... existing configs
}

```

### 2.2 The `PromptService`

A new service responsible for handling string serialization, `{{mustache}}` variable hydration, and prompt resolution.

* **Decoupling:** Removes all `JSON.stringify` and formatting logic from `IngestionService` and `MaintenanceService`.
* **Hydration:** Replaces variables like `{{events}}` or `{{documentChunk}}` if the developer provides a custom template.
* **Fallback:** If no variables are detected in an override template, gracefully falls back to appending the raw JSON as the `userPrompt`.

### 2.3 Rollout Strategy (Zero-Conflict Parallelism)

To prevent Git merge conflicts and allow multiple AI agents to execute the refactor concurrently, the rollout will follow a 3-step, 4-PR sequence:

1. **PR 1 (Foundation):** Define `PromptOverrides`, build `PromptService`, and write isolated mustache hydration tests.
2. **PR 2 & 3 (Parallel Domain Overhaul):** * Agent A strips formatting logic from `IngestionService`, injecting `PromptService.buildIngestPrompt()`.
* Agent B strips formatting from `MaintenanceService`, injecting `buildLibrarianPrompt()` and `buildHealPrompt()`.


3. **PR 4 (Facade Wiring):** Update the `WikiMemory` constructor to initialize `PromptService` and pass it down. Expose optional `promptOverride` arguments on public methods (`ingestDocument`, `runLibrarian`, `runHeal`).

---

## 3. Expo & React Integration Layer (Hooks & Context)

Currently, `WikiMemory` is a pure Vanilla JS/TypeScript class. To make it ergonomic for React Native / Expo, we will build a reactivity layer.

* **`<WikiProvider />`:** A context provider that initializes the SQLite database and holds the `WikiMemory` singleton safely.
* **Data Hooks:** `useWikiRead()` and `useWikiWrite()` for standard read/write operations.
* **Status Hooks:** A `useEntityStatus(entityId)` hook natively wrapping the `subscribeEntityStatus` method. This allows the UI to reactively display spinners/indicators when the Librarian or Ingestion queues are churning.

---

## 4. Background Task Orchestration

Heavy LLM operations (pruning, healing, synthesizing) currently run on the active JS thread.

* **Expo TaskManager Integration:** Wire the `MaintenanceService` (`runLibrarian`, `runHeal`) into Expo's `TaskManager` or `BackgroundFetch` APIs.
* **Objective:** Enable the LLM to process Outbox queues and re-embed data while the app is backgrounded or the device is charging, ensuring zero frame drops on the main UI thread during active user interaction.

---

## 5. Observability & DevTools

Vector databases and LLM summaries are notoriously opaque during development.

* **Memory Explorer UI / CLI:** Build a drop-in `<WikiDevTools />` component.
* **Features:** Allow developers to visually inspect an entity's timeline, monitor vector dimension mismatches, view the Outbox queue, and manually trigger operations like `runReembed()` or `runPrune()`.
* **Telemetry:** Implement a lightweight `jobId` or `traceId` context passed through the `JobManager` to provide highly descriptive error stacks if a background job fails.

---

## 6. API Polish & NPM Publishing

Finalizing the monorepo for public consumption.

* **Exports:** Lock down public exports in `index.ts` (ensuring internal repos like `OutboxRepository` aren't accidentally exposed).
* **Documentation:** Finalize READMEs with clear examples of global vs. runtime prompt overrides.
* **Release:** Set up the monorepo build pipeline and cut `v1.0.0-rc.1`.

---
