import type { SQLiteAdapter, SupersedeReplacement, WikiFact, WikiOptions } from '../types';
import { WikiSupersedeError } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SearchService } from './SearchService';
import type { EmbeddingService } from './EmbeddingService';
import { generateId } from '../utils/ids';
import { assertEpochMs } from '../utils/temporal';

export const HISTORY_MAX_DEPTH = 100;

/** Supersession and history (spec 2026-09-29 §4.3). */
export class TemporalService {
  constructor(
    private db: SQLiteAdapter,
    private options: WikiOptions,
    private entryRepo: EntryRepository,
    private searchService: SearchService,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Link `oldId` → `newId` inside the caller's transaction. `newId` must
   * already exist. Throws WikiSupersedeError on any rule violation; the
   * caller's transaction then rolls back.
   */
  async supersedeInTx(tx: SQLiteAdapter, entityId: string, oldId: string, newId: string, t: number, now: number): Promise<void> {
    const old = await this.entryRepo.findTemporalRow(oldId, tx);
    if (!old || old.deleted_at != null) throw new WikiSupersedeError('not_found');
    if (old.entity_id !== entityId) throw new WikiSupersedeError('cross_entity');
    if (old.superseded_by != null) throw new WikiSupersedeError('already_superseded');
    if (old.source_type === 'immutable_document') throw new WikiSupersedeError('immutable_target');

    if (newId === oldId) throw new WikiSupersedeError('cycle');
    const repl = await this.entryRepo.findTemporalRow(newId, tx);
    if (!repl || repl.deleted_at != null) throw new WikiSupersedeError('not_found');
    if (repl.entity_id !== entityId) throw new WikiSupersedeError('cross_entity');
    const { predecessors } = await this.entryRepo.findSupersessionChainIds(entityId, oldId, HISTORY_MAX_DEPTH, tx);
    if (predecessors.includes(newId)) throw new WikiSupersedeError('cycle');

    await this.entryRepo.setTemporal(oldId, entityId, { valid_to: t, superseded_by: newId, superseded_at: now }, tx);
    if (repl.valid_from == null) {
      await this.entryRepo.setTemporal(newId, entityId, { valid_from: t }, tx);
    }
  }

  async supersede(
    entityId: string,
    oldId: string,
    replacement: SupersedeReplacement,
    options?: { validFrom?: number },
  ): Promise<{ newId: string }> {
    const now = Date.now();
    const t = options?.validFrom === undefined ? now : assertEpochMs('options.validFrom', options.validFrom);
    let created: WikiFact | null = null;

    if (typeof replacement !== 'string') {
      if (typeof replacement?.title !== 'string' || replacement.title.trim() === '' || typeof replacement.body !== 'string') {
        throw new TypeError('supersede(): replacement must be a fact id or { title, body }');
      }
      created = {
        id: generateId('fact_'),
        entity_id: entityId,
        title: replacement.title,
        body: replacement.body,
        tags: Array.isArray(replacement.tags) ? replacement.tags : [],
        confidence: replacement.confidence ?? 'certain',
        source_type: replacement.source_type ?? 'user_stated',
        source_hash: null,
        source_ref: null,
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
        access_count: 0,
        deleted_at: null,
      };
    }
    const newId = typeof replacement === 'string' ? replacement : created!.id;
    const newValidFrom = typeof replacement !== 'string' && replacement.valid_from !== undefined
      ? assertEpochMs('replacement.valid_from', replacement.valid_from)
      : undefined;

    await this.db.withTransactionAsync(async (tx) => {
      if (created) {
        await this.entryRepo.upsert(created, tx);
        if (newValidFrom !== undefined) {
          await this.entryRepo.setTemporal(created.id, entityId, { valid_from: newValidFrom }, tx);
        }
      }
      await this.supersedeInTx(tx, entityId, oldId, newId, t, now);
    });

    await this.searchService.syncEntries(entityId, [oldId, newId]);
    if (created) {
      await this.embeddingService.embedFact(
        { id: created.id, entity_id: entityId, title: created.title, body: created.body, tags: created.tags },
        { operation: 'supersede', trigger: 'call' },
      );
    }
    this.searchService.evictCache(entityId);
    return { newId };
  }

  async history(entityId: string, factId: string): Promise<WikiFact[]> {
    const start = await this.entryRepo.findTemporalRow(factId);
    if (!start || start.entity_id !== entityId || start.deleted_at != null) return [];
    const { predecessors, successors } = await this.entryRepo.findSupersessionChainIds(entityId, factId, HISTORY_MAX_DEPTH);
    const facts = await this.entryRepo.findByIds([...predecessors, factId, ...successors], [entityId]);
    return facts.sort((a, b) =>
      (a.valid_from ?? a.created_at) - (b.valid_from ?? b.created_at)
      || a.created_at - b.created_at
      || a.id.localeCompare(b.id));
  }
}