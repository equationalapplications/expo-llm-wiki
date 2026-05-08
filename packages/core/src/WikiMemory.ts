import type { SQLiteAdapter } from './types';
import { setupDatabase } from './db/schema';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
import { WikiOptions, MemoryBundle, MemoryDump, WikiEvent, WikiFact, WikiTask, WikiCheckpoint, ExtractedFact, ExtractedTask, WikiBusyError, PrunePartialFailureError, EntityStatus, ReadOptions } from './types';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from './prompts';
import MiniSearch from 'minisearch';
import { cosineSimilarity } from './utils/cosine';
import { parseEmbedding } from './utils/embedding';

export { WikiBusyError, PrunePartialFailureError } from './types';

/**
 * Private symbol to mark timeout errors thrown by WikiMemory (not from ranker).
 * Used to distinguish WikiMemory's own timeout errors from ranker errors that might contain "timed out" in message.
 */
const HOOK_TIMEOUT_MARKER = Symbol('WikiMemoryHookTimeout');

function parseJsonResponse<T>(text: string): T {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    throw new SyntaxError('No JSON object/array found in LLM response');
  }

  // Walk from `start`, tracking nesting depth and skipping strings/escapes,
  // so we stop at the true matching close bracket rather than the last one.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) { depth++; continue; }
    if (ch === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) throw new SyntaxError('No JSON object/array found in LLM response');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function generateId(prefix: string = '') {
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function safeSlice(value: string, start: number, end?: number): string {
  const length = value.length;
  let safeStart = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  let safeEnd = end === undefined
    ? length
    : end < 0
      ? Math.max(length + end, 0)
      : Math.min(end, length);

  if (safeStart > safeEnd) {
    [safeStart, safeEnd] = [safeEnd, safeStart];
  }

  if (
    safeStart > 0 &&
    safeStart < length &&
    value.charCodeAt(safeStart) >= 0xDC00 &&
    value.charCodeAt(safeStart) <= 0xDFFF &&
    value.charCodeAt(safeStart - 1) >= 0xD800 &&
    value.charCodeAt(safeStart - 1) <= 0xDBFF
  ) {
    safeStart--;
  }

  if (
    safeEnd > 0 &&
    safeEnd < length &&
    value.charCodeAt(safeEnd - 1) >= 0xD800 &&
    value.charCodeAt(safeEnd - 1) <= 0xDBFF &&
    value.charCodeAt(safeEnd) >= 0xDC00 &&
    value.charCodeAt(safeEnd) <= 0xDFFF
  ) {
    safeEnd--;
  }

  return value.slice(safeStart, safeEnd);
}

function chunkText(
  input: string,
  maxChunkLength: number,
  overlap: number
): { chunks: string[]; truncated: boolean } {
  const text = input.trim();
  if (text.length === 0) return { chunks: [], truncated: false };
  if (!Number.isInteger(maxChunkLength) || maxChunkLength < 2) {
    throw new Error('maxChunkLength must be an integer >= 2');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChunkLength) {
    throw new Error('overlap must be a non-negative integer < maxChunkLength');
  }

  const chunks: string[] = [];
  let truncated = false;
  let cursor = 0;
  const halfMax = Math.floor(maxChunkLength / 2);

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChunkLength) {
      chunks.push(safeSlice(text, cursor, text.length));
      break;
    }

    const windowEnd = cursor + maxChunkLength;
    const minSplit = cursor + halfMax;

    // 1. paragraph break
    let splitPoint = -1;
    const paraIdx = text.lastIndexOf('\n\n', windowEnd);
    if (paraIdx >= minSplit && paraIdx + 2 <= windowEnd) {
      splitPoint = paraIdx + 2;
    }

    // 2. sentence terminator (single left-to-right pass, no lookahead regex)
    if (splitPoint === -1) {
      let lastTerm = -1;
      for (let i = minSplit; i < windowEnd - 1; i++) {
        const ch = text[i];
        if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[i + 1])) {
          lastTerm = i + 2; // include the terminator + whitespace
        }
      }
      if (lastTerm !== -1 && lastTerm <= windowEnd) splitPoint = lastTerm;
    }

    // 3. whitespace
    if (splitPoint === -1) {
      for (let i = windowEnd - 1; i >= minSplit; i--) {
        if (/\s/.test(text[i])) {
          splitPoint = i + 1;
          break;
        }
      }
    }

    // 4. hard cut
    if (splitPoint === -1) {
      truncated = true;
      splitPoint = windowEnd;
    }

    chunks.push(safeSlice(text, cursor, splitPoint));
    const next = Math.max(splitPoint - overlap, cursor + 1);
    cursor = next;
  }

  return { chunks, truncated };
}

async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  let failed = false;
  let firstError: unknown;
  async function worker() {
    while (index < tasks.length && !failed) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        if (!failed) { failed = true; firstError = e; }
        return;
      }
    }
  }
  const workerCount = tasks.length === 0 ? 0 : Math.min(Math.max(limit, 1), tasks.length);
  await Promise.allSettled(Array.from({ length: workerCount }, worker));
  if (failed) throw firstError;
  return results;
}

function clip(value: string, max: number): string {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length <= max ? s : safeSlice(s, 0, max).trimEnd();
}

function validateTags(tags: any[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter(t => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0 && t.length <= 40)
    .slice(0, 6);
}

function validateFact(fact: any): ExtractedFact | null {
  if (typeof fact?.title !== 'string' || typeof fact?.body !== 'string') return null;
  const title = clip(fact.title, 80);
  const body = clip(fact.body, 800);
  if (!title || !body) return null;
  
  let confidence = fact.confidence;
  if (confidence !== 'certain' && confidence !== 'tentative') confidence = 'inferred';
  
  return {
    ...fact,
    title,
    body,
    confidence,
    tags: validateTags(fact.tags)
  };
}

function validateTask(task: any): ExtractedTask | null {
  if (typeof task?.description !== 'string') return null;
  const description = clip(task.description, 200);
  if (!description) return null;
  
  let priority = task.priority;
  if (typeof priority !== 'number' || !isFinite(priority)) priority = 0;
  
  return {
    ...task,
    description,
    priority
  };
}

function normalizeSourceRef(value: string): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeSourceHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}


function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3));
}

function jaccardScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

const FUZZY_THRESHOLD = 0.5;
const MIN_TOKENS_TO_QUALIFY = 3;

export class WikiMemory {
  private db: SQLiteAdapter;
  private prefix: string;
  private options: WikiOptions;
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();
  private miniSearch = new MiniSearch<{ id: string; entity_id: string; title: string; body: string; tags: string }>({
    fields: ['title', 'body', 'tags'],
    storeFields: ['entity_id'],
    searchOptions: {
      boost: { title: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  private miniSearchEntryIdsByEntity = new Map<string, Set<string>>();
  /**
   * Maximum number of entities whose parsed embedding vectors are held in
   * memory. This cap is intentionally conservative so the cache remains safe
   * on memory-constrained runtimes (e.g., mobile/Expo).
   */
  private static readonly MAX_VECTOR_CACHE_ENTITIES = 16;
  /**
   * Maximum number of fact vectors cached per entity. Keep this high enough to
   * preserve the parsed-embedding reuse optimization for common mid-sized
   * entities while still maintaining a bounded memory footprint.
   */
  private static readonly MAX_VECTOR_CACHE_FACTS_PER_ENTITY = 500;
  private vectorCache: Map<string, Map<string, Float32Array>> = new Map();

  private normalizeMiniSearchRow(row: {
    id: string; entity_id: string; title: string; body: string; tags: string;
  }): { id: string; entity_id: string; title: string; body: string; tags: string } {
    return {
      id: row.id,
      entity_id: row.entity_id,
      title: row.title,
      body: row.body,
      tags: (() => {
        try {
          const parsed = JSON.parse(row.tags);
          return Array.isArray(parsed) ? parsed.join(' ') : row.tags;
        } catch {
          return row.tags;
        }
      })(),
    };
  }

  private async rebuildMiniSearchIndex(entityId?: string): Promise<void> {
    if (entityId) {
      const rows = await this.db.getAllAsync<{
        id: string; entity_id: string; title: string; body: string; tags: string;
      }>(
        `SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL AND entity_id = ?`,
        [entityId],
      );

      const previousIds = this.miniSearchEntryIdsByEntity.get(entityId);
      if (previousIds) {
        for (const id of previousIds) {
          this.miniSearch.discard(id);
        }
      }

      const documents = rows.map(row => this.normalizeMiniSearchRow(row));
      if (documents.length > 0) {
        this.miniSearch.addAll(documents);
      }

      this.miniSearchEntryIdsByEntity.set(entityId, new Set(documents.map(document => document.id)));
      return;
    }

    const rows = await this.db.getAllAsync<{
      id: string; entity_id: string; title: string; body: string; tags: string;
    }>(`SELECT id, entity_id, title, body, tags FROM ${this.prefix}entries WHERE deleted_at IS NULL`);

    this.miniSearch.removeAll();
    this.miniSearchEntryIdsByEntity.clear();

    const documents = rows.map(row => this.normalizeMiniSearchRow(row));
    if (documents.length > 0) {
      this.miniSearch.addAll(documents);
    }

    for (const document of documents) {
      const ids = this.miniSearchEntryIdsByEntity.get(document.entity_id) ?? new Set<string>();
      ids.add(document.id);
      this.miniSearchEntryIdsByEntity.set(document.entity_id, ids);
    }
  }

  private async storeEmbeddingDimension(dim: number): Promise<void> {
    const existing = await this.db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension'`
    );
    if (existing) {
      const storedDim = parseInt(existing.value, 10);
      if (storedDim !== dim) {
        console.warn(
          `[WikiMemory] Embedding dimension mismatch: stored ${storedDim}, got ${dim}. ` +
          `Call runReembed() to rebuild embeddings with the new model.`
        );
        await this.db.runAsync(
          `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension_mismatch', ?)`,
          [String(dim)]
        );
      }
      // Do NOT clear 'embedding_dimension_mismatch' here: other facts may still hold
      // old-dimension blobs written during a previous model. Only _reconcileEmbeddingDimension()
      // (called after a full runReembed) may clear the flag once it confirms all stored
      // blobs match the new canonical dimension.
    } else {
      await this.db.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension', ?)`,
        [String(dim)]
      );
    }
  }

  /**
   * After a successful runReembed(), promote the pending `embedding_dimension_mismatch`
   * value to the canonical `embedding_dimension` key and clear the mismatch flag.
   * This ensures future read() calls use embedding-based retrieval rather than staying
   * stuck on the MiniSearch fallback.
   */
  private async _reconcileEmbeddingDimension(): Promise<void> {
    const mismatch = await this.db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
    );
    if (!mismatch) return;

    const newDim = parseInt(mismatch.value, 10);
    // Check whether any non-deleted fact still stores a blob with a different byte
    // length. If so, those facts haven't been re-embedded yet and the mismatch flag
    // must stay in place so read() keeps falling back to MiniSearch for them.
    // A row blocks mismatch-flag removal if:
    //   (a) it has a BLOB whose dimension differs from the new model, OR
    //   (b) it has only a TEXT vector (embedding_blob IS NULL) — TEXT rows were
    //       written by an older model and must be converted by runReembed() before
    //       they are safe to score against the new query dimension.
    const residual = await this.db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
       WHERE deleted_at IS NULL
         AND (
           (embedding_blob IS NOT NULL AND (CAST(length(embedding_blob) AS INTEGER) / 4) != ?)
           OR (embedding_blob IS NULL AND embedding IS NOT NULL)
         )`,
      [newDim]
    );
    // Only promote and clear once every stored vector uses the new dimension.
    // Promoting before all rows are converted would leave read() in an inconsistent
    // state: the canonical dim would point at the new model while TEXT-only or
    // wrong-dim blobs still exist, causing those rows to score silently as 0.
    if (!residual || residual.cnt === 0) {
      await this.db.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension', ?)`,
        [mismatch.value]
      );
      await this.db.runAsync(
        `DELETE FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
      );
    }
  }

  private async embedFact(fact: { id: string; entity_id: string; title: string; body: string; tags: string | string[] }): Promise<boolean> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return false;
    let tagsStr: string;
    if (Array.isArray(fact.tags)) {
      tagsStr = fact.tags.join(' ');
    } else {
      try {
        const parsed = JSON.parse(fact.tags);
        tagsStr = Array.isArray(parsed) ? parsed.join(' ') : fact.tags;
      } catch {
        tagsStr = fact.tags;
      }
    }
    const text = `${fact.title} ${fact.body} ${tagsStr}`.trim();
    try {
      const vector = await embedFn(text);
      // Validate before persisting: an empty or non-finite vector would poison
      // embedding_dimension and write unusable data to embedding_blob.
      if (vector.length === 0 || !vector.every(v => typeof v === 'number' && isFinite(v))) {
        console.warn(`[WikiMemory] embedFact: embed() returned an invalid vector for ${fact.id}; skipping.`);
        return false;
      }
      const float32Vector = new Float32Array(vector);
      let hasNonFinite = false;
      for (let i = 0; i < float32Vector.length; i++) {
        if (!isFinite(float32Vector[i])) { hasNonFinite = true; break; }
      }
      if (hasNonFinite) {
        console.warn(`[WikiMemory] embedFact: embed() returned values that overflow float32 for ${fact.id}; skipping.`);
        return false;
      }
      await this.storeEmbeddingDimension(float32Vector.length);
      const blob = new Uint8Array(float32Vector.buffer);
      await this.db.runAsync(
        `UPDATE ${this.prefix}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
        [blob, fact.id]
      );
      // Isolate hook failure: embedding was persisted successfully even if external index sync fails
      try {
        await this._notifyEmbeddingPersisted(fact.entity_id, fact.id, float32Vector);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for ${fact.id}:`, hookErr);
      }
      return true;
    } catch (err) {
      console.warn(`[WikiMemory] embedFact failed for ${fact.id}:`, err);
      return false;
    }
  }

  private _librarianKey(entityId: string) { return `${this.prefix}:${entityId}:librarian`; }
  private _healKey(entityId: string) { return `${this.prefix}:${entityId}:heal`; }
  private _warnCrossEntityCollision(type: 'entry' | 'task', id: string, existingEntityId: string, targetEntityId: string): void {
    console.warn(`[WikiMemory] importDump: ${type} id "${id}" already belongs to entity "${existingEntityId}"; skipping for entity "${targetEntityId}"`);
  }

  /** Maps pre-rename enum strings from older dumps to current source_type values. */
  private _normalizeImportedSourceType(
    raw: string,
    ctx?: { entityId: string; factId: string },
  ): WikiFact['source_type'] {
    if (raw === 'user_document') return 'immutable_document';
    if (raw === 'agent_inferred') return 'librarian_inferred';
    const allowed: WikiFact['source_type'][] = ['user_stated', 'librarian_inferred', 'user_confirmed', 'immutable_document'];
    if ((allowed as string[]).includes(raw)) return raw as WikiFact['source_type'];
    const where =
      ctx !== undefined ? ` for entity "${ctx.entityId}" fact "${ctx.factId}"` : '';
    throw new Error(
      `importDump: invalid source_type "${raw}"${where} (expected one of: ${allowed.join(', ')}, or legacy aliases user_document / agent_inferred)`
    );
  }

  private async assertNoLegacySourceTypes(): Promise<void> {
    const legacyProbe = await this.db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM ${this.prefix}entries
       WHERE source_type IN ('user_document', 'agent_inferred')
       LIMIT 1`,
      []
    );

    if (!legacyProbe) return;

    const legacyCount = await this.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.prefix}entries
       WHERE source_type IN ('user_document', 'agent_inferred')`,
      []
    );

    const count = legacyCount?.count ?? 0;
    const migrationSQL = `
-- Migrate legacy source_type values (targets your WikiMemory prefix: ${this.prefix})
UPDATE ${this.prefix}entries SET source_type = 'immutable_document' WHERE source_type = 'user_document';
UPDATE ${this.prefix}entries SET source_type = 'librarian_inferred' WHERE source_type = 'agent_inferred';
    `.trim();

    throw new Error(
      `Database contains ${count} entries with legacy source_type values ('user_document' or 'agent_inferred'). ` +
      `These enum values were renamed in this release. Running without migration would allow legacy 'user_document' facts to bypass ` +
      `immutability guards, causing data corruption.\n\n${migrationSQL}\n\n` +
      `After running the migration SQL, restart your application.`
    );
  }

  private async _notifyEmbeddingPersisted(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    // Defensive copy prevents hooks from mutating cache/fallback/persisted-blob vectors.
    // .slice() on Float32Array allocates a fresh ArrayBuffer (not a view).
    const vectorCopy = vector ? vector.slice() : null;
    await this.options.vectorRanker.onEmbeddingPersisted({
      entityId,
      factId,
      vector: vectorCopy,
    });
  }

  /**
   * GDPR-critical variant: awaits the hook with a timeout and rethrows failures.
   * Use ONLY on deletion paths. forget() calls after soft-delete UPDATE; runPrune()
   * calls before hard DELETE. For best-effort sync, use _notifyEmbeddingPersisted.
   */
  private async _notifyEmbeddingPersistedOrThrow(
    entityId: string,
    factId: string,
    vector: Float32Array | null,
  ): Promise<void> {
    if (!this.options.vectorRanker?.onEmbeddingPersisted) return;
    if (this.options.forceDeleteIgnoreRankerHook === true) return;

    const vectorCopy = vector ? vector.slice() : null;
    const rawTimeout = this.options.deletionHookTimeoutMs ?? 30_000;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('Invalid deletionHookTimeoutMs: must be a positive finite number');
    }
    const timeoutMs = rawTimeout;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => {
          const timeoutError = new Error(`onEmbeddingPersisted timed out after ${timeoutMs}ms`);
          (timeoutError as any)[HOOK_TIMEOUT_MARKER] = true;
          reject(timeoutError);
        },
        timeoutMs,
      );
    });

    const hookPromise = Promise.resolve(
      this.options.vectorRanker.onEmbeddingPersisted({
        entityId,
        factId,
        vector: vectorCopy,
      }),
    );

    try {
      await Promise.race([hookPromise, timeoutPromise]);
    } catch (err) {
      // Suppress late rejections from hook if timeout won
      hookPromise.catch(() => {});
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  constructor(db: SQLiteAdapter, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';
  }

  async setup() {
    // Probe entries-table existence BEFORE creating any tables.  setupDatabase()
    // uses IF NOT EXISTS throughout, so once it has run the entries table always
    // exists and the fresh-install branch would be unreachable.  Future migrations
    // that ALTER TABLE would also fail if run against a schema already at the
    // target version but inferred as legacy because the probe ran too late.
    const entriesExistedBeforeSetup = await this.db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [`${this.prefix}entries`]
    );

    await setupDatabase(this.db, this.prefix);

    let currentVersion: number;

    if (!entriesExistedBeforeSetup) {
      // Fresh install — all tables just created at current schema; no migrations needed.
      await this.db.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('schema_version', ?)`,
        [String(CURRENT_SCHEMA_VERSION)]
      );
      currentVersion = CURRENT_SCHEMA_VERSION;
    } else {
      // Existing install — check meta for schema version.
      const metaRow = await this.db.getFirstAsync<{ value: string }>(
        `SELECT value FROM ${this.prefix}meta WHERE key = 'schema_version'`
      );

      if (metaRow) {
        currentVersion = parseInt(metaRow.value, 10);
        if (!Number.isFinite(currentVersion)) currentVersion = 0;
      } else {
        // Legacy install without meta row — infer version from porter probe.
        const ftsMeta = await this.db.getFirstAsync<{ sql: string | null }>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
          [`${this.prefix}entries_fts`]
        );
        const hasPorter = /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsMeta?.sql ?? '');
        currentVersion = hasPorter ? 1 : 0;
      }
    }

    // Run pending migrations in order.
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        await migration.run(this.db, this.prefix);
        await this.db.runAsync(
          `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('schema_version', ?)`,
          [String(migration.version)]
        );
        currentVersion = migration.version;
      }
    }

    // Ensure meta row exists for legacy installs already at current version
    // (porter present, no meta row) — the migration loop may not have written it.
    if (entriesExistedBeforeSetup) {
      const metaCheck = await this.db.getFirstAsync<{ value: string }>(
        `SELECT value FROM ${this.prefix}meta WHERE key = 'schema_version'`
      );
      if (!metaCheck) {
        await this.db.runAsync(
          `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('schema_version', ?)`,
          [String(currentVersion)]
        );
      }
    }

    // Fail before any other mutating passes (e.g. source_ref normalization) so we never
    // partially "repair" a DB that is still on legacy source_type strings.
    if (entriesExistedBeforeSetup) {
      await this.assertNoLegacySourceTypes();
    }

    // Migration: normalize any existing source_ref values that were stored before the
    // allowlist rule ([^A-Za-z0-9._\- ] → strip) was introduced.  Read-then-update in
    // JS so the normalization is guaranteed to match what normalizeSourceRef() produces,
    // regardless of which characters the old normalization left behind.
    // The WHERE clause pre-filters to rows that contain any character outside the
    // allowlist (checking leading/trailing whitespace, slashes, backslashes, NUL, and
    // the full ASCII non-allowlist range via GLOB) so that already-normalized
    // rows are never fetched.  Idempotent: after the first run no rows match the filter.
    type Row = { rowid: number; source_ref: string };
    const rows = await this.db.getAllAsync<Row>(`
      SELECT rowid, source_ref FROM ${this.prefix}entries
      WHERE source_ref IS NOT NULL
        AND (
          TRIM(source_ref) != source_ref
          OR INSTR(source_ref, '/') > 0
          OR INSTR(source_ref, '\\') > 0
          OR INSTR(source_ref, CHAR(0)) > 0
          OR source_ref GLOB '*[^-A-Za-z0-9._ ]*'
        )
    `);
    await this.db.withTransactionAsync(async () => {
      for (const row of rows) {
        const normalized = normalizeSourceRef(row.source_ref);
        if (normalized !== row.source_ref) {
          await this.db.runAsync(
            `UPDATE ${this.prefix}entries SET source_ref = ? WHERE rowid = ?`,
            [normalized, row.rowid]
          );
        }
      }
    });

    await this.rebuildMiniSearchIndex();
  }

  async hasChanged(entityId: string, sourceRef: string, sourceHash: string): Promise<boolean> {
    const normalizedRef = normalizeSourceRef(sourceRef);
    if (!normalizedRef) {
      throw new Error(`Invalid sourceRef: "${sourceRef}"`);
    }
    const normalizedHash = normalizeSourceHash(sourceHash);
    if (!normalizedHash) {
      throw new Error(`Invalid sourceHash: must be a 64-character hex string (normalized to lowercase)`);
    }
    const row = await this.db.getFirstAsync<{ source_hash: string | null }>(
      `SELECT source_hash FROM ${this.prefix}entries
       WHERE entity_id = ? AND source_ref = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [entityId, normalizedRef]
    );
    if (!row) return true;
    const normalizedStoredHash = row.source_hash ? normalizeSourceHash(row.source_hash) : null;
    return normalizedStoredHash !== normalizedHash;
  }

  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }
  private _reembedKey(entityId: string) { return `${this.prefix}:${entityId}:reembed`; }
  private _globalReembedKey() { return `${this.prefix}:reembed`; }
  private _importKey(entityId: string) { return `${this.prefix}:${entityId}:import`; }
  private _globalImportKey() { return `${this.prefix}:import`; }
  private _forgetKey(entityId: string) { return `${this.prefix}:${entityId}:forget`; }
  private _isReembedActive(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._reembedKey(entityId))
      || this.activeMaintenanceJobs.has(this._globalReembedKey());
  }
  private _isImportActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._importKey(entityId))
      || this.activeMaintenanceJobs.has(this._globalImportKey());
  }
  private _isForgetActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._forgetKey(entityId));
  }
  /** Returns true if any maintenance job has the given operation suffix (e.g. ':prune'). */
  private _isAnyMaintenanceActiveWithSuffix(suffix: string): boolean {
    const entityKeyPrefix = `${this.prefix}:`;
    for (const k of this.activeMaintenanceJobs) {
      if (k.startsWith(entityKeyPrefix) && k.endsWith(suffix)) return true;
    }
    return false;
  }
  /** Returns true if any ingest job is active for the given entity. */
  private _isIngestActiveFor(entityId: string): boolean {
    const entityKeyPrefix = `${this.prefix}:${entityId}:`;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(entityKeyPrefix)) return true;
    }
    return false;
  }

  private _validatePruneDuration(value: number | null | undefined, name: string): void {
    if (value !== null && value !== undefined && (typeof value !== 'number' || !isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${name}: must be a non-negative finite number or null`);
    }
  }

  async runPrune(
    entityId: string,
    options?: {
      retainSoftDeletedFor?: number | null;
      retainEventsFor?: number | null;
      vacuum?: boolean;
    }
  ): Promise<{ entries: number; tasks: number; events: number }> {
    const pruneKey = this._pruneKey(entityId);
    // Prune must not run concurrently with librarian, heal, ingest, import, or another
    // prune for the same entity.
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    let isIngestRunning = false;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) { isIngestRunning = true; break; }
    }
    let blockingOperation: 'prune' | 'librarian' | 'heal' | 'ingest' | 'reembed' | 'import' | 'forget' | null = null;
    if (this.activeMaintenanceJobs.has(pruneKey)) {
      blockingOperation = 'prune';
    } else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) {
      blockingOperation = 'librarian';
    } else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) {
      blockingOperation = 'heal';
    } else if (this._isReembedActive(entityId)) {
      blockingOperation = 'reembed';
    } else if (isIngestRunning) {
      blockingOperation = 'ingest';
    } else if (this._isImportActiveFor(entityId)) {
      blockingOperation = 'import';
    } else if (this._isForgetActiveFor(entityId)) {
      blockingOperation = 'forget';
    }
    if (blockingOperation !== null) {
      throw new WikiBusyError(blockingOperation, entityId);
    }
    this.activeMaintenanceJobs.add(pruneKey);
    try {
      const retainSoftDeletedFor = options?.retainSoftDeletedFor !== undefined
        ? options.retainSoftDeletedFor
        : (this.options.config?.pruneRetainSoftDeletedFor ?? 7);
      const retainEventsFor = options?.retainEventsFor !== undefined
        ? options.retainEventsFor
        : (this.options.config?.pruneEventsAfter ?? 30);
      const vacuum = options?.vacuum ?? false;

      this._validatePruneDuration(retainSoftDeletedFor, 'retainSoftDeletedFor');
      this._validatePruneDuration(retainEventsFor, 'retainEventsFor');

      const now = Date.now();
      let deletedEntries = 0;
      let deletedTasks = 0;
      let deletedEvents = 0;

      if (retainSoftDeletedFor !== null) {
        const cutoff = now - retainSoftDeletedFor * 86400000;

        const entriesToDelete = await this.db.getAllAsync<{ id: string; entity_id: string }>(
          `SELECT id, entity_id FROM ${this.prefix}entries
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
          [entityId, cutoff]
        );

        // Hook-before-delete: await hook for each row, accumulate successes, commit partial on failure
        const succeeded: Array<{ entity_id: string; id: string }> = [];
        let failure: { factId: string; cause: unknown } | null = null;

        for (const row of entriesToDelete) {
          try {
            await this._notifyEmbeddingPersistedOrThrow(row.entity_id, row.id, null);
            succeeded.push({ entity_id: row.entity_id, id: row.id });
          } catch (err) {
            failure = { factId: row.id, cause: err };
            break;
          }
        }

        if (succeeded.length > 0) {
          // Delete in chunks to avoid SQLite bind-parameter limit (typically 999)
          const chunkSize = 500;
          for (let i = 0; i < succeeded.length; i += chunkSize) {
            const chunk = succeeded.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const entryResult = await this.db.runAsync(
              `DELETE FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ? AND id IN (${placeholders})`,
              [entityId, cutoff, ...chunk.map((r) => r.id)],
            );
            deletedEntries += entryResult.changes;
          }
        }

        // Delete tasks (independent of entry hook success/failure)
        const taskResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}tasks
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
          [entityId, cutoff]
        );
        deletedTasks = taskResult.changes;

        if (failure) {
          // Rebuild index and clear cache to reflect successful partial deletions
          await this.rebuildMiniSearchIndex(entityId);
          this.vectorCache.delete(entityId);

          const remaining = entriesToDelete.length - succeeded.length - 1;

          // Preserve timeout errors (thrown by WikiMemory, not the ranker)
          const isTimeout = (failure.cause as any)?.[HOOK_TIMEOUT_MARKER] === true;
          if (isTimeout) {
            throw new PrunePartialFailureError(
              succeeded.length,
              failure.factId,
              remaining,
              new Error('Deletion hook timed out'),
              deletedTasks,
              0, // events not yet deleted at this point
            );
          }

          // Preserve WikiMemory validation errors (not from the adapter hook)
          const errMsg = (failure.cause as Error)?.message ?? '';
          const isValidationError = errMsg.startsWith('Invalid deletionHookTimeoutMs');
          const sanitizedCause = isValidationError
            ? failure.cause as Error
            : this._sanitizeRankerError(failure.cause);

          throw new PrunePartialFailureError(
            succeeded.length,
            failure.factId,
            remaining,
            sanitizedCause,
            deletedTasks,
            0, // events not yet deleted at this point
          );
        }
      }

      if (retainEventsFor !== null) {
        const cutoff = now - retainEventsFor * 86400000;
        const eventResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}events
           WHERE entity_id = ? AND created_at <= ?`,
          [entityId, cutoff]
        );
        deletedEvents = eventResult.changes;
      }

      if (vacuum) {
        await this.db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
        await this.db.execAsync(`VACUUM`);
      }

      await this.rebuildMiniSearchIndex(entityId);
      this.vectorCache.delete(entityId);

      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.activeMaintenanceJobs.delete(pruneKey);
    }
  }

  async read(entityId: string, query: string, options?: ReadOptions): Promise<MemoryBundle> {
    const config = this.options.config;
    const rawMaxResults = options?.maxResults ?? config?.maxResults ?? config?.maxFtsResults ?? 10;
    const maxResults = Number.isFinite(rawMaxResults)
      ? Math.max(0, Math.trunc(rawMaxResults))
      : 10;
    const rawPreFilterLimit =
      options?.preFilterLimit === null
        ? undefined
        : (options?.preFilterLimit ?? config?.preFilterLimit);
    const effectivePreFilterLimit =
      rawPreFilterLimit === undefined
        ? undefined
        : Number.isFinite(rawPreFilterLimit)
          ? Math.max(0, Math.trunc(rawPreFilterLimit))
          : undefined;
    const hybridWeight = options?.hybridWeight ?? config?.hybridWeight;
    const weight = hybridWeight !== undefined && !Number.isNaN(hybridWeight)
      ? Math.max(0, Math.min(1, hybridWeight))
      : undefined;
    const skipEmbed = weight === 0;
    const embedFn = this.options.llmProvider.embed;
    const trimmedQuery = query.trim();

    let facts: WikiFact[] = [];

    if (maxResults === 0) {
      // Fast-path: a zero-capacity result window can never return any facts.
      // Skip embed(), DB scan, and sort — fall through to tasks/events fetch below.
    } else if (trimmedQuery) {
      let usedEmbed = false;

      if (!skipEmbed && embedFn) {
        let rankerShouldRethrow = false;
        let pendingRankerFallbackError: Error | undefined;
        let usedKeywordFallback = false;
        let scoredAlreadySortedAndLimited = false;
        try {
          const queryVec = await embedFn(trimmedQuery);

          // Validate that the provider returned a well-formed vector. An empty vector
          // would cause all facts to score 0 (silently bypassing the fallback), and
          // non-finite values (NaN, Infinity) make the sort comparator unstable.
          if (queryVec.length === 0 || !queryVec.every(v => typeof v === 'number' && isFinite(v))) {
            throw new Error(
              'embed() returned an empty or non-finite vector. Falling back to keyword search.'
            );
          }

          // Detect embedding dimension mismatch: if stored dimension differs from the
          // query vector, existing fact embeddings were built with a different model and
          // cosine scoring would silently produce misleading rankings. Fall back to
          // MiniSearch until the caller runs runReembed().
          const storedDimRow = await this.db.getFirstAsync<{ value: string }>(
            `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension'`
          );
          if (storedDimRow) {
            const storedDim = parseInt(storedDimRow.value, 10);
            if (storedDim !== queryVec.length) {
              throw new Error(
                `Embedding dimension mismatch: stored ${storedDim}, query has ${queryVec.length}. ` +
                `Call runReembed() to rebuild embeddings with the new model.`
              );
            }
          }

          // Check whether any non-deleted fact for this entity has a blob whose
          // dimension differs from the query vector. A global meta flag would block
          // all entities when only one was imported with a mismatched model, so we
          // do a direct per-entity SQL count here instead.
          const mismatchedCount = await this.db.getFirstAsync<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
             WHERE entity_id = ? AND deleted_at IS NULL
               AND embedding_blob IS NOT NULL
               AND (CAST(length(embedding_blob) AS INTEGER) % 4 = 0)
               AND (CAST(length(embedding_blob) AS INTEGER) / 4) != ?`,
            [entityId, queryVec.length]
          );
          if (mismatchedCount && mismatchedCount.cnt > 0) {
            throw new Error(
              `Some facts have embeddings that do not match the current model dimension. ` +
              `Call runReembed() to rebuild all embeddings consistently.`
            );
          }

          // Determine candidate rows
          type CandidateRowMetadata = { id: string; updated_at: number | null; access_count: number | null };
          type CandidateRowWithEmbeddings = CandidateRowMetadata & { embedding_blob: Uint8Array | null; embedding: string | null };
          const useRanker = Boolean(this.options.vectorRanker);
          let candidateRows: CandidateRowMetadata[] | CandidateRowWithEmbeddings[] | null; // null = pre-filter returned 0 results
          let populateCache = true;
          let miniSearchScores: Map<string, number> | undefined;

          if (effectivePreFilterLimit !== undefined) {
            populateCache = false; // partial scan — do not populate cache
            const preResults = this.miniSearch.search(trimmedQuery, {
              filter: (r) => (r as unknown as { entity_id: string }).entity_id === entityId,
              combineWith: 'OR',
            });
            if (preResults.length === 0) {
              candidateRows = null; // empty pre-filter
            } else {
              const topKResults = preResults.slice(0, effectivePreFilterLimit);
              if (topKResults.length === 0) {
                // effectivePreFilterLimit is 0 — treat the same as no candidates
                // (avoids constructing an invalid "WHERE id IN ()" SQL clause)
                candidateRows = null;
              } else {
                const topKIds = topKResults.map(r => r.id);
                const inClauseChunkSize = 500;
                if (useRanker) {
                  const rows: CandidateRowMetadata[] = [];
                  for (let i = 0; i < topKIds.length; i += inClauseChunkSize) {
                    const idChunk = topKIds.slice(i, i + inClauseChunkSize);
                    const placeholders = idChunk.map(() => '?').join(',');
                    const chunkRows = await this.db.getAllAsync<CandidateRowMetadata>(
                      `SELECT id, updated_at, access_count FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
                      idChunk
                    );
                    rows.push(...chunkRows);
                  }
                  candidateRows = rows;
                } else {
                  const rows: CandidateRowWithEmbeddings[] = [];
                  for (let i = 0; i < topKIds.length; i += inClauseChunkSize) {
                    const idChunk = topKIds.slice(i, i + inClauseChunkSize);
                    const placeholders = idChunk.map(() => '?').join(',');
                    const chunkRows = await this.db.getAllAsync<CandidateRowWithEmbeddings>(
                      `SELECT id, embedding_blob, embedding, updated_at, access_count FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
                      idChunk
                    );
                    rows.push(...chunkRows);
                  }
                  candidateRows = rows;
                }
                if (weight !== undefined && weight < 1) {
                  const maxMsScore = Math.max(1, topKResults[0]?.score ?? 1);
                  miniSearchScores = new Map(topKResults.map(r => [r.id, r.score / maxMsScore]));
                }
              }
            }
          } else {
            // Full entity scan
            // If vectorRanker is configured, skip embedding load for now (ranker will provide ranking)
            // Otherwise fetch embeddings for JS cosine ranking
            if (useRanker) {
              candidateRows = await this.db.getAllAsync<CandidateRowMetadata>(
                `SELECT id, updated_at, access_count FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
                [entityId]
              );
            } else {
              candidateRows = await this.db.getAllAsync<CandidateRowWithEmbeddings>(
                `SELECT id, embedding_blob, embedding, updated_at, access_count FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
                [entityId]
              );
            }
            // Collect MiniSearch scores for hybrid blend if weight is set and <1
            // (weight=1 is all-semantic with clamped scores; pure semantic [-1,1] requires weight undefined)
            if (weight !== undefined && weight < 1) {
              const msResults = this.miniSearch.search(trimmedQuery, {
                filter: (r) => (r as unknown as { entity_id: string }).entity_id === entityId,
                combineWith: 'OR',
              });
              const maxMsScore = Math.max(1, msResults[0]?.score ?? 1);
              miniSearchScores = new Map(msResults.map(r => [r.id, r.score / maxMsScore]));
            }
          }

          if (candidateRows === null) {
            // pre-filter returned 0 candidates — facts = [], skip phase 2, skip access tracking
            usedEmbed = true;
          } else {
            // Rank candidates: use vectorRanker if present, otherwise use JS cosine
            let scored: Array<{ id: string; score: number; updated_at?: number | null; access_count?: number | null }>;

            if (useRanker) {
              // Use external ranker for semantic scoring
              const candidateIds = effectivePreFilterLimit !== undefined
                ? candidateRows.map(r => r.id)
                : undefined;

              try {
                // Oversample by max(2x, +50) to preserve recall after re-ranking;
                // caller slices final output to maxResults.
                const oversampledLimit = Math.max(maxResults * 2, maxResults + 50);
                scored = await this._rankWithVectorRanker({
                  entityId,
                  queryVec,
                  candidateIds,
                  weight,
                  miniSearchScores,
                  limit: oversampledLimit,
                });

                // Attach tie-break metadata from candidateRows (only for IDs returned by ranker)
                if (scored.length > 0) {
                  const scoredIds = new Set(scored.map(s => s.id));
                  const metaMap = new Map<string, { updated_at: number | null; access_count: number | null }>();
                  for (const r of candidateRows) {
                    if (scoredIds.has(r.id)) {
                      metaMap.set(r.id, { updated_at: r.updated_at, access_count: r.access_count });
                    }
                  }
                  scored = scored.map(s => {
                    const meta = metaMap.get(s.id);
                    return { ...s, updated_at: meta?.updated_at ?? null, access_count: meta?.access_count ?? null };
                  });
                }

                // Backfill ranker-omitted rows per VectorRanker contract:
                // treat missing ids as "no embedding" (pure semantic: -2, hybrid: keyword-only)
                const scoredIds = new Set(scored.map(s => s.id));

                // Compute backfill budget up-front.
                // Hybrid mode: allow up to maxResults keyword-only rows to compete.
                // Pure semantic: only fill the remaining result slots.
                const isHybrid = weight !== undefined && weight < 1;
                const maxBackfill = isHybrid
                  ? maxResults
                  : Math.max(0, maxResults - scored.length);

                if (maxBackfill > 0) {
                  if (isHybrid) {
                    // Hybrid mode: prioritize by keyword score using O(N log K) top-K selection
                    // instead of O(N log N) full sort, since K (maxBackfill) is typically << N.
                    type CandidateRow = typeof candidateRows[number];
                    const topK: Array<{ row: CandidateRow; kwScore: number }> = [];

                    for (const row of candidateRows) {
                      if (scoredIds.has(row.id)) continue;
                      const kwScore = miniSearchScores?.get(row.id) ?? 0;
                      const candidate = { row, kwScore };

                      if (topK.length < maxBackfill) {
                        // Array not full yet - insert in sorted position (descending order)
                        let insertIdx = topK.length;
                        for (let i = 0; i < topK.length; i++) {
                          const cmp = this._compareScoredRows(
                            {
                              id: candidate.row.id,
                              score: candidate.kwScore,
                              updated_at: candidate.row.updated_at,
                              access_count: candidate.row.access_count,
                            },
                            {
                              id: topK[i].row.id,
                              score: topK[i].kwScore,
                              updated_at: topK[i].row.updated_at,
                              access_count: topK[i].row.access_count,
                            }
                          );
                          if (cmp < 0) {
                            insertIdx = i;
                            break;
                          }
                        }
                        topK.splice(insertIdx, 0, candidate);
                      } else {
                        const cmpWorst = this._compareScoredRows(
                          {
                            id: candidate.row.id,
                            score: candidate.kwScore,
                            updated_at: candidate.row.updated_at,
                            access_count: candidate.row.access_count,
                          },
                          {
                            id: topK[maxBackfill - 1].row.id,
                            score: topK[maxBackfill - 1].kwScore,
                            updated_at: topK[maxBackfill - 1].row.updated_at,
                            access_count: topK[maxBackfill - 1].row.access_count,
                          }
                        );
                        if (cmpWorst < 0) {
                          // Found better candidate than current worst - replace worst and re-insert
                          let insertIdx = maxBackfill - 1;
                          for (let i = 0; i < topK.length; i++) {
                            const cmp = this._compareScoredRows(
                              {
                                id: candidate.row.id,
                                score: candidate.kwScore,
                                updated_at: candidate.row.updated_at,
                                access_count: candidate.row.access_count,
                              },
                              {
                                id: topK[i].row.id,
                                score: topK[i].kwScore,
                                updated_at: topK[i].row.updated_at,
                                access_count: topK[i].row.access_count,
                              }
                            );
                            if (cmp < 0) {
                              insertIdx = i;
                              break;
                            }
                          }
                          topK.splice(insertIdx, 0, candidate);
                          topK.pop(); // Remove worst element
                        }
                      }
                    }

                    for (const { row, kwScore } of topK) {
                      scored.push({
                        id: row.id,
                        score: (1 - weight) * kwScore,
                        updated_at: row.updated_at,
                        access_count: row.access_count,
                      });
                    }
                  } else {
                    // Pure semantic: all omitted rows share score -2.
                    // Tie-break omitted rows deterministically before truncating.
                    const omitted: Array<{ id: string; score: number; updated_at: number | null; access_count: number | null }> = [];
                    for (const row of candidateRows) {
                      if (scoredIds.has(row.id)) continue;
                      omitted.push({ id: row.id, score: -2, updated_at: row.updated_at, access_count: row.access_count });
                    }
                    if (omitted.length > 0) {
                      this._tieBreakSort(omitted);
                      scored.push(...omitted.slice(0, maxBackfill));
                    }
                  }
                }
              } catch (rankerErr) {
                const rankerError = rankerErr instanceof Error ? rankerErr : new Error(String(rankerErr));
                const policy = this.options.vectorRankerFallback ?? 'js-cosine';

                this.options.onVectorRankerFallback?.({
                  error: this._sanitizeRankerError(rankerError),
                  policy,
                });

                if (policy === 'throw') {
                  rankerShouldRethrow = true;
                  throw rankerError;
                } else if (policy === 'js-cosine') {
                  // If embeddings were skipped (vectorRanker was configured), fetch them now for fallback
                  let fallbackRows = candidateRows;
                  if (fallbackRows && fallbackRows.length > 0 && !('embedding_blob' in fallbackRows[0])) {
                    const rowIds = fallbackRows.map(r => r.id);
                    const embeddingsMap = new Map<string, { embedding_blob: Uint8Array | null; embedding: string | null }>();
                    const chunkSize = 500;
                    for (let i = 0; i < rowIds.length; i += chunkSize) {
                      const idChunk = rowIds.slice(i, i + chunkSize);
                      const placeholders = idChunk.map(() => '?').join(',');
                      const embeddingRows = await this.db.getAllAsync<{ id: string; embedding_blob: Uint8Array | null; embedding: string | null }>(
                        `SELECT id, embedding_blob, embedding FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND entity_id = ? AND deleted_at IS NULL`,
                        [...idChunk, entityId]
                      );
                      for (const row of embeddingRows) {
                        embeddingsMap.set(row.id, { embedding_blob: row.embedding_blob, embedding: row.embedding });
                      }
                    }
                    fallbackRows = fallbackRows.map(r => ({
                      ...r,
                      embedding_blob: embeddingsMap.get(r.id)?.embedding_blob ?? null,
                      embedding: embeddingsMap.get(r.id)?.embedding ?? null,
                    })) as CandidateRowWithEmbeddings[];
                  }
                  scored = await this._rankWithJsCosine({
                    entityId,
                    queryVec,
                    candidateRows: fallbackRows as CandidateRowWithEmbeddings[],
                    weight,
                    miniSearchScores,
                    populateCache,
                    limit: maxResults,
                  });
                  scoredAlreadySortedAndLimited = true;
                } else if (policy === 'keyword') {
                  // Fall back to keyword-only results from MiniSearch
                  const msResults = this.miniSearch.search(trimmedQuery, {
                    filter: (r) => (r as unknown as { entity_id: string }).entity_id === entityId,
                    combineWith: 'OR',
                  });
                  const topResults = msResults.slice(0, maxResults);
                  // Build metadata map only for returned IDs (not all candidates)
                  const resultIds = new Set(topResults.map(r => r.id));
                  const candidateMap = new Map<string, { updated_at: number | null; access_count: number | null }>();
                  for (const r of candidateRows) {
                    if (resultIds.has(r.id)) {
                      candidateMap.set(r.id, { updated_at: r.updated_at, access_count: r.access_count });
                    }
                  }
                  scored = topResults.map(r => {
                    const meta = candidateMap.get(r.id);
                    return {
                      id: r.id,
                      score: r.score ?? 0,
                      access_count: meta?.access_count ?? null,
                      updated_at: meta?.updated_at ?? null,
                    };
                  });
                  usedKeywordFallback = true;
                } else {
                  // policy === 'empty'
                  scored = [];
                }

                if (this.options.propagateRankerFailureToRetrievalFallback) {
                  const mirrored = new Error('Vector ranker failed, falling back', {
                    cause: this._sanitizeRankerError(rankerErr),
                  });
                  pendingRankerFallbackError = mirrored;
                }
              }
            } else {
              // Use in-process JS cosine similarity
              // At this point candidateRows must have embeddings (we fetched them because vectorRanker is not configured)
              scored = await this._rankWithJsCosine({
                entityId,
                queryVec,
                candidateRows: candidateRows as CandidateRowWithEmbeddings[],
                weight,
                miniSearchScores,
                populateCache,
                limit: maxResults,
              });
              scoredAlreadySortedAndLimited = true;
            }

            if (scored.length > 0) {
              // Re-apply tie-break sorting (ranker might not have stable ordering)
              // Skip for keyword-only fallback to preserve MiniSearch ordering
              if (!usedKeywordFallback && !scoredAlreadySortedAndLimited) {
                this._tieBreakSort(scored);
              }

              // Phase 2: fetch full rows only for the top results
              const topIds = (scoredAlreadySortedAndLimited ? scored : scored.slice(0, maxResults)).map(s => s.id);
              if (topIds.length > 0) {
                const fullRows: Array<WikiFact & { embedding: string | null; embedding_blob: Uint8Array | null }> = [];
                const phase2ChunkSize = 500;
                for (let i = 0; i < topIds.length; i += phase2ChunkSize) {
                  const idChunk = topIds.slice(i, i + phase2ChunkSize);
                  const placeholders = idChunk.map(() => '?').join(',');
                  const chunkRows = await this.db.getAllAsync<WikiFact & { embedding: string | null; embedding_blob: Uint8Array | null }>(
                    `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND entity_id = ? AND deleted_at IS NULL`,
                    [...idChunk, entityId]
                  );
                  fullRows.push(...chunkRows);
                }
                const byId = new Map(fullRows.map(r => [r.id, r]));
                facts = topIds.map(id => byId.get(id)).filter((f): f is WikiFact & { embedding: string | null; embedding_blob: Uint8Array | null } => f !== undefined);

                // Hydration can return fewer rows than ranked IDs when rows were concurrently
                // soft-deleted or filtered by deleted_at before phase 2 hydration completes.
                if (facts.length < topIds.length) {
                  const missingIds = topIds.filter(id => !byId.has(id));
                  const missingCount = missingIds.length;
                  const sample = missingIds.slice(0, 5);
                  const sampleSuffix = sample.length > 0
                    ? ` Missing ID sample: ${sample.join(', ')}${missingIds.length > sample.length ? ', ...' : ''}.`
                    : '';
                  const error = new Error(
                    `Phase 2 fact hydration returned ${missingCount} fewer row(s) than ranked IDs for entity ${entityId}. ` +
                    `Rows may have been concurrently soft-deleted or filtered by deleted_at during hydration, ` +
                    `or vector ranker output may include IDs that do not exist for this entity.` +
                    sampleSuffix
                  );
                  this.options.onRetrievalFallback?.(error);
                }
              }
              // Phase 2 succeeded — now safe to notify that ranker fallback occurred
              if (pendingRankerFallbackError) {
                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                pendingRankerFallbackError = undefined;
              }
              usedEmbed = true;
            } else {
              // Empty scored results (ranker returned no matches)
              if (pendingRankerFallbackError) {
                this.options.onRetrievalFallback?.(pendingRankerFallbackError);
                pendingRankerFallbackError = undefined;
              }
              usedEmbed = true;
            }
          } // closes the candidateRows !== null else block
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (rankerShouldRethrow) {
            throw error;
          }
          // If Phase 2 failed and there's a pending ranker error, include it as cause
          if (pendingRankerFallbackError) {
            (error as any).cause = pendingRankerFallbackError;
            pendingRankerFallbackError = undefined;
          }
          // Always notify of Phase 2 errors (ranker error attached as cause if present)
          this.options.onRetrievalFallback?.(error);
        }
      }

      if (!usedEmbed) {
        // embed absent or threw — fall back to MiniSearch
        const results = this.miniSearch.search(trimmedQuery, {
          filter: (r) => (r as unknown as { entity_id: string }).entity_id === entityId,
          combineWith: 'OR',
        });
        const topIds = results.slice(0, maxResults).map((r: { id: string }) => r.id);
        if (topIds.length > 0) {
          const kwRows: WikiFact[] = [];
          const kwChunkSize = 500;
          for (let i = 0; i < topIds.length; i += kwChunkSize) {
            const idChunk = topIds.slice(i, i + kwChunkSize);
            const placeholders = idChunk.map(() => '?').join(',');
            const chunkRows = await this.db.getAllAsync<WikiFact>(
              `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND entity_id = ? AND deleted_at IS NULL`,
              [...idChunk, entityId]
            );
            kwRows.push(...chunkRows);
          }
          const byId = new Map(kwRows.map(r => [r.id, r]));
          facts = topIds.map(id => byId.get(id)).filter((f): f is WikiFact => f !== undefined);
        }
      }

      if (facts.length > 0) {
        const ids = facts.map(f => f.id);
        const now = Date.now();
        const accessChunkSize = 500;
        for (let i = 0; i < ids.length; i += accessChunkSize) {
          const idChunk = ids.slice(i, i + accessChunkSize);
          const placeholders = idChunk.map(() => '?').join(',');
          await this.db.runAsync(
            `UPDATE ${this.prefix}entries
             SET access_count = access_count + 1, last_accessed_at = ?
             WHERE id IN (${placeholders})`,
            [now, ...idChunk]
          );
        }
      }
    } else {
      facts = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries
         WHERE entity_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
        [entityId, maxResults]
      );
    }

    const [tasks, events] = await Promise.all([
      this.db.getAllAsync<WikiTask>(
        `SELECT * FROM ${this.prefix}tasks
         WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL
         ORDER BY priority DESC, created_at ASC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiEvent>(
        `SELECT * FROM ${this.prefix}events
         WHERE entity_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [entityId]
      ),
    ]);

    const parsedFacts = facts.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return {
        ...rest,
        tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
      };
    });

    return { facts: parsedFacts, tasks, events: events.reverse() };
  }

  /**
   * Stable tie-break sort: score desc → access_count desc → updated_at desc → id asc.
   */
  private _tieBreakSort<T extends { id: string; score: number; updated_at?: number | null; access_count?: number | null }>(items: T[]): void {
    items.sort((a, b) => this._compareScoredRows(a, b));
  }

  /**
   * Comparator for score + deterministic tie-break fields.
   * Negative return means "a ranks ahead of b" for descending score order.
   */
  private _compareScoredRows(
    a: { id: string; score: number; updated_at?: number | null; access_count?: number | null },
    b: { id: string; score: number; updated_at?: number | null; access_count?: number | null },
  ): number {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    const accessCountDiff = (b.access_count ?? 0) - (a.access_count ?? 0);
    if (accessCountDiff !== 0) return accessCountDiff;
    const updatedAtDiff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (updatedAtDiff !== 0) return updatedAtDiff;
    return a.id.localeCompare(b.id);
  }

  /**
   * Strip potentially sensitive data from ranker errors before exposing to host callbacks.
   * Preserves error type for debugging but removes message/stack that may contain credentials.
   * Recursively sanitizes one level of .cause; deeper chains collapse to type only.
   */
  private _sanitizeRankerError(err: unknown): Error {
    if (this.options.sanitizeRankerErrors === false) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const typeName =
      err instanceof Error
        ? (err.constructor?.name ?? 'Error')
        : typeof err;

    const innerCause =
      err instanceof Error && err.cause !== undefined
        ? new Error(`Caused by: ${(err.cause as Error)?.constructor?.name ?? typeof err.cause}`)
        : undefined;

    const sanitized = new Error(
      `VectorRanker ${typeName} (message scrubbed for security)`,
      innerCause ? { cause: innerCause } : undefined,
    );
    sanitized.name = typeName;
    return sanitized;
  }

  /**
   * Score candidate rows using in-process JS cosine similarity.
   * Applies hybrid blending (if weight set) and tie-break sorting before returning.
   */
  private async _rankWithJsCosine(args: {
    entityId: string;
    queryVec: Float32Array | number[];
    candidateRows: Array<{ id: string; embedding_blob: Uint8Array | null; embedding: string | null; updated_at: number | null; access_count: number | null }>;
    weight: number | undefined;
    miniSearchScores: Map<string, number> | undefined;
    populateCache: boolean;
    limit: number;
  }): Promise<Array<{ id: string; score: number; updated_at: number | null; access_count: number | null }>> {
    const queryVec = args.queryVec instanceof Float32Array
      ? args.queryVec.slice()
      : Array.from(args.queryVec);
    const { entityId, candidateRows, weight, miniSearchScores, populateCache, limit } = args;

    // Cache: reuse parsed vectors from prior full-scan reads
    let entityCache = this.vectorCache.get(entityId);
    const tooLarge = populateCache && candidateRows.length > WikiMemory.MAX_VECTOR_CACHE_FACTS_PER_ENTITY;
    if (tooLarge && entityCache) {
      this.vectorCache.delete(entityId);
      entityCache = undefined;
    }
    const canCache = populateCache && !tooLarge;
    if (canCache && !entityCache) {
      entityCache = new Map<string, Float32Array>();
    }

    const scored = candidateRows.map(row => {
      let vector = entityCache?.get(row.id) ?? parseEmbedding(row.embedding_blob, row.embedding);
      if (vector && canCache && entityCache && !entityCache.has(row.id)) {
        entityCache.set(row.id, vector);
      }
      let score = 0;
      if (vector && vector.length === queryVec.length) {
        const cosSim = cosineSimilarity(queryVec, vector);
        if (weight !== undefined) {
          // Clamp to [0,1] only for hybrid blending so the weighted sum stays
          // in a predictable range. Pure-semantic ranking preserves the full
          // [-1,1] cosine range so the least-dissimilar facts always rank above
          // unembedded rows (which score 0) even when all scores are negative.
          const kwScore = miniSearchScores?.get(row.id) ?? 0;
          score = weight * Math.max(0, cosSim) + (1 - weight) * kwScore;
        } else {
          score = cosSim;
        }
      } else if (weight !== undefined && weight < 1) {
        // No usable embedding — still apply the keyword portion of the hybrid score.
        const kwScore = miniSearchScores?.get(row.id) ?? 0;
        score = (1 - weight) * kwScore;
      } else {
        // Pure-semantic path with no usable vector. Use -2 (below the minimum
        // valid cosine of -1) so embedded facts always rank above unembedded rows
        // even when every cosine score is negative.
        score = -2;
      }
      return { id: row.id, score, updated_at: row.updated_at, access_count: row.access_count };
    });

    if (canCache && entityCache && entityCache.size > 0) {
      if (!this.vectorCache.has(entityId)) {
        // Evict the oldest entity when at the per-process cap to prevent unbounded growth
        // on long-lived instances serving many distinct entities.
        if (this.vectorCache.size >= WikiMemory.MAX_VECTOR_CACHE_ENTITIES) {
          const oldestKey = this.vectorCache.keys().next().value as string | undefined;
          if (oldestKey !== undefined) this.vectorCache.delete(oldestKey);
        }
        this.vectorCache.set(entityId, entityCache);
      }
    }

    // Apply tie-break sorting to the scored results and return only the top `limit` items.
    this._tieBreakSort(scored);

    return scored.slice(0, limit);
  }

  /**
   * Delegate semantic ranking to the injected VectorRanker.
   * Caller should pass an oversampledLimit to preserve recall after re-ranking.
   * Returns scored results ready for hybrid blending and tie-break sorting.
   */
  private async _rankWithVectorRanker(args: {
    entityId: string;
    queryVec: Float32Array | number[];
    candidateIds: readonly string[] | undefined;
    weight: number | undefined;
    miniSearchScores: Map<string, number> | undefined;
    limit: number;
  }): Promise<Array<{ id: string; score: number }>> {
    const { entityId, candidateIds, weight, miniSearchScores, limit } = args;

    const ranker = this.options.vectorRanker;
    if (!ranker) {
      throw new Error('vectorRanker not configured');
    }

    const queryVecCopy = args.queryVec instanceof Float32Array
      ? args.queryVec.slice()
      : Array.from(args.queryVec);

    const rankerResults = await ranker.rankBySimilarity({
      entityId,
      queryVec: queryVecCopy,
      candidateIds,
      limit,
    });

    // Normalize ranker output: filter to allowed ids, drop non-finite scores, deduplicate
    // Stop collecting once limit valid results are found to protect against huge result sets
    const allowedIds = candidateIds ? new Set(candidateIds) : undefined;
    const seen = new Set<string>();
    const normalized: typeof rankerResults = [];

    for (const r of rankerResults) {
      if (normalized.length >= limit) break; // Early termination once limit reached
      if (seen.has(r.id)) continue;
      if (allowedIds && !allowedIds.has(r.id)) continue;
      if (!Number.isFinite(r.semanticScore)) continue;
      seen.add(r.id);
      normalized.push(r);
    }

    // Convert ranker results to scored format, applying hybrid blending if weight is set
    const scored = normalized.map(r => {
      let score = r.semanticScore;
      if (weight !== undefined) {
        // Hybrid blending: floor semantic score at 0 for predictable weighted sum (no upper clamp)
        const kwScore = miniSearchScores?.get(r.id) ?? 0;
        score = weight * Math.max(0, r.semanticScore) + (1 - weight) * kwScore;
      }
      return { id: r.id, score };
    });

    // Caller handles backfill, metadata attachment, tie-break sorting, and final slice
    return scored;
  }

  async getMemoryBundle(entityId: string): Promise<MemoryBundle> {
    return this._getFullBundle(entityId, { maxEvents: 10 });
  }

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
    const id = generateId('evt_');
    const now = Date.now();
    
    let eventType = event.event_type;
    if (!['observation', 'decision', 'action', 'outcome'].includes(eventType)) {
      eventType = 'observation';
    }

    await this.db.runAsync(`
      INSERT INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, entityId, eventType, event.summary, event.related_entry_id || null, now]);

    const threshold = this.options.config?.autoLibrarianThreshold || 20;
    
    const [row, cp] = await Promise.all([
        this.db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM ${this.prefix}events WHERE entity_id = ?`, [entityId]),
        this.db.getFirstAsync<WikiCheckpoint>(`SELECT * FROM ${this.prefix}checkpoints WHERE entity_id = ?`, [entityId])
    ]);
    
    const count = row?.count || 0;
    let memoryCheckpoint = cp?.memory_checkpoint || 0;
    if (memoryCheckpoint > count) memoryCheckpoint = 0;

    if (count - memoryCheckpoint >= threshold) {
      const jobKey = this._librarianKey(entityId);
      if (
        !this.activeMaintenanceJobs.has(jobKey) &&
        !this.activeMaintenanceJobs.has(this._pruneKey(entityId)) &&
        !this._isReembedActive(entityId) &&
        !this._isImportActiveFor(entityId) &&
        !this._isForgetActiveFor(entityId)
      ) {
        this.activeMaintenanceJobs.add(jobKey);
        this.runLibrarianThenMaybeHeal(entityId, count)
          .catch(console.error)
          .finally(() => this.activeMaintenanceJobs.delete(jobKey));
      }
    }
  }

  private async runLibrarianThenMaybeHeal(entityId: string, currentEventCount: number) {
    await this._doRunLibrarian(entityId);
    
    await this.db.runAsync(`
      INSERT INTO ${this.prefix}checkpoints (entity_id, memory_checkpoint) 
      VALUES (?, ?) 
      ON CONFLICT(entity_id) DO UPDATE SET memory_checkpoint = ?
    `, [entityId, currentEventCount, currentEventCount]);
    
    const autoHealThreshold = this.options.config?.autoHealThreshold || 100;
    const cp = await this.db.getFirstAsync<WikiCheckpoint>(`SELECT * FROM ${this.prefix}checkpoints WHERE entity_id = ?`, [entityId]);
    let healCheckpoint = cp?.heal_checkpoint || 0;
    if (healCheckpoint > currentEventCount) healCheckpoint = 0;
    
    if (currentEventCount - healCheckpoint >= autoHealThreshold) {
      const healKey = this._healKey(entityId);
      if (!this.activeMaintenanceJobs.has(healKey)) {
        this.activeMaintenanceJobs.add(healKey);
        try {
          await this._doRunHeal(entityId);
          await this.db.runAsync(`
            INSERT INTO ${this.prefix}checkpoints (entity_id, heal_checkpoint) 
            VALUES (?, ?) 
            ON CONFLICT(entity_id) DO UPDATE SET heal_checkpoint = ?
          `, [entityId, currentEventCount, currentEventCount]);
        } finally {
          this.activeMaintenanceJobs.delete(healKey);
        }
      }
    }
  }

  private async _doRunLibrarian(entityId: string): Promise<void> {
    const events = await this.db.getAllAsync<WikiEvent>(`
      SELECT * FROM ${this.prefix}events
      WHERE entity_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [entityId]);

    const currentFactsRows = await this.db.getAllAsync<WikiFact>(`
      SELECT * FROM ${this.prefix}entries
      WHERE entity_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 100
    `, [entityId]);

    const currentFacts = currentFactsRows.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return {
        ...rest,
        tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
      };
    });

    const userPrompt = `Events:\n${JSON.stringify(events.reverse(), null, 2)}\n\nCurrent Facts:\n${JSON.stringify(currentFacts, null, 2)}`;
    
    const responseText = await this.options.llmProvider.generateText({
      systemPrompt: LIBRARIAN_SYSTEM_PROMPT,
      userPrompt,
    });

    const result = parseJsonResponse<{ facts: ExtractedFact[], tasks: ExtractedTask[] }>(responseText);
    const facts = Array.isArray(result.facts) ? result.facts : [];
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    const validFacts = facts.map(validateFact).filter((f): f is ExtractedFact => f !== null);
    const validTasks = tasks.map(validateTask).filter((t): t is ExtractedTask => t !== null);

    const now = Date.now();

    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async () => {
      for (const fact of validFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;
        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of currentFactsRows) {
            if (existing.source_type !== 'librarian_inferred') continue;
            const existingTokens = titleTokens(existing.title);
            if (existingTokens.size >= MIN_TOKENS_TO_QUALIFY) {
              if (jaccardScore(newTokens, existingTokens) >= FUZZY_THRESHOLD) {
                skip = true;
                break;
              }
            }
          }
        }
        if (skip) continue;

        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'librarian_inferred', now, now]);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });

    // Rebuild the text index before the (potentially slow) embedding loop so
    // concurrent reads using MiniSearch (preFilter, keyword fallback) see the
    // new fact content immediately after the DB transaction commits.
    await this.rebuildMiniSearchIndex(entityId);
    this.vectorCache.delete(entityId);
    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    // Second vector cache flush: a concurrent read() may have repopulated it
    // during the embed loop; flush so subsequent reads see the new BLOBs.
    this.vectorCache.delete(entityId);
  }

  private async _doRunHeal(entityId: string): Promise<void> {
    const now = Date.now();
    const orphanAfterDays = this.options.config?.orphanAfterDays !== undefined ? this.options.config.orphanAfterDays : 30;
    const staleInferredAfterDays = this.options.config?.staleInferredAfterDays !== undefined ? this.options.config.staleInferredAfterDays : 60;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    if (orphanAfterDays !== null && (typeof orphanAfterDays !== 'number' || !Number.isFinite(orphanAfterDays) || orphanAfterDays < 0)) {
      throw new Error('Invalid orphanAfterDays: must be a finite number >= 0 or null');
    }
    if (staleInferredAfterDays !== null && (typeof staleInferredAfterDays !== 'number' || !Number.isFinite(staleInferredAfterDays) || staleInferredAfterDays < 0)) {
      throw new Error('Invalid staleInferredAfterDays: must be a finite number >= 0 or null');
    }

    await this.db.withTransactionAsync(async () => {
      if (orphanAfterDays !== null) {
        const orphanThreshold = now - (orphanAfterDays * MS_PER_DAY);
        await this.db.runAsync(`
          UPDATE ${this.prefix}entries
          SET deleted_at = ?, updated_at = ?
          WHERE entity_id = ? AND access_count = 0 AND created_at <= ? AND source_type != 'immutable_document' AND deleted_at IS NULL
        `, [now, now, entityId, orphanThreshold]);
      }

      if (staleInferredAfterDays !== null) {
        const staleThreshold = now - (staleInferredAfterDays * MS_PER_DAY);
        await this.db.runAsync(`
          UPDATE ${this.prefix}entries
          SET confidence = 'tentative', updated_at = ?
          WHERE entity_id = ? AND confidence = 'inferred' AND (last_accessed_at <= ? OR (last_accessed_at IS NULL AND created_at <= ?)) AND source_type != 'immutable_document' AND deleted_at IS NULL
        `, [now, entityId, staleThreshold, staleThreshold]);
      }
    });

    const allFactsRows = await this.db.getAllAsync<WikiFact>(`SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`, [entityId]);
    const allTasks = await this.db.getAllAsync<WikiTask>(`SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL`, [entityId]);
    const recentEvents = await this.db.getAllAsync<WikiEvent>(`SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 20`, [entityId]);

    const healCandidates = allFactsRows.filter(f => f.source_type !== 'immutable_document');
    const documentAnchors = allFactsRows
      .filter(f => f.source_type === 'immutable_document')
      .map(({ id, title, source_ref }) => ({ id, title, source_ref }));

    const userPrompt = `Heal Candidates:\n${JSON.stringify(healCandidates.map(f => {
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return { ...rest, tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags };
    }), null, 2)}
\nDocument Anchors (DO NOT MODIFY OR DELETE):\n${JSON.stringify(documentAnchors, null, 2)}
\nAll Tasks:\n${JSON.stringify(allTasks, null, 2)}
\nRecent Events:\n${JSON.stringify(recentEvents, null, 2)}
\nThe following document anchors are provided for contradiction detection only. Do not include them in \`downgraded\`, \`deleted\`, or \`newFacts\`.`;
    
    const responseText = await this.options.llmProvider.generateText({
      systemPrompt: HEAL_SYSTEM_PROMPT,
      userPrompt,
    });

    const result = parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts: ExtractedFact[] }>(responseText);

    const mutableIds = new Set(healCandidates.map(f => f.id));
    const downgraded = Array.isArray(result.downgraded) ? result.downgraded : [];
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    const newFacts = Array.isArray(result.newFacts) ? result.newFacts : [];
    const safeDowngraded = downgraded.filter(id => mutableIds.has(id));
    const safeDeleted = deleted.filter(id => mutableIds.has(id));
    const validNewFacts = newFacts.map(validateFact).filter((f): f is ExtractedFact => f !== null);

    const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
    const uniqueDeletedFactIds = Array.from(new Set(safeDeleted));

    await this.db.withTransactionAsync(async () => {
      for (const id of safeDowngraded) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET confidence = 'tentative', updated_at = ? WHERE id = ? AND entity_id = ?`, [now, id, entityId]);
      }
      for (const id of safeDeleted) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ?`, [now, now, id, entityId]);
      }
      for (const fact of validNewFacts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'librarian_inferred', now, now]);
        insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }
    });

    // Pre-flush: evict stale cached vectors before writing new embeddings so a
    // concurrent read() during the embed loop doesn't rank deleted/downgraded
    // facts from the cache. Post-flush below handles vectors repopulated during
    // the loop.
    this.vectorCache.delete(entityId);
    // Rebuild MiniSearch before the embedding loop so concurrent reads using
    // preFilterLimit, hybrid scoring, or keyword fallback see the new/deleted
    // facts immediately rather than waiting for every embed call to finish.
    await this.rebuildMiniSearchIndex(entityId);
    for (const factId of uniqueDeletedFactIds) {
      try {
        await this._notifyEmbeddingPersisted(entityId, factId, null);
      } catch (hookErr) {
        console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during heal for ${factId}:`, hookErr);
      }
    }
    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    // Post-flush: evict any cache entries a concurrent read() repopulated while
    // the embedding loop was running.
    this.vectorCache.delete(entityId);
  }

  async runLibrarian(entityId: string): Promise<void> {
    const jobKey = this._librarianKey(entityId);
    if (this.activeMaintenanceJobs.has(jobKey)) {
      throw new WikiBusyError('librarian', entityId);
    }
    if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
      throw new WikiBusyError('prune', entityId);
    }
    if (this._isReembedActive(entityId)) {
      throw new WikiBusyError('reembed', entityId);
    }
    if (this._isImportActiveFor(entityId)) {
      throw new WikiBusyError('import', entityId);
    }
    if (this._isForgetActiveFor(entityId)) {
      throw new WikiBusyError('forget', entityId);
    }
    this.activeMaintenanceJobs.add(jobKey);
    try {
      await this._doRunLibrarian(entityId);
    } finally {
      this.activeMaintenanceJobs.delete(jobKey);
    }
  }

  async runHeal(entityId: string): Promise<void> {
    const jobKey = this._healKey(entityId);
    if (this.activeMaintenanceJobs.has(jobKey)) {
      throw new WikiBusyError('heal', entityId);
    }
    if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
      throw new WikiBusyError('prune', entityId);
    }
    if (this._isReembedActive(entityId)) {
      throw new WikiBusyError('reembed', entityId);
    }
    if (this._isImportActiveFor(entityId)) {
      throw new WikiBusyError('import', entityId);
    }
    if (this._isForgetActiveFor(entityId)) {
      throw new WikiBusyError('forget', entityId);
    }
    this.activeMaintenanceJobs.add(jobKey);
    try {
      await this._doRunHeal(entityId);
    } finally {
      this.activeMaintenanceJobs.delete(jobKey);
    }
  }

  async runReembed(entityId?: string, opts?: { force?: boolean; skipExisting?: boolean }): Promise<{ embedded: number; skipped: number; failed: number }> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return { embedded: 0, skipped: 0, failed: 0 };

    const reembedKey = entityId ? this._reembedKey(entityId) : this._globalReembedKey();
    if (this.activeMaintenanceJobs.has(reembedKey)) {
      throw new WikiBusyError('reembed', entityId ?? '*');
    }
    if (entityId) {
      // Cross-check: fail if global reembed is in-flight (it covers this entity too)
      if (this.activeMaintenanceJobs.has(this._globalReembedKey())) {
        throw new WikiBusyError('reembed', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
        throw new WikiBusyError('prune', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) {
        throw new WikiBusyError('librarian', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._healKey(entityId))) {
        throw new WikiBusyError('heal', entityId);
      }
      if (this._isIngestActiveFor(entityId)) {
        throw new WikiBusyError('ingest', entityId);
      }
      if (this._isImportActiveFor(entityId)) {
        throw new WikiBusyError('import', entityId);
      }
      if (this._isForgetActiveFor(entityId)) {
        throw new WikiBusyError('forget', entityId);
      }
    } else {
      // Cross-check: fail if any per-entity reembed is in-flight (global covers all entities)
      if (this._isAnyMaintenanceActiveWithSuffix(':reembed')) {
        throw new WikiBusyError('reembed', '*');
      }
      if (this._isAnyMaintenanceActiveWithSuffix(':prune')) {
        throw new WikiBusyError('prune', '*');
      }
      if (this._isAnyMaintenanceActiveWithSuffix(':librarian')) {
        throw new WikiBusyError('librarian', '*');
      }
      if (this._isAnyMaintenanceActiveWithSuffix(':heal')) {
        throw new WikiBusyError('heal', '*');
      }
      if (this.activeIngestJobs.size > 0) {
        throw new WikiBusyError('ingest', '*');
      }
      if (this._isAnyMaintenanceActiveWithSuffix(':import')) {
        throw new WikiBusyError('import', '*');
      }
      if (this._isAnyMaintenanceActiveWithSuffix(':forget')) {
        throw new WikiBusyError('forget', '*');
      }
    }
    this.activeMaintenanceJobs.add(reembedKey);

    try {
      const where = entityId ? `entity_id = ? AND deleted_at IS NULL` : `deleted_at IS NULL`;
      const params = entityId ? [entityId] : [];
      const rows = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE ${where}`,
        params
      );

      // Invalidate before the embedding loop so any concurrent read() fetches fresh
      // vectors from the database rather than stale pre-reembed cached ones.
      if (entityId) {
        this.vectorCache.delete(entityId);
      } else {
        this.vectorCache.clear();
      }

      // skipExisting is an explicit opt-in for round-trip import scenarios where
      // the caller knows every blob is already fresh and wants to avoid paying the
      // full embedding cost again (e.g. after exportDump → importDump on the same
      // model). By default runReembed() re-embeds every selected fact so that a
      // model switch always works correctly — a dimension-only probe cannot detect
      // same-dimension provider changes, so unconditional re-embedding is the only
      // safe default.
      // { force: true } is kept as a no-op alias so existing call sites that pass
      // it explicitly continue to work without change.
      // skipExisting skips facts that already have a structurally valid BLOB.
      // WARNING: this is only safe when the caller can guarantee the stored BLOBs
      // were produced by the *same* embedding model that is currently configured.
      // It cannot detect same-dimension model/provider switches (e.g. two providers
      // that both produce 1536-dim vectors). After any provider change, always call
      // runReembed() without { skipExisting: true } to force full re-embedding.
      const skipExisting = opts?.skipExisting ?? false;
      // Never skip when a dimension mismatch is pending: blobs on disk are stale
      // regardless of what the caller requested.
      // For per-entity reembed, only disable skipExisting when THIS entity actually
      // has stale blobs — the global mismatch flag may reflect a different entity's
      // state and should not force unnecessary re-embedding of entity A's valid blobs.
      let effectiveSkip = skipExisting;
      if (skipExisting) {
        const mismatchRow = await this.db.getFirstAsync<{ value: string }>(
          `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
        );
        if (mismatchRow) {
          if (entityId) {
            // Per-entity: check whether this entity has any blobs at the wrong dimension
            // (i.e., the old canonical dim, not the pending new mismatch dim) or TEXT-only rows.
            const mismatchDim = parseInt(mismatchRow.value, 10);
            const staleForEntity = await this.db.getFirstAsync<{ cnt: number }>(
              `SELECT COUNT(*) AS cnt FROM ${this.prefix}entries
               WHERE entity_id = ? AND deleted_at IS NULL
                 AND (
                   embedding_blob IS NULL
                   OR (CAST(length(embedding_blob) AS INTEGER) / 4) != ?
                 )`,
              [entityId, mismatchDim]
            );
            if (staleForEntity && staleForEntity.cnt > 0) effectiveSkip = false;
          } else {
            // Global reembed: any pending mismatch means blobs are stale somewhere.
            effectiveSkip = false;
          }
        }
      }
      let embedded = 0;
      let skipped = 0;
      let failed = 0;
      try {
        for (const row of rows) {
          // Skip facts with existing BLOBs only when the caller opts in via
          // { skipExisting: true } AND no dimension mismatch is active.
          // The default always re-embeds, ensuring correctness after model switches.
          // Only skip if the BLOB is structurally valid (non-zero length, divisible
          // by 4) and contains entirely finite values. A BLOB full of NaN/Infinity
          // passes the byte-length check but would silently score 0 in read() —
          // let embedFact() repair it instead of leaving the fact permanently unsearchable.
          const existingBlob = (row as WikiFact & { embedding_blob?: Uint8Array | null }).embedding_blob;
          const blobIsValid = !!existingBlob && existingBlob.byteLength > 0 && existingBlob.byteLength % 4 === 0;
          if (effectiveSkip && blobIsValid) {
            const vec = parseEmbedding(existingBlob, null);
            if (vec !== null && vec.every(v => Number.isFinite(v))) {
              skipped++;
              continue;
            }
          }
          const success = await this.embedFact(row);
          if (success) embedded++;
          else failed++;
        }
        // If any fact was successfully re-embedded, promote the pending dimension to
        // canonical and clear the mismatch flag so read() uses embeddings from here on.
        if (embedded > 0) {
          await this._reconcileEmbeddingDimension();
        }
      } finally {
        // Invalidate again after the loop: a concurrent read() might have re-populated
        // the cache with pre-reembed vectors while the loop was running, so flush any
        // such stale entries to ensure subsequent reads see the freshly written data,
        // even if the loop or dimension reconciliation threw.
        if (entityId) {
          this.vectorCache.delete(entityId);
        } else {
          this.vectorCache.clear();
        }
      }

      return { embedded, skipped, failed };
    } finally {
      this.activeMaintenanceJobs.delete(reembedKey);
    }
  }

  getEntityStatus(entityId: string): EntityStatus {
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    let ingesting = false;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) { ingesting = true; break; }
    }

    return {
      ingesting,
      librarian: this.activeMaintenanceJobs.has(this._librarianKey(entityId)),
      heal: this.activeMaintenanceJobs.has(this._healKey(entityId)),
    };
  }

  public clearVectorCache(): void {
    this.vectorCache.clear();
  }

  private async _getFullBundle(entityId: string, opts?: { maxEvents?: number; includeBlobs?: boolean }): Promise<MemoryBundle> {
    const maxEvents = opts?.maxEvents;
    const eventsQuery = maxEvents != null
      ? `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at ASC`;
    const eventsParams: (string | number)[] = maxEvents != null ? [entityId, maxEvents] : [entityId];

    const [factsRaw, tasks, eventsRaw] = await Promise.all([
      this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiTask>(
        `SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiEvent>(eventsQuery, eventsParams),
    ]);
    const facts = factsRaw.map(f => {
      // Always strip the legacy text embedding column — never useful to callers.
      const { embedding: _embedding, embedding_blob, ...rest } =
        f as WikiFact & { embedding?: unknown; embedding_blob?: Uint8Array };
      // Include the BLOB only on the export path so importDump() can round-trip
      // embeddings without re-calling the embed provider. Strip it on the LLM
      // prompt / formatMemoryDump paths to keep payloads small.
      // Copy blob bytes before returning: some SQLite drivers (better-sqlite3)
      // back Buffer objects with pooled native memory that can be reused by a
      // subsequent query, silently corrupting the already-returned MemoryDump.
      const safeBlobCopy = opts?.includeBlobs && embedding_blob
        ? (() => { const c = new ArrayBuffer(embedding_blob.byteLength); new Uint8Array(c).set(embedding_blob); return new Uint8Array(c); })()
        : undefined;
      const factBase = safeBlobCopy
        ? { ...rest, embedding_blob: safeBlobCopy }
        : rest;
      return {
        ...factBase,
        tags: typeof factBase.tags === 'string' ? JSON.parse(factBase.tags) : factBase.tags,
      };
    });
    // When limited, results arrive newest-first; reverse to chronological order.
    const events = maxEvents != null ? eventsRaw.slice().reverse() : eventsRaw;
    return { facts, tasks, events };
  }

  async exportDump(entityIds?: string[]): Promise<MemoryDump> {
    let ids: string[];
    if (entityIds && entityIds.length > 0) {
      ids = Array.from(new Set(entityIds));
    } else {
      // Collect all distinct entity_ids across entries, tasks, events
      const rows = await this.db.getAllAsync<{ entity_id: string }>(`
        SELECT DISTINCT entity_id FROM (
          SELECT entity_id FROM ${this.prefix}entries WHERE deleted_at IS NULL
          UNION
          SELECT entity_id FROM ${this.prefix}tasks WHERE deleted_at IS NULL
          UNION
          SELECT entity_id FROM ${this.prefix}events
        ) ORDER BY entity_id
      `);
      ids = rows.map(r => r.entity_id);
    }

    const entities: Record<string, MemoryBundle> = {};
    const BATCH = 3;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(async (id): Promise<[string, MemoryBundle]> => [id, await this._getFullBundle(id, { includeBlobs: true })])
      );
      for (const [id, bundle] of batchResults) {
        entities[id] = bundle;
      }
    }

    return { generatedAt: Date.now(), entities };
  }

  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    const merge = opts?.merge ?? false;
    const entityIds = Object.keys(dump.entities);

    // Pre-validate all locks before writing anything. This makes the operation
    // atomic with respect to busy-error rejection: either every entity passes the
    // lock check and we proceed, or we reject before mutating any entity.
    // Per-entity checks first: surface the specific conflicting entity in the error.
    for (const entityId of entityIds) {
      if (this.activeMaintenanceJobs.has(this._importKey(entityId))) {
        throw new WikiBusyError('import', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) {
        throw new WikiBusyError('librarian', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._healKey(entityId))) {
        throw new WikiBusyError('heal', entityId);
      }
      if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
        throw new WikiBusyError('prune', entityId);
      }
      if (this._isReembedActive(entityId)) {
        throw new WikiBusyError('reembed', entityId);
      }
      if (this._isIngestActiveFor(entityId)) {
        throw new WikiBusyError('ingest', entityId);
      }
      if (this._isForgetActiveFor(entityId)) {
        throw new WikiBusyError('forget', entityId);
      }
    }
    // Global import lock check after per-entity checks: serializes concurrent
    // importDump() calls for *different* entities so they cannot race on the shared
    // embedding_dimension / embedding_dimension_mismatch meta keys.
    if (this.activeMaintenanceJobs.has(this._globalImportKey())) {
      throw new WikiBusyError('import', '*');
    }

    // Acquire global + per-entity import locks before any await so the lock check and
    // lock acquisition remain race-free across concurrent importDump() calls.
    this.activeMaintenanceJobs.add(this._globalImportKey());
    for (const entityId of entityIds) {
      this.activeMaintenanceJobs.add(this._importKey(entityId));
    }
    try {
      // Fail before any writes so we never partially commit an import and then reject
      // with a migration error — same probe as setup().
      await this.assertNoLegacySourceTypes();

      for (const [entityId, bundle] of Object.entries(dump.entities)) {
        await this._doImportEntity(entityId, bundle, merge);
      }
    } finally {
      this.activeMaintenanceJobs.delete(this._globalImportKey());
      for (const entityId of entityIds) {
        this.activeMaintenanceJobs.delete(this._importKey(entityId));
      }
    }
  }

  private async _doImportEntity(entityId: string, bundle: MemoryBundle, merge: boolean): Promise<void> {
      // Track which fact IDs were actually inserted/updated inside the transaction.
      // Skipped rows (cross-entity collisions or merge LWW losers) must not be
      // re-embedded — doing so would corrupt the winning row's vector with the
      // losing fact's title/body.
      const upsertedFactIds = new Set<string>();
      // Track upserted facts whose incoming row is soft-deleted. In replace mode,
      // these IDs still need vector=null notifications because they remain deleted.
      const upsertedDeletedFactIds = new Set<string>();
      // Track which upserted facts already carry a valid BLOB so we can skip
      // embedFact() for them. BLOBs are reconstructed from three serialization
      // forms: in-memory Uint8Array/Buffer, Node.js Buffer JSON shape, and
      // numeric-keyed plain objects produced by JSON.stringify(Uint8Array).
      // Store the blob data so we can notify the external vector index after the transaction.
      const factsWithPreservedBlob = new Map<string, Uint8Array>();
      // Track every unique dimension seen in preserved BLOBs. A dump may contain
      // blobs from multiple models (e.g. an intermediate mixed-model migration),
      // so we call storeEmbeddingDimension() for each unique dimension found to
      // ensure the mismatch flag is set whenever any two stored blobs disagree.
      const preservedBlobDims = new Set<number>();
      // In replace mode, collect IDs of facts that will be soft-deleted so we can
      // notify the external vector index with vector=null after the transaction.
      // Without this, external indexes retain stale embeddings and keep returning
      // deleted fact IDs in ranking results.
      const softDeletedFactIds: string[] = [];
      await this.db.withTransactionAsync(async () => {
        if (!merge) {
          // Collect IDs of live facts that will be soft-deleted
          const toDelete = await this.db.getAllAsync<{ id: string }>(
            `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
            [entityId]
          );
          softDeletedFactIds.push(...toDelete.map(r => r.id));
          const now = Date.now();
          await this.db.runAsync(
            `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`,
            [now, now, entityId]
          );
          await this.db.runAsync(
            `UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`,
            [now, now, entityId]
          );
          await this.db.runAsync(
            `DELETE FROM ${this.prefix}checkpoints WHERE entity_id = ?`,
            [entityId]
          );
        }

        const factIds = bundle.facts.map((fact) => fact.id);
        const existingFactsById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
        const factLookupChunkSize = 500;
        for (let i = 0; i < factIds.length; i += factLookupChunkSize) {
          const factIdChunk = factIds.slice(i, i + factLookupChunkSize);
          if (factIdChunk.length === 0) continue;
          const placeholders = factIdChunk.map(() => '?').join(', ');
          const existingFacts = await this.db.getAllAsync<{ id: string; entity_id: string; updated_at: number }>(
            `SELECT id, entity_id, updated_at FROM ${this.prefix}entries WHERE id IN (${placeholders})`,
            factIdChunk
          );
          for (const existingFact of existingFacts) {
            existingFactsById.set(existingFact.id, existingFact);
          }
        }

        for (const fact of bundle.facts) {
          const sourceType = this._normalizeImportedSourceType(String(fact.source_type), {
            entityId,
            factId: fact.id,
          });
          const tagsJson = JSON.stringify(Array.isArray(fact.tags) ? fact.tags : []);
          // Normalize once: non-finite (undefined/null/NaN) → 0 so we never persist an
          // invalid value to the DB and ORDER BY updated_at remains meaningful.
          const safeUpdatedAt = Number.isFinite(fact.updated_at) ? fact.updated_at : 0;
          const existing = existingFactsById.get(fact.id);

          // Extract a valid BLOB from the incoming fact.
          // Three serialization forms are normalised to Uint8Array:
          //   1. Real Uint8Array / Buffer (in-memory dump)
          //   2. Node.js Buffer JSON shape { type:'Buffer', data:[...] }
          //      (produced by JSON.stringify(buffer))
          //   3. Numeric-keyed plain object {0:byte, 1:byte, ...}
          //      (produced by JSON.stringify(Uint8Array))
          const rawBlobRaw = (fact as WikiFact & { embedding_blob?: unknown }).embedding_blob;
          let rawBlob: Uint8Array | null = null;
          if (rawBlobRaw instanceof Uint8Array) {
            rawBlob = rawBlobRaw;
          } else if (
            rawBlobRaw !== null &&
            rawBlobRaw !== undefined &&
            typeof rawBlobRaw === 'object'
          ) {
            const obj = rawBlobRaw as Record<string, unknown>;
            if (obj['type'] === 'Buffer' && Array.isArray(obj['data'])) {
              // Node.js Buffer serialized via JSON.stringify(buffer)
              rawBlob = new Uint8Array(obj['data'] as number[]);
            } else if (!Array.isArray(rawBlobRaw)) {
              // Numeric-keyed plain object from JSON.stringify(Uint8Array)
              const entries = Object.keys(obj);
              if (entries.length > 0 && entries.every(k => /^\d+$/.test(k))) {
                const len = entries.length;
                rawBlob = new Uint8Array(len);
                for (let i = 0; i < len; i++) rawBlob[i] = (obj[String(i)] as number) ?? 0;
              }
            }
          }
          let blobData: Uint8Array | null = null;
          if (
            rawBlob !== null &&
            rawBlob.byteLength > 0 &&
            rawBlob.byteLength % 4 === 0
          ) {
            // Also validate that every float32 value is finite: a blob with the right
            // byte length but NaN/Inf values would be preserved, skip embedFact(), and
            // then be silently dropped by read(), making the fact permanently unsearchable.
            // Copy into a fresh ArrayBuffer so the Float32Array view is guaranteed to
            // start at offset 0 of its own buffer. Buffer.slice(0) in Node.js does NOT
            // copy — it returns a view into the parent buffer, which can have a non-zero
            // byteOffset and corrupt the Float32Array interpretation.
            const copy = new ArrayBuffer(rawBlob.byteLength);
            const alignedBlob = new Uint8Array(copy);
            alignedBlob.set(rawBlob);
            const floats = new Float32Array(copy, 0, rawBlob.byteLength / 4);
            let allFinite = true;
            for (let i = 0; i < floats.length; i++) {
              if (!isFinite(floats[i])) { allFinite = false; break; }
            }
            if (allFinite) {
              // Preserve this blob regardless of its dimension. Mixed-dimension
              // blobs are a real intermediate state during model migration and
              // silently discarding valid vectors is worse than importing them;
              // storeEmbeddingDimension() and read()'s mismatch-check handle
              // the case where stored blobs disagree on size.
              // Note: same-dimension model changes (e.g. two different providers
              // that happen to produce 1536-dim vectors) are undetectable here —
              // there is no model fingerprint in the blob. Callers importing from
              // a different provider should call runReembed() after importDump()
              // rather than relying on { skipExisting: true }.
              // Store aligned copy (not rawBlob) to avoid Float32Array alignment errors in notification.
              blobData = alignedBlob;
            }
          }

          if (existing) {
            if (existing.entity_id !== entityId) {
              this._warnCrossEntityCollision('entry', fact.id, existing.entity_id, entityId);
              continue;
            }
            if (merge) {
              // LWW: incoming wins only if its updated_at is strictly newer than local.
              // 0 (epoch) never beats a real timestamp, so invalid incoming rows are skipped.
              if (safeUpdatedAt <= existing.updated_at) continue;
            }
            if (blobData != null) {
              // Incoming fact carries a valid BLOB (in-memory dump): persist it directly
              // and skip embedFact() — no embedding API call required.
              await this.db.runAsync(
                `UPDATE ${this.prefix}entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ?, embedding_blob = ?, embedding = NULL WHERE id = ?`,
                [entityId, fact.title, fact.body, tagsJson, fact.confidence, sourceType, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at, blobData, fact.id]
              );
              factsWithPreservedBlob.set(fact.id, blobData);
              // Only track dimensions for live facts: read() and _reconcileEmbeddingDimension()
              // both filter by deleted_at IS NULL, so a soft-deleted stale blob must not
              // set embedding_dimension_mismatch and block retrieval on healthy live facts.
              if (!fact.deleted_at) preservedBlobDims.add(blobData.byteLength / 4);
            } else {
              // read() never ranks the new title/body against the old vector;
              // the post-transaction embedding loop will re-embed.
              // If embedFact() fails (provider absent or throws), the NULL vector
              // remains, which is correct: new content with no valid embedding
              // falls back to keyword-only retrieval.
              await this.db.runAsync(
                `UPDATE ${this.prefix}entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ?, embedding_blob = NULL, embedding = NULL WHERE id = ?`,
                [entityId, fact.title, fact.body, tagsJson, fact.confidence, sourceType, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at, fact.id]
              );
            }
            existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
            upsertedFactIds.add(fact.id);
            if (fact.deleted_at) upsertedDeletedFactIds.add(fact.id);
          } else {
            if (blobData != null) {
              await this.db.runAsync(
                `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [fact.id, entityId, fact.title, fact.body, tagsJson, fact.confidence, sourceType, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at, blobData]
              );
              factsWithPreservedBlob.set(fact.id, blobData);
              if (!fact.deleted_at) preservedBlobDims.add(blobData.byteLength / 4);
            } else {
              await this.db.runAsync(
                `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [fact.id, entityId, fact.title, fact.body, tagsJson, fact.confidence, sourceType, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at]
              );
            }
            existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
            upsertedFactIds.add(fact.id);
            if (fact.deleted_at) upsertedDeletedFactIds.add(fact.id);
          }
        }

        const taskIds = bundle.tasks.map((task) => task.id);
        const existingTasksById = new Map<string, { id: string; entity_id: string; updated_at: number }>();
        const taskLookupChunkSize = 500;

        for (let i = 0; i < taskIds.length; i += taskLookupChunkSize) {
          const taskIdChunk = taskIds.slice(i, i + taskLookupChunkSize);
          if (taskIdChunk.length === 0) continue;

          const placeholders = taskIdChunk.map(() => '?').join(', ');
          const existingTasks = await this.db.getAllAsync<{ id: string; entity_id: string; updated_at: number }>(
            `SELECT id, entity_id, updated_at FROM ${this.prefix}tasks WHERE id IN (${placeholders})`,
            taskIdChunk
          );

          for (const existingTask of existingTasks) {
            existingTasksById.set(existingTask.id, existingTask);
          }
        }

        for (const task of bundle.tasks) {
          // Normalize once: non-finite (undefined/null/NaN) → 0 so we never persist an
          // invalid value to the DB and ORDER BY updated_at remains meaningful.
          const safeUpdatedAt = Number.isFinite(task.updated_at) ? task.updated_at : 0;
          const existing = existingTasksById.get(task.id);
          if (existing) {
            if (existing.entity_id !== entityId) {
              this._warnCrossEntityCollision('task', task.id, existing.entity_id, entityId);
              continue;
            }
            if (merge) {
              // LWW: incoming wins only if its updated_at is strictly newer than local.
              // 0 (epoch) never beats a real timestamp, so invalid incoming rows are skipped.
              if (safeUpdatedAt <= existing.updated_at) continue;
            }
            // replace mode (or merge LWW winner): update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}tasks SET entity_id = ?, description = ?, status = ?, priority = ?, created_at = ?, updated_at = ?, resolved_at = ?, deleted_at = ? WHERE id = ?`,
              [entityId, task.description, task.status, task.priority, task.created_at, safeUpdatedAt, task.resolved_at, task.deleted_at, task.id]
            );
            existingTasksById.set(task.id, { id: task.id, entity_id: entityId, updated_at: safeUpdatedAt });
          } else {
            await this.db.runAsync(
              `INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [task.id, entityId, task.description, task.status, task.priority, task.created_at, safeUpdatedAt, task.resolved_at, task.deleted_at]
            );
            existingTasksById.set(task.id, { id: task.id, entity_id: entityId, updated_at: safeUpdatedAt });
          }
        }

        for (const event of bundle.events) {
          await this.db.runAsync(
            `INSERT OR IGNORE INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [event.id, entityId, event.event_type, event.summary, event.related_entry_id ?? null, event.created_at]
          );
        }
      });
      // Invalidate cache before rebuilding the text index so concurrent reads
      // see consistent data: all use the post-transaction DB state.
      this.vectorCache.delete(entityId);
      // Rebuild the MiniSearch index immediately after the transaction commits
      // so concurrent read() calls using preFilterLimit or hybrid scoring get
      // the updated text rather than waiting for the (potentially slow) embedding loop.
      await this.rebuildMiniSearchIndex(entityId);
      // Embed only facts that were actually inserted/updated in the transaction.
      // Skipped rows (cross-entity collisions or merge LWW losers) must not be
      // re-embedded — they were not written and their existing row must not be
      // overwritten with the incoming fact's content.
      // Facts with preserved BLOBs (from an in-memory dump) already have valid
      // embeddings; skip embedFact() for those to avoid redundant API calls.
      // For facts without a BLOB, the UPDATE/INSERT already left embedding_blob = NULL,
      // so if embedFact() fails here the row correctly has a NULL vector.
      for (const fact of bundle.facts) {
        if (!fact.deleted_at && upsertedFactIds.has(fact.id) && !factsWithPreservedBlob.has(fact.id)) {
          await this.embedFact({
            id: fact.id,
            entity_id: entityId,  // Use authoritative entityId from dump key, not fact.entity_id
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) || typeof fact.tags === 'string' ? fact.tags : [],
          });
        }
      }
      // Notify external vector index about preserved-blob facts.
      // These skipped embedFact(), so _notifyEmbeddingPersisted was never called.
      // Only notify for live facts (skip soft-deleted) to avoid polluting external index.
      for (const fact of bundle.facts) {
        const blobData = factsWithPreservedBlob.get(fact.id);
        if (blobData && !fact.deleted_at && upsertedFactIds.has(fact.id)) {
          try {
            const float32Vector = new Float32Array(blobData.buffer, blobData.byteOffset, blobData.byteLength / 4);
            await this._notifyEmbeddingPersisted(entityId, fact.id, float32Vector);
          } catch (hookErr) {
            console.warn(`[WikiMemory] onEmbeddingPersisted hook failed for preserved-blob fact ${fact.id}:`, hookErr);
          }
        }
      }
      // In replace mode, notify external vector index that soft-deleted facts should be removed.
      // Re-upserted facts are usually restores, except when the incoming row is still
      // soft-deleted (deleted_at set). Those must also receive vector=null.
      for (const factId of softDeletedFactIds) {
        if (!upsertedFactIds.has(factId) || upsertedDeletedFactIds.has(factId)) {
          try {
            await this._notifyEmbeddingPersisted(entityId, factId, null);
          } catch (hookErr) {
            console.warn(`[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for soft-deleted fact ${factId}:`, hookErr);
          }
        }
      }
      // If any facts carried preserved BLOBs, record the vector dimension in the
      // meta table now (embedFact() was skipped for those rows, so it didn't happen
      // automatically). This ensures read() can detect model-dimension mismatches
      // after importing into a fresh DB that has never seen an embedding.
      // However, if the preserved BLOBs have a *different* dimension than the
      // current canonical dimension, skip bookkeeping entirely. Calling
      // storeEmbeddingDimension() with the imported dimension would set
      // embedding_dimension_mismatch, which _reconcileEmbeddingDimension() would
      // interpret as the target dimension. After runReembed() rewrites everything
      // to the canonical dimension, the mismatch flag would never clear (all facts
      // now differ from the old imported dimension, so residual count > 0 forever).
      // Instead, let runReembed() reconcile all vectors without pre-seeding metadata.
      try {
        // Query the current canonical embedding dimension, if any.
        const canonicalRow = await this.db.getFirstAsync<{ value: string }>(
          `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension'`
        );
        const canonicalDim = canonicalRow ? parseInt(canonicalRow.value, 10) : null;

        if (preservedBlobDims.size === 1) {
          const preservedDim = [...preservedBlobDims][0];
          if (canonicalDim === null || canonicalDim === preservedDim) {
            // Fresh DB: record the imported dimension as canonical.
            // Matching canonical: storeEmbeddingDimension is a no-op for equal dims,
            // but a stale embedding_dimension_mismatch flag may still be present from
            // a previous import. Run reconciliation so the flag is cleared if all live
            // facts now agree on the canonical dimension.
            await this.storeEmbeddingDimension(preservedDim);
            // If a stale embedding_dimension_mismatch flag exists from a prior failed
            // model switch it may target a different dimension. _reconcileEmbeddingDimension()
            // checks residuals against whatever value the flag holds; a wrong value keeps
            // the flag stuck even though all imported blobs now match preservedDim.
            // Overwrite the flag to preservedDim before reconciling so the check is correct.
            const staleMismatch = await this.db.getFirstAsync<{ value: string }>(
              `SELECT value FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
            );
            if (staleMismatch && parseInt(staleMismatch.value, 10) !== preservedDim) {
              await this.db.runAsync(
                `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension_mismatch', ?)`,
                [String(preservedDim)]
              );
            }
            await this._reconcileEmbeddingDimension();
          } else {
            // Imported blobs differ from the canonical model dimension. Set
            // embedding_dimension_mismatch = canonicalDim so that:
            //   (a) read() detects the mismatch and falls back to MiniSearch, and
            //   (b) _reconcileEmbeddingDimension() can clear the flag after
            //       runReembed() rewrites all blobs to canonicalDim.
            // Using the imported dim as the mismatch value would deadlock:
            // after runReembed(), all blobs have canonicalDim ≠ importedDim, so
            // the residual count never reaches 0 and the flag is never cleared.
            await this.db.runAsync(
              `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension_mismatch', ?)`,
              [String(canonicalDim)]
            );
          }
        } else if (preservedBlobDims.size > 1) {
          if (canonicalDim === null) {
            // Fresh import with mixed BLOBs: seed canonical with the smallest imported
            // dimension, then write embedding_dimension_mismatch = that same canonical
            // value. Seeding mismatch = canonical (not dim[1]) ensures
            // _reconcileEmbeddingDimension() can always clear the flag:
            //   - If runReembed() uses the same dim as canonical: storeEmbeddingDimension
            //     is a no-op, mismatch stays = canonical, residual = 0 → clears. ✓
            //   - If runReembed() uses a different dim: storeEmbeddingDimension overwrites
            //     mismatch = currentDim, residual = 0 after full reembed → clears. ✓
            // Seeding mismatch = dim[1] instead would deadlock the second case: after
            // runReembed(), all blobs have currentDim ≠ dim[1] → residual > 0 forever.
            const sortedPreservedBlobDims = [...preservedBlobDims].sort((a, b) => a - b);
            await this.storeEmbeddingDimension(sortedPreservedBlobDims[0]);
            await this.db.runAsync(
              `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension_mismatch', ?)`,
              [String(sortedPreservedBlobDims[0])]
            );
          } else {
            // Import into an existing wiki with mixed-dimension blobs. Set
            // mismatch = canonicalDim so the flag clears correctly after runReembed()
            // rewrites everything to the canonical model.
            await this.db.runAsync(
              `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension_mismatch', ?)`,
              [String(canonicalDim)]
            );
          }
        }
      } finally {
        // Second flush: evict any cache entries a concurrent read() repopulated
        // from old DB vectors while the embedding loop was running. Runs even if
        // storeEmbeddingDimension() throws so stale entries cannot survive an error.
        this.vectorCache.delete(entityId);
      }
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
    let blockingOperation: "librarian" | "heal" | "prune" | "reembed" | "ingest" | "forget" | "import" | null = null;
    if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) {
      blockingOperation = 'librarian';
    } else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) {
      blockingOperation = 'heal';
    } else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
      blockingOperation = 'prune';
    } else if (this._isReembedActive(entityId)) {
      blockingOperation = 'reembed';
    } else if (this._isIngestActiveFor(entityId)) {
      blockingOperation = 'ingest';
    } else if (this._isImportActiveFor(entityId)) {
      blockingOperation = 'import';
    } else if (this._isForgetActiveFor(entityId)) {
      blockingOperation = 'forget';
    }
    if (blockingOperation !== null) {
      throw new WikiBusyError(blockingOperation, entityId);
    }
    const forgetKey = this._forgetKey(entityId);
    this.activeMaintenanceJobs.add(forgetKey);
    try {
      const now = Date.now();
      let deletedEntries = 0;
      let deletedTasks = 0;
      const deletedEntryIds: string[] = [];

      if (params.clearAll) {
        // Select both new deletions and already-soft-deleted (for hook retry on failure)
        const newDeletions = await this.db.getAllAsync<{ id: string }>(
          `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
          [entityId]
        );
        const alreadySoftDeleted = await this.db.getAllAsync<{ id: string }>(
          `SELECT id FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NOT NULL`,
          [entityId]
        );
        deletedEntryIds.push(...newDeletions.map(e => e.id), ...alreadySoftDeleted.map(e => e.id));

        const [entriesRes, tasksRes] = await Promise.all([
          this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`, [now, now, entityId]),
          this.db.runAsync(`UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`, [now, now, entityId]),
        ]);
        await this.db.runAsync(`UPDATE ${this.prefix}checkpoints SET memory_checkpoint = 0, heal_checkpoint = 0 WHERE entity_id = ?`, [entityId]);
        deletedEntries = entriesRes.changes;
        deletedTasks = tasksRes.changes;
      } else {
        const hasIdSelectors = params.entryId !== undefined || params.taskId !== undefined;
        const hasSourceSelectors = params.sourceRef !== undefined || params.sourceHash !== undefined;
        if (hasIdSelectors && hasSourceSelectors) {
          throw new Error('forget() params are mutually exclusive: use entryId/taskId together, or sourceRef/sourceHash together, but not both in the same call');
        }

        const sourceRef = params.sourceRef !== undefined ? normalizeSourceRef(params.sourceRef) : null;
        if (params.sourceRef !== undefined && !sourceRef) throw new Error('Invalid sourceRef');
        const sourceHash = params.sourceHash !== undefined ? normalizeSourceHash(params.sourceHash) : null;
        if (params.sourceHash !== undefined && !sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

        if (params.entryId) {
          // Select entry regardless of deleted_at to allow hook retry on already-soft-deleted rows
          const entry = await this.db.getFirstAsync<{ id: string }>(
            `SELECT id FROM ${this.prefix}entries WHERE id = ? AND entity_id = ?`,
            [params.entryId, entityId]
          );
          if (entry) deletedEntryIds.push(entry.id);
        }

        if (sourceRef || sourceHash) {
          // Select entries regardless of deleted_at to allow hook retry on already-soft-deleted rows
          let q = `SELECT id FROM ${this.prefix}entries WHERE entity_id = ?`;
          const args: any[] = [entityId];
          if (sourceRef) {
            q += ` AND source_ref = ?`;
            args.push(sourceRef);
          }
          if (sourceHash) {
            q += ` AND source_hash = ?`;
            args.push(sourceHash);
          }
          const entriesToDelete = await this.db.getAllAsync<{ id: string }>(q, args);
          deletedEntryIds.push(...entriesToDelete.map(e => e.id));
        }

        const entryPromise = params.entryId
          ? this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`, [now, now, params.entryId, entityId])
          : null;

        const taskPromise = params.taskId
          ? this.db.runAsync(`UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`, [now, now, params.taskId, entityId])
          : null;

        let refPromise: Promise<{ changes: number; lastInsertRowId: number }> | null = null;
        if (sourceRef || sourceHash) {
          let q = `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL`;
          const args: any[] = [now, now, entityId];
          if (sourceRef) {
            q += ` AND source_ref = ?`;
            args.push(sourceRef);
          }
          if (sourceHash) {
            q += ` AND source_hash = ?`;
            args.push(sourceHash);
          }
          refPromise = this.db.runAsync(q, args);
        }

        const [entryResult, taskResult, refResult] = await Promise.all([
          entryPromise ?? Promise.resolve(null),
          taskPromise ?? Promise.resolve(null),
          refPromise ?? Promise.resolve(null),
        ]);

        if (entryResult) deletedEntries += entryResult.changes;
        if (taskResult) deletedTasks += taskResult.changes;
        if (refResult) deletedEntries += refResult.changes;
      }

      await this.rebuildMiniSearchIndex(entityId);
      this.vectorCache.delete(entityId);

      // Deduplicate to avoid redundant hook calls for the same fact
      const uniqueDeletedIds = Array.from(new Set(deletedEntryIds));
      for (const factId of uniqueDeletedIds) {
        try {
          await this._notifyEmbeddingPersistedOrThrow(entityId, factId, null);
        } catch (hookErr) {
          // Preserve timeout errors (thrown by WikiMemory, not the ranker)
          const isTimeout = (hookErr as any)?.[HOOK_TIMEOUT_MARKER] === true;
          if (isTimeout) {
            throw new Error(
              `forget(${entityId}/${factId}) failed: ${(hookErr as Error).message}`,
            );
          }
          // Preserve WikiMemory validation errors (not from the adapter hook)
          const errMsg = (hookErr as Error)?.message ?? '';
          const isValidationError = errMsg.startsWith('Invalid deletionHookTimeoutMs');
          if (isValidationError) {
            throw new Error(
              `forget(${entityId}/${factId}) failed: ${errMsg}`,
              { cause: hookErr },
            );
          }
          // Actual hook rejection - sanitize error details
          throw new Error(
            `forget(${entityId}/${factId}) failed: ANN cleanup hook rejected`,
            { cause: this._sanitizeRankerError(hookErr) },
          );
        }
      }

      return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
    } finally {
      this.activeMaintenanceJobs.delete(forgetKey);
    }
  }

  async ingestDocument(entityId: string, params: { sourceRef: string; sourceHash: string; documentChunk: string; maxChunkLength?: number; chunkOverlap?: number; chunkConcurrency?: number }): Promise<{ truncated: boolean; chunks: number }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');
    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? 12000;
    const rawOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? 400;
    const chunkOverlap = Math.min(
      Number.isFinite(rawOverlap) && rawOverlap >= 0 ? Math.floor(rawOverlap) : 400,
      maxChunkLength - 1
    );
    const rawConcurrency = params.chunkConcurrency ?? this.options.config?.chunkConcurrency ?? 1;
    const chunkConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1
      ? Math.floor(rawConcurrency)
      : 1;

    if (typeof params.documentChunk !== 'string') {
      throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
    }

    const jobKey = `${this.prefix}:${entityId}:${sourceRef}`;
    if (this.activeIngestJobs.has(jobKey)) {
      throw new WikiBusyError('ingest', entityId);
    }
    if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) {
      throw new WikiBusyError('prune', entityId);
    }
    if (this._isReembedActive(entityId)) {
      throw new WikiBusyError('reembed', entityId);
    }
    if (this._isImportActiveFor(entityId)) {
      throw new WikiBusyError('import', entityId);
    }
    if (this._isForgetActiveFor(entityId)) {
      throw new WikiBusyError('forget', entityId);
    }
    this.activeIngestJobs.add(jobKey);

    try {
      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);

      if (chunks.length === 0) {
        return { truncated: false, chunks: 0 };
      }

      // Bounded-concurrency LLM calls — each chunk is independent
      const chunkResults = await withConcurrency(
        chunks.map((chunk) => async () => {
          const userPrompt = `Document Chunk:\n${chunk}`;
          const responseText = await this.options.llmProvider.generateText({
            systemPrompt: INGEST_SYSTEM_PROMPT,
            userPrompt,
          });
          const result = parseJsonResponse<{ facts: ExtractedFact[] }>(responseText);
          return (Array.isArray(result.facts) ? result.facts : [])
            .map(validateFact)
            .filter((f): f is ExtractedFact => f !== null);
        }),
        chunkConcurrency
      );

      // Flatten in chunk order, then dedup by normalized title (first-wins)
      const seen = new Set<string>();
      const allValidFacts: ExtractedFact[] = [];
      for (const facts of chunkResults) {
        for (const fact of facts) {
          const normalized = fact.title.trim().toLowerCase().replace(/\s+/g, ' ');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            allValidFacts.push(fact);
          }
        }
      }

      const now = Date.now();
      const insertedFacts: Array<{ id: string; entity_id: string; title: string; body: string; tags: string }> = [];
      const deletedSourceFactIds: string[] = [];

      await this.db.withTransactionAsync(async () => {
        const existingSourceFacts = await this.db.getAllAsync<{ id: string }>(
          `SELECT id FROM ${this.prefix}entries WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`,
          [sourceRef, entityId]
        );
        for (const row of existingSourceFacts) {
          deletedSourceFactIds.push(row.id);
        }

        await this.db.runAsync(
          `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`,
          [now, now, sourceRef, entityId]
        );
        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          await this.db.runAsync(
            `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'immutable_document', sourceHash, sourceRef, now, now]
          );
          insertedFacts.push({ id, entity_id: entityId, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        }
      });

      // Rebuild text index before embedding so concurrent reads see new content.
      await this.rebuildMiniSearchIndex(entityId);
      this.vectorCache.delete(entityId);
      const uniqueDeletedSourceFactIds = Array.from(new Set(deletedSourceFactIds));
      for (const factId of uniqueDeletedSourceFactIds) {
        try {
          await this._notifyEmbeddingPersisted(entityId, factId, null);
        } catch (hookErr) {
          console.warn(`[WikiMemory] onEmbeddingPersisted hook failed during ingest for ${factId}:`, hookErr);
        }
      }
      for (const fact of insertedFacts) {
        await this.embedFact(fact);
      }
      // Second flush after embed loop in case a concurrent read() repopulated cache.
      this.vectorCache.delete(entityId);

      return { truncated, chunks: chunks.length };
    } finally {
      this.activeIngestJobs.delete(jobKey);
    }
  }
}

export const __testables = { validateFact, validateTask, clip, chunkText };
