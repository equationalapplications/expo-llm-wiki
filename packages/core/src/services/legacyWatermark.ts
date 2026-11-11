import type { SQLiteAdapter } from '../types';
import type { EventRepository } from '../repositories/EventRepository';
import { START_OF_LOG_WATERMARK, type LibrarianWatermark, type MetadataRepository } from '../repositories/MetadataRepository';

/**
 * The one definition of "where legacy stopped" (spec 2026-09-29 §10.3):
 * anchor the watermark at the event at offset `min(checkpoint, total) - 1`.
 * Writes nothing and returns null when there is no legacy history or no
 * such event; each caller picks its own fallback.
 */
export async function anchorAtLegacyBoundary(
  metadataRepo: MetadataRepository,
  eventRepo: EventRepository,
  entityId: string,
  checkpoint: number,
  total: number,
  db: SQLiteAdapter,
): Promise<LibrarianWatermark | null> {
  if (checkpoint <= 0 || total <= 0) return null;
  const ev = await eventRepo.getAtOffset(entityId, Math.min(checkpoint, total) - 1, db);
  if (!ev) return null;
  const wm = { at: ev.created_at, id: ev.id };
  await metadataRepo.setLibrarianWatermark(entityId, wm, db);
  return wm;
}

/**
 * Seed the watermark from `memory_checkpoint` when none exists, and return
 * the watermark in force afterwards (null when there is no legacy history).
 * A checkpoint above the event count is drift left by an older prune, not
 * legacy history, so it gets {@link START_OF_LOG_WATERMARK} rather than the
 * newest event (spec ops-auto-first-batch §2). Must run before anything is
 * inserted that could shift the offset (spec import-clamp-created-at §1).
 */
export async function seedLegacyWatermark(
  metadataRepo: MetadataRepository,
  eventRepo: EventRepository,
  entityId: string,
  db: SQLiteAdapter,
): Promise<LibrarianWatermark | null> {
  const existing = await metadataRepo.getLibrarianWatermark(entityId, db);
  if (existing) return existing;
  const memory = (await metadataRepo.getCheckpoint(entityId, db)).memory ?? 0;
  if (memory <= 0) return null;
  const total = await eventRepo.count(entityId, db);
  if (memory > total) {
    await metadataRepo.setLibrarianWatermark(entityId, START_OF_LOG_WATERMARK, db);
    return START_OF_LOG_WATERMARK;
  }
  return anchorAtLegacyBoundary(metadataRepo, eventRepo, entityId, memory, total, db);
}
