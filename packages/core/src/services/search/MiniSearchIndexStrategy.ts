// packages/core/src/services/search/MiniSearchIndexStrategy.ts

import MiniSearch from 'minisearch';
import type { SQLiteAdapter } from '../../types';
import type {
  IndexDocument,
  IndexSearchOptions,
  IndexSearchResult,
  IndexStrategy,
  PassageHit,
} from './IndexStrategy';
import { hydratePassageHits } from './Fts5IndexStrategy';

interface PassageDoc { id: string; entity_id: string; document_id: string; text: string }

export type { PassageSearchResult } from './Fts5IndexStrategy';

/**
 * Passage slices of one entity, cut from `source_documents.text` at the stored
 * UTF-16 offsets. Reads one document at a time.
 */
async function loadStoredPassages(db: SQLiteAdapter, prefix: string, entityId: string): Promise<PassageDoc[]> {
  const out: PassageDoc[] = [];
  const docs = await db.getAllAsync<{ id: string }>(`SELECT id FROM ${prefix}source_documents WHERE entity_id = ?`, [entityId]);
  for (const d of docs) {
    const doc = await db.getFirstAsync<{ text: string }>(`SELECT text FROM ${prefix}source_documents WHERE id = ?`, [d.id]);
    if (!doc) continue;
    const rows = await db.getAllAsync<{ id: string; start_offset: number; end_offset: number }>(
      `SELECT id, start_offset, end_offset FROM ${prefix}source_passages WHERE document_id = ? ORDER BY seq`, [d.id]);
    for (const r of rows) {
      out.push({ id: r.id, entity_id: entityId, document_id: d.id, text: doc.text.slice(Number(r.start_offset), Number(r.end_offset)) });
    }
  }
  return out;
}

/**
 * In-RAM keyword index. Extracted from `SearchService` without behavior
 * change. The strategy owns the MiniSearch instance, the `entryIdsByEntity`
 * tracking map, the `entityIdById` reverse map, and the explicit-vacuum
 * policy (#64).
 *
 * Memory cost: O(total text). The fix for #257 lives in PR-2's FTS5
 * strategy; this one stays for Expo/OPFS environments without FTS5 and for
 * hosts that explicitly pin `WikiConfig.indexStrategy: 'minisearch'`.
 */
export class MiniSearchIndexStrategy implements IndexStrategy {
  private index: MiniSearch<IndexDocument>;
  /**
   * Per-entity id set. `replaceEntity()` and `hasIndexedEntity()` read it;
   * `addDocuments()` and `discardIds()` keep it in sync. `SearchService` does
   * not see this map; it only sees `hasIndexedEntity`. The previous
   * `miniSearchEntryIdsByEntity` lived on `SearchService`.
   */
  private entryIdsByEntity = new Map<string, Set<string>>();
  /**
   * Reverse of `entryIdsByEntity`. `replace(entityId, ids, …)` uses it to
   * decide which ids are owned by `entityId` (the only safe membership test
   * — a rebuild that failed between its discard pass and the set replacement
   * can leave the forward set claiming ids the MiniSearch instance does not
   * hold). The pre-extraction `syncEntries` deleted from one set per id, not
   * from every entity's set.
   */
  private entityIdById = new Map<string, string>();

  constructor() {
    this.index = this.createIndex();
  }

  /**
   * Build a fresh MiniSearch instance with the project's index options.
   * Called from the constructor and from `replaceAll`. We do not use
   * `removeAll()` on an existing instance because that empties the index but
   * leaves `dirtCount` and the vacuum bookkeeping intact, which would trip
   * `syncEntries`' conditional vacuum early after a clear.
   */
  private createIndex(): MiniSearch<IndexDocument> {
    return new MiniSearch({
      fields: ['title', 'body', 'tags'],
      storeFields: ['entity_id'],
      // Vacuuming is driven explicitly at the end of each serialized rebuild
      // (see SearchService.syncEntries). Auto-vacuum fires on its own
      // schedule, asynchronously with respect to the caller, and traversing
      // the tree mid-rebuild is what threw the uncaught TypeError in
      // MiniSearch.performVacuuming (#64).
      autoVacuum: false,
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Incremental sync. Removes only ids currently tracked under `entityId`
   * (other entities' docs are untouched), then upserts `documents` by id.
   * The same id appearing in both `ids` and `documents` is discarded first
   * so the upsert does not throw on a duplicate id.
   *
   * Every document must carry `entityId` as its `entity_id`; a mismatch is
   * rejected before the write mutates anything. A tracking-only call
   * (`replace(entityId, [], [])`) registers the entity as indexed, matching
   * the interface contract.
   *
   * Atomicity: never awaits between the discard pass and `addDocuments`, so
   * a concurrent `search()` sees the index wholly before or wholly after,
   * never half-updated. This is the precondition the pre-extraction
   * `syncEntries` kept with its "no await from here to `addAll`" comment.
   */
  async replace(
    entityId: string,
    ids: readonly string[],
    documents: readonly IndexDocument[],
  ): Promise<void> {
    assertOwnedBy(entityId, documents);
    this.discardIds(ids, entityId);
    if (!this.entryIdsByEntity.has(entityId)) this.entryIdsByEntity.set(entityId, new Set());
    this.addDocuments(documents);
  }

  /**
   * Per-entity rebuild. Removes every id tracked under `entityId` (with the
   * `index.has(id)` guard so a stale tracking set cannot make `discard()`
   * throw), then writes `documents`. The entity stays registered as
   * indexed — even when `documents` is empty — so the next `syncEntries`
   * call can take the fast path. Every document must belong to `entityId`.
   */
  async replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void> {
    assertOwnedBy(entityId, documents);
    const previous = this.entryIdsByEntity.get(entityId);
    if (previous) this.discardIds([...previous]);
    // Registered even when empty, so hasIndexedEntity(entityId) === true.
    this.entryIdsByEntity.set(entityId, new Set());
    this.addDocuments(documents);
  }

  /**
   * Global rebuild / clear. Replaces the MiniSearch instance and clears both
   * id maps, so `hasIndexedEntity` returns `false` for every entity afterwards.
   * `SearchService.clearAll()` calls `replaceAll([])`.
   */
  async replaceAll(documents: readonly IndexDocument[]): Promise<void> {
    this.index = this.createIndex();
    this.entryIdsByEntity.clear();
    this.entityIdById.clear();
    this.addDocuments(documents);
  }

  /**
   * Best-match-first search over the documents whose `entity_id` is in
   * `options.entityIds`. `preFilterLimit` overrides `limit` (hybrid retrieval
   * uses this to over-fetch candidates before the `limit` cap). Scores are
   * raw BM25+ — `SearchService.getKeywordScores` and `searchKeyword` apply
   * any scaling, not the strategy.
   */
  async search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    if (options.entityIds.length === 0) return [];
    const entityIdSet = new Set(options.entityIds);
    const limit = options.preFilterLimit ?? options.limit;
    const raw = this.index.search(query, {
      filter: (r) => entityIdSet.has(r.entity_id as string),
      combineWith: 'OR',
    });
    // Tiebreak equal-score results by id before slicing: MiniSearch breaks
    // ties by internal insertion order, which the strategy's own
    // discard/add changes. Callers truncate to a `limit`, so the ids
    // surviving a tie at the boundary must not depend on write history.
    raw.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (!Number.isNaN(scoreDiff) && scoreDiff !== 0) return scoreDiff;
      return a.id.localeCompare(b.id);
    });
    // `storeFields: ['entity_id']` puts entity_id on every result.
    return raw.slice(0, limit).map((r) => ({
      id: r.id,
      entity_id: r.entity_id as string,
      score: r.score,
    }));
  }

  // ---- Source-store passage index (spec source-store §6) --------------------
  // A second in-heap instance over the same passage slices as the FTS5 path.

  private passageIndex: MiniSearch<PassageDoc> = this.createPassageIndex();
  private passageIdsByEntity = new Map<string, Set<string>>();
  /** Handle `reindexSourcePassages` last indexed from; `searchPassages` hydrates hits through it. */
  private passageSource: { db: SQLiteAdapter; prefix: string } | null = null;

  private createPassageIndex(): MiniSearch<PassageDoc> {
    return new MiniSearch({
      fields: ['text'],
      storeFields: ['entity_id', 'document_id'],
      autoVacuum: false, // explicit vacuum below, same reason as the facts instance (#64)
      searchOptions: { fuzzy: 0.2, prefix: true },
    });
  }

  /**
   * Re-index stored passages from SQLite: one entity, or every stored entity
   * when `entityId` is omitted (the open-time pass; up to `maxTotalChars` per
   * entity, and the heap grows with the number of stored entities, spec §6).
   * It is also the post-commit sync after forget/clearAll: deleted passages
   * drop out because the reload no longer finds their rows (spec §5).
   * Reads happen first; the discard and add are synchronous, so the swap is
   * atomic (a concurrent search sees the index wholly before or wholly after),
   * and the vacuum runs after the swap.
   */
  async reindexSourcePassages(db: SQLiteAdapter, prefix: string, entityId?: string): Promise<void> {
    this.passageSource = { db, prefix };
    const entityIds = entityId !== undefined
      ? [entityId]
      : [...new Set([
        ...(await db.getAllAsync<{ entity_id: string }>(`SELECT DISTINCT entity_id FROM ${prefix}source_documents`)).map((r) => r.entity_id),
        ...this.passageIdsByEntity.keys(),
      ])];
    for (const id of entityIds) {
      const passages = await loadStoredPassages(db, prefix, id);
      for (const old of this.passageIdsByEntity.get(id) ?? []) {
        if (this.passageIndex.has(old)) this.passageIndex.discard(old);
      }
      const ids = new Set<string>();
      for (const d of passages) { this.passageIndex.add({ ...d }); ids.add(d.id); }
      if (ids.size > 0) this.passageIdsByEntity.set(id, ids);
      else this.passageIdsByEntity.delete(id);
      if (this.passageIndex.dirtCount > 0) await this.passageIndex.vacuum();
    }
  }

  /** Best-match-first passage search over the entities in `options.entityIds`. */
  async searchPassages(query: string, options: { entityIds: string[]; limit: number }): Promise<PassageHit[]> {
    if (options.entityIds.length === 0 || !this.passageSource) return [];
    const allowed = new Set(options.entityIds);
    const raw = this.passageIndex.search(query, { filter: (r) => allowed.has(r.entity_id as string), combineWith: 'OR' });
    raw.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    // The index may hold rows deleted after it loaded; a hit counts only
    // while its source_passages row exists (spec §5). Drop dead rows BEFORE
    // slicing, so a deleted passage never consumes a limit slot a live one
    // can fill (the FTS5 path's SQL join does the same). One indexed lookup
    // per entity.
    const live = new Set<string>();
    for (const eid of options.entityIds) {
      const rows = await this.passageSource.db.getAllAsync<{ id: string }>(
        `SELECT id FROM ${this.passageSource.prefix}source_passages WHERE entity_id = ?`, [eid]);
      for (const row of rows) live.add(row.id);
    }
    const hits = raw.filter((r) => live.has(r.id as string)).slice(0, options.limit).map((r) => ({
      id: r.id as string, entity_id: r.entity_id as string, document_id: r.document_id as string, score: r.score,
    }));
    return hydratePassageHits(this.passageSource.db, this.passageSource.prefix, hits);
  }

  /**
   * Explicit vacuum. MiniSearch 7.2.0's `dirtCount` rule: search after an
   * un-vacuumed discard inverts the relative scores of term-sharing
   * documents at any index size. `SearchService.syncEntries` calls this
   * after a discard-bearing turn. No-op when `dirtCount === 0`.
   */
  async vacuum(): Promise<void> {
    if (this.index.dirtCount > 0) {
      await this.index.vacuum();
    }
  }

  /**
   * `true` when `entityId` has been indexed at least once under the current
   * strategy state. Backed by `entryIdsByEntity.has(entityId)`, which is
   * kept in sync by `addDocuments`, `replaceEntity`, and `replaceAll`.
   */
  hasIndexedEntity(entityId: string): boolean {
    return this.entryIdsByEntity.has(entityId);
  }

  /**
   * Add `documents` to the MiniSearch instance and register them in
   * `entryIdsByEntity` and `entityIdById`. MiniSearch mutates documents
   * during `add`, so each doc is copied first. `add` throws on an id the
   * index already holds — `replace` and `replaceEntity` discard first for
   * that reason.
   *
   * Adds and registers one document at a time: if a duplicate id throws
   * part-way through, every document already in the index is tracked, so
   * the next rebuild can discard it instead of failing on it again. This is
   * the precondition the per-turn recovery path relies on (#258 review).
   */
  private addDocuments(documents: readonly IndexDocument[]): void {
    for (const d of documents) {
      const doc: IndexDocument = { ...d };
      this.index.add(doc);
      const set = this.entryIdsByEntity.get(doc.entity_id) ?? new Set<string>();
      set.add(doc.id);
      this.entryIdsByEntity.set(doc.entity_id, set);
      this.entityIdById.set(doc.id, doc.entity_id);
    }
  }

  /**
   * Discard `ids` from the MiniSearch instance and from both id maps, but
   * only for ids currently owned by `entityId` (the second argument). When
   * `entityId` is omitted (used by `replaceEntity` for the bulk rebuild
   * path), every id is discarded regardless of owning entity.
   *
   * `index.has(id)` is the membership test of record: a rebuild that failed
   * between its own discard pass and the set replacement can leave the
   * tracking set claiming ids the index no longer holds — `discard()` throws
   * on those, so we guard.
   */
  private discardIds(ids: readonly string[], entityId?: string): void {
    for (const id of ids) {
      // Scope check first: an id not owned by `entityId` is silently ignored.
      // Doing the scope check before `index.discard` is what stops a
      // `replace(entityId, ids, …)` call from touching docs under any other
      // entity.
      const owning = this.entityIdById.get(id);
      if (owning === undefined) continue;
      if (entityId !== undefined && owning !== entityId) continue;
      if (this.index.has(id)) this.index.discard(id);
      this.entryIdsByEntity.get(owning)?.delete(id);
      this.entityIdById.delete(id);
    }
  }
}

/**
 * `replace` and `replaceEntity` write under one entity. A document carrying a
 * different `entity_id` would land in another entity's tracking set (and
 * have no safe discard path), so the write rejects before mutating anything.
 */
function assertOwnedBy(entityId: string, documents: readonly IndexDocument[]): void {
  for (const doc of documents) {
    if (doc.entity_id !== entityId) {
      throw new Error(
        `IndexStrategy write for entity ${entityId} got document ${doc.id} under entity ${doc.entity_id}`,
      );
    }
  }
}