/**
 * Librarian strategy seam (spec 2026-09-29 §5.1).
 *
 * The seam lets PR-B (ops librarian) plug in without `MaintenanceService`
 * editing the body. The verbatim legacy move lives in `legacy.ts`; the
 * dispatcher in `index.ts` is the only place that knows which strategies
 * exist. New strategies register there.
 *
 * `LibrarianStrategy` is the contract every implementation satisfies. The
 * pass is identified by its `(entityId, trigger, promptOverride?, meter?)`
 * context; the strategy returns what it processed so the caller can
 * advance checkpoints / watermarks.
 */

import type {
  SQLiteAdapter,
  WikiDiagnosticTrigger,
  WikiOptions,
  ExtractedFact,
  ExtractedFactEdge,
  ExtractedTask,
  ExtractedFactWithOntology,
  WikiFact,
  WikiTask,
  OntologyUpdates,
  WikiEvent,
} from '../../types';
import type { EntryRepository } from '../../repositories/EntryRepository';
import type { TaskRepository } from '../../repositories/TaskRepository';
import type { EventRepository } from '../../repositories/EventRepository';
import type { SearchService } from '../SearchService';
import type { EmbeddingService } from '../EmbeddingService';
import type { PromptService } from '../PromptService';
import type { OntologyService, TitleIndexEntry } from '../OntologyService';
import type { UsageMeter } from '../../utils/usage';

/**
 * Collaborators the legacy librarian pass needs. Exposed as a struct (not a
 * class) so PR-B can build the same deps without subclassing MaintenanceService.
 */
export interface LibrarianDeps {
  db: SQLiteAdapter;
  options: WikiOptions;
  entryRepo: EntryRepository;
  taskRepo: TaskRepository;
  eventRepo: EventRepository;
  searchService: SearchService;
  embeddingService: EmbeddingService;
  promptService: PromptService;
  ontologyService?: OntologyService;
}

/** Per-pass inputs the caller decides; the strategy cannot derive these. */
export interface LibrarianContext {
  entityId: string;
  trigger: WikiDiagnosticTrigger;
  promptOverride?: string;
  /** Optional meter (Phase C budgeted maintenance). Legacy ignores it but
   * still records usage when present via `callLlm`. */
  meter?: UsageMeter;
}

/**
 * What the strategy did. The shape is intentionally narrow: callers (lock
 * wrapper, deferred scheduler) only need to know whether work happened and
 * whether a budget error truncated it. PR-B adds its own watermark
 * semantics; the legacy `processedThrough` is the id of the newest event
 * the pass read (or null when there were no events).
 */
export interface LibrarianResult {
  /** Newest event id the pass processed, or `null` if the event log was empty. */
  processedThrough: string | null;
  /** Number of facts actually written (excludes deduped, rejected, failed-validation). */
  factsWritten: number;
  /** Set only when `callLlm` raised `WikiBudgetExhausted`. */
  budgetStop?: { requiredEstimate: number };
}

/** The strategy contract. */
export type LibrarianStrategy = (deps: LibrarianDeps, ctx: LibrarianContext) => Promise<LibrarianResult>;

// Re-exports so the legacy module doesn't have to chase deep imports. These
// keep `legacy.ts` a self-contained, byte-for-byte move.
export type {
  ExtractedFact,
  ExtractedFactEdge,
  ExtractedTask,
  ExtractedFactWithOntology,
  WikiFact,
  WikiTask,
  OntologyUpdates,
  WikiEvent,
  TitleIndexEntry,
};