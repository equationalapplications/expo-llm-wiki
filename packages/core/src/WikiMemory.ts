import type { SQLiteAdapter } from './types';
import { setupDatabase } from './db/schema';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION } from './db/migrations';
import { WikiOptions, MemoryBundle, MemoryDump, WikiEvent, WikiFact, WikiTask, WikiCheckpoint, ExtractedFact, ExtractedTask, WikiBusyError, EntityStatus } from './types';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from './prompts';
import MiniSearch from 'minisearch';
import { cosineSimilarity } from './utils/cosine';
import { parseEmbedding } from './utils/embedding';

export { WikiBusyError } from './types';

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
      } else {
        await this.db.runAsync(
          `DELETE FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
        );
      }
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
    if (mismatch) {
      await this.db.runAsync(
        `INSERT OR REPLACE INTO ${this.prefix}meta (key, value) VALUES ('embedding_dimension', ?)`,
        [mismatch.value]
      );
      await this.db.runAsync(
        `DELETE FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`
      );
    }
  }

  private async embedFact(fact: { id: string; title: string; body: string; tags: string | string[] }): Promise<boolean> {
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
      // embedding_dimension and write unusable data to entries.embedding.
      if (vector.length === 0 || !vector.every(v => typeof v === 'number' && isFinite(v))) {
        console.warn(`[WikiMemory] embedFact: embed() returned an invalid vector for ${fact.id}; skipping.`);
        return false;
      }
      await this.storeEmbeddingDimension(vector.length);
      const blob = new Uint8Array(new Float32Array(vector).buffer);
      await this.db.runAsync(
        `UPDATE ${this.prefix}entries SET embedding_blob = ?, embedding = NULL WHERE id = ?`,
        [blob, fact.id]
      );
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
  private _isReembedActive(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._reembedKey(entityId))
      || this.activeMaintenanceJobs.has(this._globalReembedKey());
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
    // Prune must not run concurrently with librarian, heal, ingest, or another
    // prune for the same entity.
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    let isIngestRunning = false;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) { isIngestRunning = true; break; }
    }
    let blockingOperation: 'prune' | 'librarian' | 'heal' | 'ingest' | 'reembed' | null = null;
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
        const entryResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}entries
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
          [entityId, cutoff]
        );
        deletedEntries = entryResult.changes;

        const taskResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}tasks
           WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
          [entityId, cutoff]
        );
        deletedTasks = taskResult.changes;
      }

      if (retainEventsFor !== null) {
        const cutoff = now - retainEventsFor * 86400000;
        const eventResult = await this.db.runAsync(
          `DELETE FROM ${this.prefix}events
           WHERE entity_id = ? AND created_at < ?`,
          [entityId, cutoff]
        );
        deletedEvents = eventResult.changes;
      }

      if (vacuum) {
        await this.db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
        await this.db.execAsync(`VACUUM`);
      }

      await this.rebuildMiniSearchIndex(entityId);
      return { entries: deletedEntries, tasks: deletedTasks, events: deletedEvents };
    } finally {
      this.activeMaintenanceJobs.delete(pruneKey);
    }
  }

  async read(entityId: string, query: string): Promise<MemoryBundle> {
    const maxResults = this.options.config?.maxResults
      ?? this.options.config?.maxFtsResults
      ?? 10;
    const embedFn = this.options.llmProvider.embed;
    const trimmedQuery = query.trim();

    let facts: WikiFact[] = [];

    if (trimmedQuery) {
      let usedEmbed = false;

      if (embedFn) {
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

          // Phase 1: fetch scoring columns (embedding_blob + fallback TEXT) for all rows
          const scoreRows = await this.db.getAllAsync<{
            id: string;
            embedding_blob: Uint8Array | null;
            embedding: string | null;
            updated_at: number | null;
            access_count: number | null;
          }>(
            `SELECT id, embedding_blob, embedding, updated_at, access_count FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`,
            [entityId]
          );

          // Cache: reuse parsed vectors from prior full-scan reads
          const entityCache = this.vectorCache.get(entityId) ?? new Map<string, Float32Array>();
          const scored = scoreRows.map(row => {
            let vector = entityCache.get(row.id) ?? parseEmbedding(row.embedding_blob, row.embedding);
            if (vector && !entityCache.has(row.id)) {
              entityCache.set(row.id, vector);
            }
            let score = 0;
            if (vector && vector.length === queryVec.length) {
              score = Math.max(0, cosineSimilarity(queryVec, vector));
            }
            return { row, score };
          });
          this.vectorCache.set(entityId, entityCache);

          scored.sort((a, b) => {
            const scoreDiff = b.score - a.score;
            if (scoreDiff !== 0) return scoreDiff;
            const accessCountDiff = (b.row.access_count ?? 0) - (a.row.access_count ?? 0);
            if (accessCountDiff !== 0) return accessCountDiff;
            const updatedAtDiff = (b.row.updated_at ?? 0) - (a.row.updated_at ?? 0);
            if (updatedAtDiff !== 0) return updatedAtDiff;
            return a.row.id.localeCompare(b.row.id);
          });

          // Phase 2: fetch full rows only for the top results
          const topIds = scored.slice(0, maxResults).map(s => s.row.id);
          if (topIds.length > 0) {
            const placeholders = topIds.map(() => '?').join(',');
            const fullRows = await this.db.getAllAsync<WikiFact & { embedding: string | null; embedding_blob: Uint8Array | null }>(
              `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
              topIds
            );
            const byId = new Map(fullRows.map(r => [r.id, r]));
            facts = topIds.map(id => byId.get(id)).filter((f): f is WikiFact & { embedding: string | null; embedding_blob: Uint8Array | null } => f !== undefined);
          }
          usedEmbed = true;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
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
          const placeholders = topIds.map(() => '?').join(',');
          const rows = await this.db.getAllAsync<WikiFact>(
            `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
            topIds
          );
          const byId = new Map(rows.map(r => [r.id, r]));
          facts = topIds.map(id => byId.get(id)).filter((f): f is WikiFact => f !== undefined);
        }
      }

      if (facts.length > 0) {
        const ids = facts.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');
        const now = Date.now();
        await this.db.runAsync(
          `UPDATE ${this.prefix}entries
           SET access_count = access_count + 1, last_accessed_at = ?
           WHERE id IN (${placeholders})`,
          [now, ...ids]
        );
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
        !this.activeMaintenanceJobs.has(this._pruneKey(entityId))
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

    const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

    await this.db.withTransactionAsync(async () => {
      for (const fact of validFacts) {
        const newTokens = titleTokens(fact.title);
        let skip = false;
        if (newTokens.size >= MIN_TOKENS_TO_QUALIFY) {
          for (const existing of currentFactsRows) {
            if (existing.source_type !== 'agent_inferred') continue;
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
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
        insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });

    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    await this.rebuildMiniSearchIndex(entityId);
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
          WHERE entity_id = ? AND access_count = 0 AND created_at < ? AND source_type != 'user_document' AND deleted_at IS NULL
        `, [now, now, entityId, orphanThreshold]);
      }

      if (staleInferredAfterDays !== null) {
        const staleThreshold = now - (staleInferredAfterDays * MS_PER_DAY);
        await this.db.runAsync(`
          UPDATE ${this.prefix}entries 
          SET confidence = 'tentative', updated_at = ? 
          WHERE entity_id = ? AND confidence = 'inferred' AND (last_accessed_at < ? OR (last_accessed_at IS NULL AND created_at < ?)) AND source_type != 'user_document' AND deleted_at IS NULL
        `, [now, entityId, staleThreshold, staleThreshold]);
      }
    });

    const allFactsRows = await this.db.getAllAsync<WikiFact>(`SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`, [entityId]);
    const allTasks = await this.db.getAllAsync<WikiTask>(`SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL`, [entityId]);
    const recentEvents = await this.db.getAllAsync<WikiEvent>(`SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 20`, [entityId]);

    const healCandidates = allFactsRows.filter(f => f.source_type !== 'user_document');
    const documentAnchors = allFactsRows
      .filter(f => f.source_type === 'user_document')
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

    const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

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
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
        insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
      }
    });

    for (const fact of insertedFacts) {
      await this.embedFact(fact);
    }
    await this.rebuildMiniSearchIndex(entityId);
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
    this.activeMaintenanceJobs.add(jobKey);
    try {
      await this._doRunHeal(entityId);
    } finally {
      this.activeMaintenanceJobs.delete(jobKey);
    }
  }

  async runReembed(entityId?: string): Promise<{ embedded: number; skipped: number }> {
    const embedFn = this.options.llmProvider.embed;
    if (!embedFn) return { embedded: 0, skipped: 0 };

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
    }
    this.activeMaintenanceJobs.add(reembedKey);

    try {
      const where = entityId ? `entity_id = ? AND deleted_at IS NULL` : `deleted_at IS NULL`;
      const params = entityId ? [entityId] : [];
      const rows = await this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE ${where}`,
        params
      );

      let embedded = 0;
      let skipped = 0;
      for (const row of rows) {
        const success = await this.embedFact(row);
        if (success) embedded++;
        else skipped++;
      }
      // If any fact was successfully re-embedded, promote the pending dimension to
      // canonical and clear the mismatch flag so read() uses embeddings from here on.
      if (embedded > 0) {
        await this._reconcileEmbeddingDimension();
      }
      return { embedded, skipped };
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

  private async _getFullBundle(entityId: string, opts?: { maxEvents?: number }): Promise<MemoryBundle> {
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
      const { embedding: _embedding, embedding_blob: _blob, ...rest } = f as WikiFact & { embedding?: unknown; embedding_blob?: unknown };
      return {
        ...rest,
        tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : rest.tags,
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
        batch.map(async (id): Promise<[string, MemoryBundle]> => [id, await this._getFullBundle(id)])
      );
      for (const [id, bundle] of batchResults) {
        entities[id] = bundle;
      }
    }

    return { generatedAt: Date.now(), entities };
  }

  async importDump(dump: MemoryDump, opts?: { merge?: boolean }): Promise<void> {
    const merge = opts?.merge ?? false;

    for (const [entityId, bundle] of Object.entries(dump.entities)) {
      await this.db.withTransactionAsync(async () => {
        if (!merge) {
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
          const tagsJson = JSON.stringify(Array.isArray(fact.tags) ? fact.tags : []);
          // Normalize once: non-finite (undefined/null/NaN) → 0 so we never persist an
          // invalid value to the DB and ORDER BY updated_at remains meaningful.
          const safeUpdatedAt = Number.isFinite(fact.updated_at) ? fact.updated_at : 0;
          const existing = existingFactsById.get(fact.id);
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
            // replace mode (or merge LWW winner): update the existing row (restores if soft-deleted)
            await this.db.runAsync(
              `UPDATE ${this.prefix}entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ? WHERE id = ?`,
              [entityId, fact.title, fact.body, tagsJson, fact.confidence, fact.source_type, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at, fact.id]
            );
            existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
          } else {
            await this.db.runAsync(
              `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [fact.id, entityId, fact.title, fact.body, tagsJson, fact.confidence, fact.source_type, fact.source_hash, fact.source_ref, fact.created_at, safeUpdatedAt, fact.last_accessed_at, fact.access_count, fact.deleted_at]
            );
            existingFactsById.set(fact.id, { id: fact.id, entity_id: entityId, updated_at: safeUpdatedAt });
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
      // Embed non-deleted imported facts so they are immediately searchable.
      for (const fact of bundle.facts) {
        if (!fact.deleted_at) {
          await this.embedFact({
            id: fact.id,
            title: fact.title,
            body: fact.body,
            tags: Array.isArray(fact.tags) || typeof fact.tags === 'string' ? fact.tags : [],
          });
        }
      }
    }

    await this.rebuildMiniSearchIndex();
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; sourceHash?: string; clearAll?: boolean }): Promise<{ deleted: { entries: number; tasks: number } }> {
    const now = Date.now();
    let deletedEntries = 0;
    let deletedTasks = 0;

    if (params.clearAll) {
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
    return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
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
      const insertedFacts: Array<{ id: string; title: string; body: string; tags: string }> = [];

      await this.db.withTransactionAsync(async () => {
        await this.db.runAsync(
          `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ? AND deleted_at IS NULL`,
          [now, now, sourceRef, entityId]
        );
        for (const fact of allValidFacts) {
          const id = generateId('fact_');
          await this.db.runAsync(
            `INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'user_document', sourceHash, sourceRef, now, now]
          );
          insertedFacts.push({ id, title: fact.title, body: fact.body, tags: JSON.stringify(fact.tags) });
        }
      });

      for (const fact of insertedFacts) {
        await this.embedFact(fact);
      }
      await this.rebuildMiniSearchIndex(entityId);

      return { truncated, chunks: chunks.length };
    } finally {
      this.activeIngestJobs.delete(jobKey);
    }
  }
}

export const __testables = { validateFact, validateTask, clip, chunkText };
