# Spec: Internal Inference Engine

**Date:** 2026-04-29  
**Status:** Implemented

---

## Problem

The prior API required developers to build their own prompts, call the LLM, parse JSON, and write database rows. This created substantial boilerplate and made it easy to break the memory schema. The internal inference engine moves that responsibility into the package.

---

## Design Principle

The developer provides one thing: a `generateText` function that accepts a system prompt and a user prompt and returns a raw string. The package owns everything else — prompt construction, response parsing, and database writes.

---

## LLMProvider Contract

```typescript
interface LLMProvider {
  generateText: (params: {
    systemPrompt: string;
    userPrompt: string;
  }) => Promise<string>;
}
```

The return value is expected to be a JSON string, optionally wrapped in a markdown code fence (` ```json ... ``` `). The package strips fences before parsing. Any LLM that can follow a JSON schema in a system prompt works.

Passed via `WikiOptions.llmProvider` at construction time. Cannot be swapped per-call.

---

## Response Parsing

All three inference operations share one internal helper:

```typescript
function parseJsonResponse<T>(text: string): T {
  const cleanText = text.replace(/```[a-zA-Z]*\n/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleanText) as T;
}
```

If the LLM returns malformed JSON, `JSON.parse` throws and the caller's `try/catch` propagates the error. No silent fallback. No retry logic.

---

## Inference Operations

### 1. Librarian Pass — `runLibrarian(entityId)`

**Purpose:** Convert recent episodic events into durable facts and tasks.

**When triggered:** Automatically inside `write()` once the event count for an entity exceeds `autoLibrarianThreshold` (default: 20) since the last librarian checkpoint. Can also be called manually.

**Inputs to LLM:**

```
User prompt:
  Events:
  <JSON array of up to 50 recent WikiEvent rows, ascending by created_at>

  Current Facts:
  <JSON array of up to 100 non-deleted WikiFact rows, descending by updated_at>
```

**System prompt:** `LIBRARIAN_SYSTEM_PROMPT`

**Expected response schema:**

```json
{
  "facts": [
    {
      "title": "string (max 80 chars)",
      "body": "string (max 200 chars)",
      "tags": ["string"],
      "confidence": "certain | inferred | tentative"
    }
  ],
  "tasks": [
    {
      "description": "string",
      "priority": "number (0–10)"
    }
  ]
}
```

**Database writes (transactional):**
- Each fact → `INSERT INTO {prefix}entries` with `source_type = 'agent_inferred'`
- Each task → `INSERT INTO {prefix}tasks` with `status = 'pending'`
- IDs and timestamps are generated internally; the LLM never sets them.

**Note:** The librarian does not deduplicate against existing facts. Deduplication and contradiction resolution is the responsibility of the Heal pass.

---

### 2. Heal Pass — `runHeal(entityId)`

**Purpose:** Resolve contradictions, downgrade stale claims, and delete obsolete facts.

**When triggered:** Manual only (no auto-trigger). Intended for periodic background maintenance.

**Inputs to LLM:**

```
User prompt:
  All Facts:
  <JSON array of all non-deleted WikiFact rows>

  All Tasks:
  <JSON array of all non-deleted pending/in_progress WikiTask rows>

  Recent Events:
  <JSON array of up to 20 most recent WikiEvent rows>
```

**System prompt:** `HEAL_SYSTEM_PROMPT`

**Expected response schema:**

```json
{
  "downgraded": ["fact_id", "..."],
  "deleted":    ["fact_id", "..."],
  "newFacts": [
    {
      "title": "string",
      "body": "string",
      "tags": ["string"],
      "confidence": "certain | inferred | tentative"
    }
  ]
}
```

**Database writes (transactional):**
- `downgraded` IDs → `UPDATE … SET confidence = 'tentative'` — only if `source_type != 'user_document'`
- `deleted` IDs → soft-delete (`deleted_at = now`) — only if `source_type != 'user_document'`
- `newFacts` → `INSERT INTO {prefix}entries` with `source_type = 'agent_inferred'`

**Invariant:** Facts with `source_type = 'user_document'` are never modified or deleted by the Heal pass. Only `ingestDocument` or `forget` touch them.

---

### 3. Document Ingest — `ingestDocument(entityId, params)`

**Purpose:** Extract structured facts from a raw document chunk and store them with a stable source reference for idempotent re-ingestion.

**Signature:**

```typescript
ingestDocument(entityId: string, params: {
  sourceRef: string;   // stable identifier (e.g. file path, URL, doc ID)
  sourceHash: string;  // content hash for change detection
  documentChunk: string;
}): Promise<void>
```

**Inputs to LLM:**

```
User prompt:
  Document Chunk:
  <params.documentChunk verbatim>
```

**System prompt:** `INGEST_SYSTEM_PROMPT`

**Expected response schema:**

```json
{
  "facts": [
    {
      "title": "string (max 80 chars)",
      "body": "string (max 200 chars)",
      "tags": ["string"],
      "confidence": "certain | inferred | tentative"
    }
  ]
}
```

**Database writes (transactional, idempotent):**
1. Soft-delete all existing entries with `source_ref = params.sourceRef` for this entity.
2. Insert new facts with `source_type = 'user_document'`, `source_hash`, and `source_ref` set.

Re-calling with the same `sourceRef` and updated content replaces the prior extraction cleanly. Callers should compute `sourceHash` (e.g. SHA-256 of the chunk) to detect whether the content has changed before calling.

---

## Auto-Trigger Lifecycle

```
wiki.write(entityId, event)
  → INSERT event row
  → SELECT COUNT(*) of all events for entity
  → SELECT checkpoint row
  → if (count - memory_checkpoint) >= autoLibrarianThreshold:
      → UPSERT checkpoint (memory_checkpoint = count)
      → runLibrarian(entityId)  [fire-and-forget, errors logged to console]
```

The checkpoint prevents the librarian from running repeatedly on the same events. It does not prevent manual calls.

`autoLibrarianThreshold` defaults to 20. Set via `WikiConfig.autoLibrarianThreshold`.

---

## What the Package Does NOT Do

- **No retry logic.** LLM failures throw; callers handle them.
- **No streaming.** `generateText` must resolve to a complete string.
- **No per-call provider override.** One provider per `WikiMemory` instance.
- **No deduplication in Librarian.** New facts are appended; Heal is responsible for cleanup.
- **No ID or timestamp exposure to LLM.** The LLM never receives or emits row IDs.
