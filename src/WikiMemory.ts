import * as SQLite from 'expo-sqlite';
import { setupDatabase } from './db/schema';
import { WikiOptions, MemoryBundle, WikiEvent, WikiFact, WikiTask, WikiCheckpoint } from './types';
import { LIBRARIAN_SYSTEM_PROMPT, HEAL_SYSTEM_PROMPT, INGEST_SYSTEM_PROMPT } from './prompts';

function parseJsonResponse<T>(text: string): T {
  const cleanText = text.replace(/```[a-zA-Z]*\n/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleanText) as T;
}

function generateId(prefix: string = '') {
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export class WikiMemory {
  private db: SQLite.SQLiteDatabase;
  private prefix: string;
  private options: WikiOptions;

  constructor(db: SQLite.SQLiteDatabase, options: WikiOptions) {
    this.db = db;
    this.options = options;
    this.prefix = options.config?.tablePrefix || 'llm_wiki_';
  }

  async setup() {
    await setupDatabase(this.db, this.prefix);
  }

  private formatSearchQuery(query: string): string {
    const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 3);
    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"*`).join(' OR ');
  }

  async read(entityId: string, query: string): Promise<MemoryBundle> {
    const ftsQuery = this.formatSearchQuery(query);
    const maxResults = this.options.config?.maxFtsResults || 10;
    
    let facts: WikiFact[] = [];
    if (ftsQuery) {
      facts = await this.db.getAllAsync<WikiFact>(`
        SELECT e.* FROM ${this.prefix}entries e
        JOIN ${this.prefix}entries_fts fts ON e.rowid = fts.rowid
        WHERE fts.${this.prefix}entries_fts MATCH ?
          AND e.entity_id = ?
          AND e.deleted_at IS NULL
        ORDER BY e.confidence DESC, e.access_count DESC, e.updated_at DESC
        LIMIT ?
      `, [ftsQuery, entityId, maxResults]);

      if (facts.length > 0) {
        const ids = facts.map(f => `'${f.id}'`).join(',');
        const now = Date.now();
        await this.db.runAsync(`
          UPDATE ${this.prefix}entries 
          SET access_count = access_count + 1, last_accessed_at = ?
          WHERE id IN (${ids})
        `, [now]);
      }
    } else {
      facts = await this.db.getAllAsync<WikiFact>(`
        SELECT * FROM ${this.prefix}entries
        WHERE entity_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT ?
      `, [entityId, maxResults]);
    }

    const tasks = await this.db.getAllAsync<WikiTask>(`
      SELECT * FROM ${this.prefix}tasks
      WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL
      ORDER BY priority DESC, created_at ASC
    `, [entityId]);

    const events = await this.db.getAllAsync<WikiEvent>(`
      SELECT * FROM ${this.prefix}events
      WHERE entity_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `, [entityId]);

    // For safety with types when returning SQLite rows
    // It's good to ensure tags are parsed
    facts = facts.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
    }));

    return { facts, tasks, events: events.reverse() };
  }

  async write(entityId: string, event: Omit<WikiEvent, 'id' | 'entity_id' | 'created_at'>): Promise<void> {
    const id = generateId('evt_');
    const now = Date.now();
    await this.db.runAsync(`
      INSERT INTO ${this.prefix}events (id, entity_id, event_type, summary, related_entry_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, entityId, event.event_type, event.summary, event.related_entry_id || null, now]);

    const threshold = this.options.config?.autoLibrarianThreshold || 20;
    
    const row = await this.db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM ${this.prefix}events WHERE entity_id = ?`, [entityId]);
    const cp = await this.db.getFirstAsync<WikiCheckpoint>(`SELECT * FROM ${this.prefix}checkpoints WHERE entity_id = ?`, [entityId]);
    
    const count = row?.count || 0;
    const memoryCheckpoint = cp?.memory_checkpoint || 0;

    if (count - memoryCheckpoint >= threshold) {
      await this.db.runAsync(`
        INSERT INTO ${this.prefix}checkpoints (entity_id, memory_checkpoint) 
        VALUES (?, ?) 
        ON CONFLICT(entity_id) DO UPDATE SET memory_checkpoint = ?
      `, [entityId, count, count]);
      
      this.runLibrarian(entityId).catch(console.error);
    }
  }

  async runLibrarian(entityId: string): Promise<void> {
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

    const result = parseJsonResponse<{ facts: import('./types').ExtractedFact[], tasks: import('./types').ExtractedTask[] }>(responseText);

    const now = Date.now();

    await this.db.withTransactionAsync(async () => {
      for (const fact of result.facts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
      }

      for (const task of result.tasks) {
        const id = generateId('task_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}tasks (id, entity_id, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, task.description, 'pending', task.priority, now, now]);
      }
    });
  }

  async runHeal(entityId: string): Promise<void> {
    const allFactsRows = await this.db.getAllAsync<WikiFact>(`SELECT * FROM ${this.prefix}entries WHERE entity_id = ? AND deleted_at IS NULL`, [entityId]);
    const allTasks = await this.db.getAllAsync<WikiTask>(`SELECT * FROM ${this.prefix}tasks WHERE entity_id = ? AND status IN ('pending', 'in_progress') AND deleted_at IS NULL`, [entityId]);
    const recentEvents = await this.db.getAllAsync<WikiEvent>(`SELECT * FROM ${this.prefix}events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 20`, [entityId]);

    const allFacts = allFactsRows.map(f => ({
      ...f,
      tags: typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
    }));

    const userPrompt = `All Facts:\n${JSON.stringify(allFacts, null, 2)}\n\nAll Tasks:\n${JSON.stringify(allTasks, null, 2)}\n\nRecent Events:\n${JSON.stringify(recentEvents, null, 2)}`;
    
    const responseText = await this.options.llmProvider.generateText({
      systemPrompt: HEAL_SYSTEM_PROMPT,
      userPrompt,
    });

    const result = parseJsonResponse<{ downgraded: string[], deleted: string[], newFacts: import('./types').ExtractedFact[] }>(responseText);

    const now = Date.now();
    await this.db.withTransactionAsync(async () => {
      for (const id of result.downgraded) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET confidence = 'tentative', updated_at = ? WHERE id = ? AND entity_id = ? AND source_type != 'user_document'`, [now, id, entityId]);
      }
      for (const id of result.deleted) {
        await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ? AND source_type != 'user_document'`, [now, now, id, entityId]);
      }
      for (const fact of result.newFacts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'agent_inferred', now, now]);
      }
    });
  }

  async forget(entityId: string, params: { entryId?: string; taskId?: string; sourceRef?: string; clearAll?: boolean }): Promise<void> {
    const now = Date.now();
    if (params.clearAll) {
      await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ?`, [now, now, entityId]);
      await this.db.runAsync(`UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE entity_id = ?`, [now, now, entityId]);
    } else if (params.entryId) {
      await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ?`, [now, now, params.entryId, entityId]);
    } else if (params.taskId) {
      await this.db.runAsync(`UPDATE ${this.prefix}tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND entity_id = ?`, [now, now, params.taskId, entityId]);
    } else if (params.sourceRef) {
      await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ?`, [now, now, params.sourceRef, entityId]);
    }
  }

  async ingestDocument(entityId: string, params: { sourceRef: string; sourceHash: string; documentChunk: string }): Promise<void> {
    const userPrompt = `Document Chunk:\n${params.documentChunk}`;
    
    const responseText = await this.options.llmProvider.generateText({
      systemPrompt: INGEST_SYSTEM_PROMPT,
      userPrompt,
    });

    const result = parseJsonResponse<{ facts: import('./types').ExtractedFact[] }>(responseText);

    const now = Date.now();
    await this.db.withTransactionAsync(async () => {
      // 1. Soft-delete any existing entries with this source_ref (idempotent replace)
      await this.db.runAsync(`UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE source_ref = ? AND entity_id = ?`, [now, now, params.sourceRef, entityId]);

      // 2. Insert the new facts
      for (const fact of result.facts) {
        const id = generateId('fact_');
        await this.db.runAsync(`
          INSERT INTO ${this.prefix}entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, entityId, fact.title, fact.body, JSON.stringify(fact.tags), fact.confidence, 'user_document', params.sourceHash, params.sourceRef, now, now]);
      }
    });
  }
}
