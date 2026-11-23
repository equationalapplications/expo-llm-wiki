import type { SQLiteAdapter, SupersedeReplacement, WikiFact, WikiOptions } from '../types';
import { WikiSupersedeError } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { SearchService } from './SearchService';
import type { EmbeddingService } from './EmbeddingService';
import { generateId } from '../utils/ids';
import { assertEpochMs } from '../utils/temporal';
import { emitDiagnostic } from '../utils/diagnostics';

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
  async supersedeInTx(tx: SQLiteAdapter, entityId: string, oldId: string, newId: string, t: number, now: number): Promise<{ replacedScheduledEnd: number | null }> {
    const old = await this.entryRepo.findTemporalRow(oldId, tx);
    if (!old || old.deleted_at != null) throw new WikiSupersedeError('not_found');
    if (old.entity_id !== entityId) throw new WikiSupersedeError('cross_entity');
    if (old.superseded_by != null) throw new WikiSupersedeError('already_superseded');
    // The serialized adapter can queue this callback past `now`; read a fresh
    // clock for the guard so a queued wait that spans the archive's end still
    // rejects — `now` still stamps `superseded_at`.
    if (old.valid_to != null && old.valid_to <= Math.max(now, Date.now())) throw new WikiSupersedeError('already_expired');
    if (old.source_type === 'immutable_document') throw new WikiSupersedeError('immutable_target');

    if (newId === oldId) throw new WikiSupersedeError('cycle');
    const repl = await this.entryRepo.findTemporalRow(newId, tx);
    if (!repl || repl.deleted_at != null) throw new WikiSupersedeError('not_found');
    if (repl.entity_id !== entityId) throw new WikiSupersedeError('cross_entity');
    // A replacement that is itself superseded is not current, so linking to it
    // would leave `oldId` with no current successor.
    if (repl.superseded_by != null) throw new WikiSupersedeError('already_superseded');
    const { predecessors } = await this.entryRepo.findSupersessionChainIds(entityId, oldId, HISTORY_MAX_DEPTH, tx);
    if (predecessors.some((r) => r.id === newId)) throw new WikiSupersedeError('cycle');
    const start = old.valid_from ?? old.created_at;
    if (t <= start) throw new WikiSupersedeError('invalid_interval');

    // D2: a scheduled (future) end is about to be overwritten; keep it in
    // prior_valid_to so reopen() can restore it. Open-ended: written as null so a stale value cannot survive.
    const replacedScheduledEnd = old.valid_to;
    await this.entryRepo.setTemporal(oldId, entityId, {
      valid_to: t, superseded_by: newId, superseded_at: now,
      prior_valid_to: replacedScheduledEnd,
    }, tx);
    if (repl.valid_from == null) {
      await this.entryRepo.setTemporal(newId, entityId, { valid_from: t }, tx);
    }
    return { replacedScheduledEnd };
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

    let replacedScheduledEnd: number | null = null;
    await this.db.withTransactionAsync(async (tx) => {
      if (created) {
        await this.entryRepo.upsert(created, tx);
        if (newValidFrom !== undefined) {
          await this.entryRepo.setTemporal(created.id, entityId, { valid_from: newValidFrom }, tx);
        }
      }
      ({ replacedScheduledEnd } = await this.supersedeInTx(tx, entityId, oldId, newId, t, now));
    });
    if (replacedScheduledEnd != null) {
      emitDiagnostic(this.options, {
        code: 'supersede_scheduled_end_replaced', operation: 'supersede', trigger: 'call', entityId,
        detail: { factId: oldId, priorValidTo: replacedScheduledEnd },
      });
    }

    await this.searchService.syncEntries(entityId, [oldId, newId]);
    if (created) {
      // A delete during the vector call is settled in storeFactVector (G10).
      await this.embeddingService.embedFact(
        { id: created.id, entity_id: entityId, title: created.title, body: created.body, tags: created.tags },
        { operation: 'supersede', trigger: 'call' },
      );
    }
    this.searchService.evictCache(entityId);
    return { newId };
  }

  /**
   * End `factId`'s validity without a replacement — an archive, not a
   * deletion (INTENT rule 12, spec specs/expire). Sets `valid_to` only.
   */
  async expire(entityId: string, factId: string, options?: { at?: number }): Promise<void> {
    const t = options?.at === undefined ? Date.now() : assertEpochMs('options.at', options.at);
    await this.db.withTransactionAsync(async (tx) => {
      const old = await this.entryRepo.findTemporalRow(factId, tx);
      if (!old || old.deleted_at != null) throw new WikiSupersedeError('not_found', 'expire()');
      if (old.entity_id !== entityId) throw new WikiSupersedeError('cross_entity', 'expire()');
      if (old.superseded_by != null) throw new WikiSupersedeError('already_superseded', 'expire()');
      if (old.valid_to != null) throw new WikiSupersedeError('already_expired', 'expire()');
      if (old.source_type === 'immutable_document') throw new WikiSupersedeError('immutable_target', 'expire()');
      const start = old.valid_from ?? old.created_at;
      if (t <= start) throw new WikiSupersedeError('invalid_interval', 'expire()');
      const changes = await this.entryRepo.setTemporal(factId, entityId, { valid_to: t }, tx);
      if (changes === 0) throw new WikiSupersedeError('cross_entity', 'expire()');
    });
    await this.searchService.syncEntries(entityId, [factId]);
    this.searchService.evictCache(entityId);
  }

  /**
   * Return a superseded fact to live once its replacement is forgotten or gone
   * (INTENT rule 12, specs/supersede-future-valid-to D4). Restores `valid_to`
   * to `prior_valid_to` (null when none was recorded).
   */
  async reopen(entityId: string, factId: string): Promise<{ valid_to: number | null }> {
    let restored: number | null = null;
    await this.db.withTransactionAsync(async (tx) => {
      const row = await this.entryRepo.findTemporalRow(factId, tx);
      if (!row || row.deleted_at != null) throw new WikiSupersedeError('not_found', 'reopen()');
      if (row.entity_id !== entityId) throw new WikiSupersedeError('cross_entity', 'reopen()');
      if (row.superseded_by == null) throw new WikiSupersedeError('not_superseded', 'reopen()');
      if (row.source_type === 'immutable_document') throw new WikiSupersedeError('immutable_target', 'reopen()');
      // Direct successor only; its entity is not consulted and nothing about it
      // is surfaced (INTENT rule 3). Forgotten or absent passes.
      const successor = await this.entryRepo.findTemporalRow(row.superseded_by, tx);
      if (successor && successor.deleted_at == null) throw new WikiSupersedeError('successor_live', 'reopen()');
      // A crafted dump can carry a non-finite, non-integer or pre-start value;
      // restore null rather than an interval that cannot hold the fact.
      const p = row.prior_valid_to;
      restored = p != null && Number.isInteger(p) && p > (row.valid_from ?? row.created_at) ? p : null;
      const changes = await this.entryRepo.setTemporal(factId, entityId, {
        valid_to: restored, superseded_by: null, superseded_at: null, prior_valid_to: null,
      }, tx);
      if (changes === 0) throw new WikiSupersedeError('cross_entity', 'reopen()');
    });
    await this.searchService.syncEntries(entityId, [factId]);
    this.searchService.evictCache(entityId);
    return { valid_to: restored };
  }

  async history(entityId: string, factId: string): Promise<WikiFact[]> {
    const start = await this.entryRepo.findTemporalRow(factId);
    if (!start || start.entity_id !== entityId || start.deleted_at != null) return [];
    const { predecessors, successors } = await this.entryRepo.findSupersessionChainIds(entityId, factId, HISTORY_MAX_DEPTH);
    const facts = await this.entryRepo.findByIds([...predecessors.map((r) => r.id), factId, ...successors.map((r) => r.id)], [entityId]);
    return facts.sort((a, b) =>
      (a.valid_from ?? a.created_at) - (b.valid_from ?? b.created_at)
      || a.created_at - b.created_at
      || a.id.localeCompare(b.id));
  }
}