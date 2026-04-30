import * as SQLite from 'expo-sqlite';
import { setupDatabase } from './db/schema';
import { WikiOptions, MemoryBundle, MemoryDump, FormattedMemoryDump, WikiEvent, WikiFact, WikiTask, WikiCheckpoint, ExtractedFact, ExtractedTask, WikiBusyError, EntityStatus } from './types';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from './prompts';

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

export function chunkText(
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
    if (paraIdx >= minSplit && paraIdx < windowEnd) {
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
  private db: SQLite.SQLiteDatabase;
  private prefix: string;
  private options: WikiOptions;
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();

  constructor(db: SQLite.SQLiteDatabase, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';
  }

  async setup() {
    await setupDatabase(this.db, this.prefix);
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
  }

  private formatSearchQuery(query: string): string {
    const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3).slice(0, 6);
    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"*`).join(' OR ');
  }

  async read(entityId: string, query: string): Promise<MemoryBundle> {
    const ftsQuery = this.formatSearchQuery(query);
    const maxResults = this.options.config?.maxFtsResults || 10;
    
    let factsPromise: Promise<WikiFact[]>;

    if (ftsQuery) {
      factsPromise = this.db.getAllAsync<WikiFact>(`
        SELECT e.* FROM ${this.prefix}entries e
        JOIN ${this.prefix}entries_fts fts ON e.rowid = fts.rowid
        WHERE fts.${this.prefix}entries_fts MATCH ?
          AND e.entity_id = ?
          AND e.deleted_at IS NULL
        ORDER BY e.confidence DESC, e.access_count DESC, e.updated_at DESC
        LIMIT ?
      `, [ftsQuery, entityId, maxResults]);
    } else {
      factsPromise = this.db.getAllAsync<WikiFact>(`
        SELECT * FROM ${this.prefix}entries
        WHERE entity_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ?
      `, [entityId, maxResults]);
    }

    const tasksPromise = this.db.getAllAsync<WikiTask>(`
      SELECT * FROM ${this.prefix}tasks
      WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL
      ORDER BY priority DESC, created_at ASC
    `, [entityId]);

    const eventsPromise = this.db.getAllAsync<WikiEvent>(`
      SELECT * FROM ${this.prefix}events
      WHERE entity_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `, [entityId]);

    const [factsRaw, tasks, events] = await Promise.all([factsPromise, tasksPromise, eventsPromise]);

    if (ftsQuery && factsRaw.length > 0) {
      const ids = factsRaw.map(f => f.id);
      const placeholders = ids.map(() => '?').join(',');
      const now = Date.now();
      await this.db.runAsync(`
        UPDATE ${this.prefix}entries 
        SET access_count = access_count + 1, last_accessed_at = ?
        WHERE id IN (${placeholders})
      `, [now, ...ids]);
    }

    const facts = factsRaw.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
    }));

    return { facts, tasks, events: events.reverse() };
  }

  async getMemoryBundle(entityId: string): Promise<{ facts: WikiFact[]; tasks: WikiTask[]; events: WikiEvent[] }> {
    const [factsRaw, tasks, events] = await Promise.all([
      this.db.getAllAsync<WikiFact>(
        `SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiTask>(
        `SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC`,
        [entityId]
      ),
      this.db.getAllAsync<WikiEvent>(
        `SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10`,
        [entityId]
      ),
    ]);
    const facts = factsRaw.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags,
    }));
    return { facts, tasks, events: events.reverse() };
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
      const jobKey = `${this.prefix}:${entityId}:librarian`;
      if (!this.activeMaintenanceJobs.has(jobKey)) {
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
      await this._doRunHeal(entityId);
      await this.db.runAsync(`
        INSERT INTO ${this.prefix}checkpoints (entity_id, heal_checkpoint) 
        VALUES (?, ?) 
        ON CONFLICT(entity_id) DO UPDATE SET heal_checkpoint = ?
      `, [entityId, currentEventCount, currentEventCount]);
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

    const currentFacts = currentFactsRows.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
    }));

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
      }

      for (const task of validTasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });
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

    const userPrompt = `Heal Candidates:\n${JSON.stringify(healCandidates.map(f => ({...f, tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags})), null, 2)}
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
      }
    });
  }

  async runLibrarian(entityId: string): Promise<void> {
    const jobKey = `${this.prefix}:${entityId}:librarian`;
    if (this.activeMaintenanceJobs.has(jobKey)) {
      throw new WikiBusyError('librarian', entityId);
    }
    this.activeMaintenanceJobs.add(jobKey);
    try {
      await this._doRunLibrarian(entityId);
    } finally {
      this.activeMaintenanceJobs.delete(jobKey);
    }
  }

  async runHeal(entityId: string): Promise<void> {
    const jobKey = `${this.prefix}:${entityId}:heal`;
    if (this.activeMaintenanceJobs.has(jobKey)) {
      throw new WikiBusyError('heal', entityId);
    }
    this.activeMaintenanceJobs.add(jobKey);
    try {
      await this._doRunHeal(entityId);
    } finally {
      this.activeMaintenanceJobs.delete(jobKey);
    }
  }

  getEntityStatus(entityId: string): EntityStatus {
    const ingestPrefix = `${this.prefix}:${entityId}:`;
    const librarianKey = `${this.prefix}:${entityId}:librarian`;
    const healKey = `${this.prefix}:${entityId}:heal`;

    let ingesting = false;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(ingestPrefix)) {
        ingesting = true;
        break;
      }
    }

    return {
      ingesting,
      librarian: this.activeMaintenanceJobs.has(librarianKey),
      heal: this.activeMaintenanceJobs.has(healKey),
    };
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
        )
      `);
      ids = rows.map(r => r.entity_id);
    }

    const entities: Record<string, MemoryBundle> = {};
    for (const id of ids) {
      const bundle = await this.getMemoryBundle(id);
      entities[id] = bundle;
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
        }

        for (const fact of bundle.facts) {
          if (merge) {
            const existing = await this.db.getFirstAsync<{ id: string }>(
              `SELECT id FROM ${this.prefix}entries WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
              [fact.id, entityId]
            );
            if (existing) continue;
          }

          await this.db.runAsync(
            `INSERT OR REPLACE INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              fact.id,
              entityId,
              fact.title,
              fact.body,
              JSON.stringify(fact.tags),
              fact.confidence,
              fact.source_type,
              fact.source_hash,
              fact.source_ref,
              fact.created_at,
              fact.updated_at,
              fact.last_accessed_at,
              fact.access_count,
              fact.deleted_at,
            ]
          );
        }

        for (const task of bundle.tasks) {
          if (merge) {
            const existing = await this.db.getFirstAsync<{ id: string }>(
              `SELECT id FROM ${this.prefix}tasks WHERE id = ? AND entity_id = ? AND deleted_at IS NULL`,
              [task.id, entityId]
            );
            if (existing) continue;
          }

          await this.db.runAsync(
            `INSERT OR REPLACE INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              task.id,
              entityId,
              task.description,
              task.status,
              task.priority,
              task.created_at,
              task.updated_at,
              task.resolved_at,
              task.deleted_at,
            ]
          );
        }

        for (const event of bundle.events) {
          await this.db.runAsync(
            `INSERT OR IGNORE INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [event.id, entityId, event.event_type, event.summary, event.related_entry_id ?? null, event.created_at]
          );
        }
      });
    }
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

      let refPromise: Promise<SQLite.SQLiteRunResult> | null = null;
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

    return { deleted: { entries: deletedEntries, tasks: deletedTasks } };
  }

  async ingestDocument(entityId: string, params: { sourceRef: string; sourceHash: string; documentChunk: string; maxChunkLength?: number; chunkOverlap?: number }): Promise<{ truncated: boolean; chunks: number }> {
    const sourceRef = normalizeSourceRef(params.sourceRef);
    if (!sourceRef) throw new Error('Invalid sourceRef');
    const sourceHash = normalizeSourceHash(params.sourceHash);
    if (!sourceHash) throw new Error('Invalid sourceHash (must be 64-char hex string)');

    const maxChunkLength = params.maxChunkLength ?? this.options.config?.maxChunkLength ?? 12000;
    const chunkOverlap = params.chunkOverlap ?? this.options.config?.chunkOverlap ?? 400;

    if (typeof params.documentChunk !== 'string') {
      throw new Error(`documentChunk must be a string, received ${typeof params.documentChunk}`);
    }

    const jobKey = `${this.prefix}:${entityId}:${sourceRef}`;
    if (this.activeIngestJobs.has(jobKey)) {
      throw new WikiBusyError('ingest', entityId);
    }
    this.activeIngestJobs.add(jobKey);

    try {
      const { chunks, truncated } = chunkText(params.documentChunk, maxChunkLength, chunkOverlap);

      if (chunks.length === 0) {
        return { truncated: false, chunks: 0 };
      }

      // Parallel LLM calls - each chunk is independent
      const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
          const userPrompt = `Document Chunk:\n${chunk}`;
          const responseText = await this.options.llmProvider.generateText({
            systemPrompt: INGEST_SYSTEM_PROMPT,
            userPrompt,
          });
          const result = parseJsonResponse<{ facts: ExtractedFact[] }>(responseText);
          return (Array.isArray(result.facts) ? result.facts : [])
            .map(validateFact)
            .filter((f): f is ExtractedFact => f !== null);
        })
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
        }
      });

      return { truncated, chunks: chunks.length };
    } finally {
      this.activeIngestJobs.delete(jobKey);
    }
  }
}

export const __testables = { validateFact, validateTask, clip };
