import type { SQLiteAdapter, MemoryBundle, MemoryDump, WikiFact } from '../types';
import type { EntryRepository } from '../repositories/EntryRepository';
import type { TaskRepository } from '../repositories/TaskRepository';
import type { EventRepository } from '../repositories/EventRepository';
import type { EdgeRepository } from '../repositories/EdgeRepository';
import { entitySummaryMetaKey, type MetadataRepository } from '../repositories/MetadataRepository';
import type { SearchService } from './SearchService';
import type { JobManager } from './JobManager';
import type { EmbeddingService } from './EmbeddingService';
import { clip, normalizeSourceRef } from '../utils/pure';

const MAX_EMBEDDING_BLOB_BYTES = 32 * 1024; // 8192-dim float32 ceiling
const IMPORT_TITLE_MAX = 500;
const IMPORT_BODY_MAX = 8000;

export class ImportExportService {
  constructor(
    private db: SQLiteAdapter,
    private entryRepo: EntryRepository,
    private taskRepo: TaskRepository,
    private eventRepo: EventRepository,
    private edgeRepo: EdgeRepository,
    private metadataRepo: MetadataRepository,
    private searchService: SearchService,
    private jobManager: JobManager,
    private embeddingService: EmbeddingService,
  ) {}

  async exportDump(entityIds?: string[]): Promise<MemoryDump> {
    let ids: string[];
    if (entityIds && entityIds.length > 0) {
      ids = Array.from(new Set(entityIds));
    } else {
      ids = await this.metadataRepo.getDistinctEntityIds();
    }

    const entities: Record<string, MemoryBundle> = {};
    const BATCH = 3;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(
          async (id): Promise<[string, MemoryBundle]> => [
            id,
            await this.getFullBundle(id, { includeBlobs: true }),
          ],
        ),
      );
      for (const [id, bundle] of batchResults) {
        entities[id] = bundle;
      }
    }

    return { generatedAt: Date.now(), entities };
  }

  async importDump(
    dump: MemoryDump,
    opts?: { merge?: boolean },
  ): Promise<void> {
    const merge = opts?.merge ?? false;
    const entityIds = Object.keys(dump.entities);

    this.jobManager.acquireImportLocks(entityIds);
    try {
      await this.assertNoLegacySourceTypes();
      for (const [entityId, bundle] of Object.entries(dump.entities)) {
        await this.doImportEntity(entityId, bundle, merge);
      }
    } finally {
      this.jobManager.releaseImportLocks(entityIds);
    }
  }

  async getFullBundle(
    entityId: string,
    opts?: { maxEvents?: number; includeBlobs?: boolean },
  ): Promise<MemoryBundle> {
    const [factsRaw, tasks, events, edges, summaryValue] = await Promise.all([
      opts?.includeBlobs
        ? this.entryRepo.findAllByEntityIdWithBlobs(entityId)
        : this.entryRepo.findAllByEntityId(entityId),
      this.taskRepo.findAllByEntityId(entityId),
      this.eventRepo.getByEntityId(entityId, opts?.maxEvents),
      this.edgeRepo.getByEntityId(entityId),
      this.metadataRepo.getMeta(entitySummaryMetaKey(entityId)),
    ]);

    const facts = factsRaw.map((f) => {
      const {
        embedding: _embedding,
        embedding_blob,
        ...rest
      } = f as WikiFact & { embedding?: unknown; embedding_blob?: Uint8Array };
      const safeBlobCopy =
        opts?.includeBlobs && embedding_blob
          ? (() => {
              const c = new ArrayBuffer(embedding_blob.byteLength);
              new Uint8Array(c).set(embedding_blob);
              return new Uint8Array(c);
            })()
          : undefined;

      const factBase = safeBlobCopy
        ? { ...rest, embedding_blob: safeBlobCopy }
        : rest;
      return {
        ...factBase,
        tags:
          typeof factBase.tags === 'string'
            ? JSON.parse(factBase.tags)
            : factBase.tags,
      };
    });

    return {
      facts,
      tasks,
      events,
      edges,
      ...(summaryValue != null ? { summary: summaryValue } : {}),
    };
  }

  /** Single-entity import transaction + post-processing; package-internal hook for tests. */
  async doImportEntity(
    entityId: string,
    bundle: MemoryBundle,
    merge: boolean,
  ): Promise<void> {
    const upsertedFactIds = new Set<string>();
    const upsertedDeletedFactIds = new Set<string>();
    const factsWithPreservedBlob = new Map<string, Uint8Array>();
    const preservedBlobDims = new Set<number>();
    const softDeletedFactIds: string[] = [];
    const clippedTextByFactId = new Map<string, { title: string; body: string }>();

    await this.db.withTransactionAsync(async (tx) => {
      if (!merge) {
        const deletedLiveFactIds = await this.entryRepo.findIdsBySource(
          entityId,
          null,
          null,
          tx,
          false,
        );
        softDeletedFactIds.push(...deletedLiveFactIds);
        await this.entryRepo.bulkSoftDeleteByEntityId(entityId, tx);
        await this.taskRepo.bulkSoftDeleteByEntityId(entityId, tx);
        await this.edgeRepo.bulkDeleteByEntityId(entityId, tx);
        await this.metadataRepo.deleteCheckpoint(entityId, tx);
      }

      if (bundle.summary !== undefined) {
        await this.metadataRepo.setMeta(entitySummaryMetaKey(entityId), bundle.summary, tx);
      } else if (!merge) {
        await this.metadataRepo.deleteMeta(entitySummaryMetaKey(entityId), tx);
      }

      const factIds = bundle.facts.map((fact) => fact.id);
      const existingFactsById = new Map<
        string,
        { id: string; entity_id: string; updated_at: number }
      >();
      const existingFacts = await this.entryRepo.findExistingMetadataByIds(
        factIds,
        tx,
      );
      for (const existingFact of existingFacts) {
        existingFactsById.set(existingFact.id, existingFact);
      }

      for (const fact of bundle.facts) {
        const sourceType = this._normalizeImportedSourceType(
          String(fact.source_type),
          {
            entityId,
            factId: fact.id,
          },
        );

        const safeUpdatedAt = Number.isFinite(fact.updated_at)
          ? fact.updated_at
          : 0;
        const existing = existingFactsById.get(fact.id);

        const rawBlobRaw = (fact as WikiFact & { embedding_blob?: unknown })
          .embedding_blob;
        let rawBlob: Uint8Array | null = null;

        if (rawBlobRaw instanceof Uint8Array) {
          if (rawBlobRaw.byteLength <= MAX_EMBEDDING_BLOB_BYTES) {
            rawBlob = rawBlobRaw;
          }
        } else if (
          rawBlobRaw !== null &&
          rawBlobRaw !== undefined &&
          typeof rawBlobRaw === 'object'
        ) {
          const obj = rawBlobRaw as Record<string, unknown>;
          if (obj['type'] === 'Buffer' && Array.isArray(obj['data'])) {
            const data = obj['data'] as number[];
            if (data.length <= MAX_EMBEDDING_BLOB_BYTES) {
              rawBlob = new Uint8Array(data);
            }
          } else if (!Array.isArray(rawBlobRaw)) {
            const entries = Object.keys(obj);
            if (entries.length > 0 && entries.every((k) => /^\d+$/.test(k))) {
              const len = entries.length;
              if (len <= MAX_EMBEDDING_BLOB_BYTES) {
                rawBlob = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  rawBlob[i] = (obj[String(i)] as number) ?? 0;
                }
              }
            }
          }
        }

        if (rawBlob !== null && rawBlob.byteLength > MAX_EMBEDDING_BLOB_BYTES) {
          rawBlob = null; // Oversized blob — drop and let the fact re-embed normally.
        }

        let blobData: Uint8Array | null = null;
        if (
          rawBlob !== null &&
          rawBlob.byteLength > 0 &&
          rawBlob.byteLength % 4 === 0
        ) {
          const copy = new ArrayBuffer(rawBlob.byteLength);
          const alignedBlob = new Uint8Array(copy);
          alignedBlob.set(rawBlob);
          const floats = new Float32Array(copy, 0, rawBlob.byteLength / 4);

          let allFinite = true;
          for (let i = 0; i < floats.length; i++) {
            if (!isFinite(floats[i])) {
              allFinite = false;
              break;
            }
          }
          if (allFinite) {
            blobData = alignedBlob;
          }
        }

        if (existing) {
          if (existing.entity_id !== entityId) {
            this._warnCrossEntityCollision(
              'entry',
              fact.id,
              existing.entity_id,
              entityId,
            );
            continue;
          }
          if (merge && safeUpdatedAt <= existing.updated_at) continue;
        }

        const safeTitle = clip(String(fact.title ?? ''), IMPORT_TITLE_MAX);
        const safeBody = clip(String(fact.body ?? ''), IMPORT_BODY_MAX);
        clippedTextByFactId.set(fact.id, { title: safeTitle, body: safeBody });

        // Normalize source_ref using the same rules as ingestDocument and the
        // startup migration. Persisting the raw value would let a later re-ingest
        // collide on shape mismatch (raw DB ref vs. normalized incoming ref) and
        // would skip soft-deletion on the default-path overwrite.
        // A non-null source_ref that normalizes to null (e.g. all-special-chars
        // or whitespace-only) is rejected to mirror ingestDocument — silently
        // coercing it to NULL would create a legacy row that many APIs
        // intentionally exclude.
        let normalizedSourceRef: string | null = null;
        if (fact.source_ref !== null && fact.source_ref !== undefined) {
          normalizedSourceRef = normalizeSourceRef(fact.source_ref);
          if (normalizedSourceRef === null) {
            throw new Error(
              `importDump: invalid source_ref ${JSON.stringify(fact.source_ref)} ` +
              `for entity "${entityId}" fact "${fact.id}" ` +
              `(must normalize to a non-empty string; see ingestDocument's sourceRef validation)`,
            );
          }
        }

        const factObj: WikiFact = {
          id: fact.id,
          entity_id: entityId,
          title: safeTitle,
          body: safeBody,
          tags: Array.isArray(fact.tags) ? fact.tags : [],
          confidence: fact.confidence,
          source_type: sourceType,
          source_hash: fact.source_hash,
          source_ref: normalizedSourceRef,
          created_at: fact.created_at,
          updated_at: safeUpdatedAt,
          last_accessed_at: fact.last_accessed_at,
          access_count: fact.access_count,
          deleted_at: fact.deleted_at,
          embedding_blob: blobData ?? undefined,
          okf_type: fact.okf_type ?? null,
          // OKF v0.2 — forwarded as-is; parseOkfBundle / the caller is responsible for
          // populating these per spec, importDump does not derive or validate them.
          lifecycle_status: fact.lifecycle_status ?? 'stable',
          stale_after: fact.stale_after ?? null,
          generated_by: fact.generated_by ?? null,
          okf_sources: fact.okf_sources ?? [],
          okf_verified: fact.okf_verified ?? [],
          okf_usage_window: fact.okf_usage_window ?? null,
          last_verified_at: fact.last_verified_at ?? null,
          last_verified_by: fact.last_verified_by ?? null,
        };

        await this.entryRepo.upsertForImport(factObj, tx);

        if (blobData != null) {
          factsWithPreservedBlob.set(fact.id, blobData);
          if (!fact.deleted_at) preservedBlobDims.add(blobData.byteLength / 4);
        }

        existingFactsById.set(fact.id, {
          id: fact.id,
          entity_id: entityId,
          updated_at: safeUpdatedAt,
        });
        upsertedFactIds.add(fact.id);
        if (fact.deleted_at) upsertedDeletedFactIds.add(fact.id);
      }

      const taskIds = bundle.tasks.map((task) => task.id);
      const existingTasksById = new Map<
        string,
        { id: string; entity_id: string; updated_at: number }
      >();
      const existingTasks = await this.taskRepo.findExistingMetadataByIds(
        taskIds,
        tx,
      );

      for (const existingTask of existingTasks) {
        existingTasksById.set(existingTask.id, existingTask);
      }

      for (const task of bundle.tasks) {
        const safeUpdatedAt = Number.isFinite(task.updated_at)
          ? task.updated_at
          : 0;
        const existing = existingTasksById.get(task.id);

        if (existing) {
          if (existing.entity_id !== entityId) {
            this._warnCrossEntityCollision(
              'task',
              task.id,
              existing.entity_id,
              entityId,
            );
            continue;
          }
          if (merge && safeUpdatedAt <= existing.updated_at) continue;
        }

        await this.taskRepo.upsertForImport(
          {
            id: task.id,
            entity_id: entityId,
            description: task.description,
            status: task.status,
            priority: task.priority,
            created_at: task.created_at,
            updated_at: safeUpdatedAt,
            resolved_at: task.resolved_at,
            deleted_at: task.deleted_at,
            okf_type: task.okf_type ?? null,
            // OKF v0.2
            lifecycle_status: task.lifecycle_status ?? 'stable',
            stale_after: task.stale_after ?? null,
            generated_by: task.generated_by ?? null,
            okf_sources: task.okf_sources ?? [],
            okf_verified: task.okf_verified ?? [],
            okf_usage_window: task.okf_usage_window ?? null,
            last_verified_at: task.last_verified_at ?? null,
            last_verified_by: task.last_verified_by ?? null,
          },
          tx,
          safeUpdatedAt,
        );

        existingTasksById.set(task.id, {
          id: task.id,
          entity_id: entityId,
          updated_at: safeUpdatedAt,
        });
      }

      for (const event of bundle.events) {
        await this.eventRepo.addIgnoreDuplicate(
          {
            id: event.id,
            entity_id: entityId,
            event_type: event.event_type,
            summary: event.summary,
            related_entry_id: event.related_entry_id ?? null,
            created_at: event.created_at,
          },
          tx,
        );
      }

      for (const edge of bundle.edges ?? []) {
        await this.edgeRepo.addIgnoreDuplicate(
          {
            id: edge.id,
            entity_id: entityId,
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: edge.edge_type,
            created_at: edge.created_at,
          },
          tx,
        );
      }
    });

    await this.searchService.sync(entityId);

    for (const fact of bundle.facts) {
      if (
        !fact.deleted_at &&
        upsertedFactIds.has(fact.id) &&
        !factsWithPreservedBlob.has(fact.id)
      ) {
        const clipped = clippedTextByFactId.get(fact.id);
        const embedded = await this.embeddingService.embedFact({
          id: fact.id,
          entity_id: entityId,
          title: clipped?.title ?? fact.title,
          body: clipped?.body ?? fact.body,
          tags:
            Array.isArray(fact.tags) || typeof fact.tags === 'string'
              ? fact.tags
              : [],
        });
        if (!embedded) {
          await this.embeddingService.notifyEmbeddingPersisted(entityId, fact.id, null);
        }
      }
    }

    for (const fact of bundle.facts) {
      const blobData = factsWithPreservedBlob.get(fact.id);
      if (blobData && !fact.deleted_at && upsertedFactIds.has(fact.id)) {
        try {
          const float32Vector = new Float32Array(
            blobData.buffer,
            blobData.byteOffset,
            blobData.byteLength / 4,
          );
          await this.embeddingService.notifyEmbeddingPersisted(
            entityId,
            fact.id,
            float32Vector,
          );
        } catch (hookErr) {
          console.warn(
            `[WikiMemory] onEmbeddingPersisted hook failed for preserved-blob fact ${fact.id}:`,
            hookErr,
          );
        }
      }
    }

    for (const factId of softDeletedFactIds) {
      if (!upsertedFactIds.has(factId) || upsertedDeletedFactIds.has(factId)) {
        try {
          await this.embeddingService.notifyEmbeddingPersisted(
            entityId,
            factId,
            null,
          );
        } catch (hookErr) {
          console.warn(
            `[WikiMemory] onEmbeddingPersisted(vector=null) hook failed for soft-deleted fact ${factId}:`,
            hookErr,
          );
        }
      }
    }

    try {
      const canonicalDimValue = await this.metadataRepo.getMeta(
        'embedding_dimension',
      );
      const canonicalDim = canonicalDimValue
        ? parseInt(canonicalDimValue, 10)
        : null;

      if (preservedBlobDims.size === 1) {
        const preservedDim = [...preservedBlobDims][0];
        if (canonicalDim === null || canonicalDim === preservedDim) {
          await this.embeddingService.storeEmbeddingDimension(preservedDim);
          const staleMismatchValue = await this.metadataRepo.getMeta(
            'embedding_dimension_mismatch',
          );
          if (
            staleMismatchValue &&
            parseInt(staleMismatchValue, 10) !== preservedDim
          ) {
            await this.metadataRepo.setMeta(
              'embedding_dimension_mismatch',
              String(preservedDim),
              this.db,
            );
          }
          await this.embeddingService.reconcileEmbeddingDimension();
        } else {
          await this.metadataRepo.setMeta(
            'embedding_dimension_mismatch',
            String(canonicalDim),
            this.db,
          );
        }
      } else if (preservedBlobDims.size > 1) {
        if (canonicalDim === null) {
          const sortedPreservedBlobDims = [...preservedBlobDims].sort(
            (a, b) => a - b,
          );
          await this.embeddingService.storeEmbeddingDimension(
            sortedPreservedBlobDims[0],
          );
          await this.metadataRepo.setMeta(
            'embedding_dimension_mismatch',
            String(sortedPreservedBlobDims[0]),
            this.db,
          );
        } else {
          await this.metadataRepo.setMeta(
            'embedding_dimension_mismatch',
            String(canonicalDim),
            this.db,
          );
        }
      }
    } finally {
      this.searchService.evictCache(entityId);
    }
  }

  private _warnCrossEntityCollision(
    type: 'entry' | 'task',
    id: string,
    existingEntityId: string,
    targetEntityId: string,
  ): void {
    console.warn(
      `[WikiMemory] importDump: ${type} id ${JSON.stringify(id)} already belongs to entity ` +
        `${JSON.stringify(existingEntityId)}; skipping for entity ${JSON.stringify(targetEntityId)}`,
    );
  }

  private _normalizeImportedSourceType(
    raw: string,
    ctx?: { entityId: string; factId: string },
  ): WikiFact['source_type'] {
    if (raw === 'user_document') return 'immutable_document';
    if (raw === 'agent_inferred') return 'librarian_inferred';

    const allowed: WikiFact['source_type'][] = [
      'user_stated',
      'librarian_inferred',
      'user_confirmed',
      'immutable_document',
    ];
    if ((allowed as string[]).includes(raw))
      return raw as WikiFact['source_type'];

    const where =
      ctx !== undefined
        ? ` for entity "${ctx.entityId}" fact "${ctx.factId}"`
        : '';
    throw new Error(
      `importDump: invalid source_type "${raw}"${where} (expected one of: ${allowed.join(', ')}, or legacy aliases user_document / agent_inferred)`,
    );
  }

  public async assertNoLegacySourceTypes(): Promise<void> {
    if (!(await this.entryRepo.hasLegacySourceTypes())) return;

    const count = await this.entryRepo.countLegacySourceTypes();
    throw new Error(
      `Database contains ${count} entries with legacy source_type values ('user_document' or 'agent_inferred'). ` +
        `These enum values were renamed in this release. Running without migration would allow legacy 'user_document' facts to bypass ` +
        `immutability guards, causing data corruption.\n\n${this.entryRepo.getLegacyMigrationSQL()}\n\n` +
        `After running the migration SQL, restart your application.`,
    );
  }
}
