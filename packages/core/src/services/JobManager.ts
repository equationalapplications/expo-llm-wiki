import { EntityStatus, WikiBusyError, WikiBusyOperation } from '../types';

export type OperationType =
  | 'prune'
  | 'librarian'
  | 'heal'
  | 'ingest'
  | 'reembed'
  | 'global_reembed'
  | 'import'
  | 'global_import'
  | 'forget'
  | 'ontologyBackfill';

export class JobManager {
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Map<string, Set<string>>();
  /**
   * Per-(entityId, sourceHash) promise-chain lock. Serializes ingest races
   * at the application level (the v9 partial UNIQUE index enforces it at
   * the DB level as defense-in-depth). Two callers holding the same hash
   * see FIFO order; different hashes never block one another.
   *
   * Keyed `${entityId}\0${sourceHash}` so distinct (entityId, sourceHash)
   * pairs can never share a lock. A raw concatenation would let
   * ("ab", "c…") collide with ("a", "bc…"); the NUL separator makes that
   * impossible because neither component can contain NUL (entityIds are
   * user-supplied identifiers; sourceHashes are hex digests).
   */
  private hashLocks: Map<string, Promise<unknown>> = new Map();
  private statusSubscribers = new Map<
    string,
    Set<{ callback: (s: EntityStatus) => void; last: EntityStatus }>
  >();

  constructor(private prefix: string) {}

  private _hashLockKey(entityId: string, sourceHash: string): string {
    return `${entityId}\0${sourceHash}`;
  }

  /**
   * Acquire a promise-chain lock scoped to one `(entityId, sourceHash)` pair.
   * Returns a zero-argument release closure that removes the current tail
   * from the chain. Releasing is idempotent so a holder that double-fires
   * (e.g. on a finally that races an explicit release) cannot unblock
   * the next holder prematurely.
   *
   * Documented ordering: ingest acquires the hash lock FIRST, then the
   * synchronous sourceRef ingest lock, and the release closure unwinds in
   * the opposite order (sourceRef first, hash second). Hash-then-sourceRef
   * is required because the v9 partial UNIQUE index conflicts on the
   * (entity_id, source_hash) pair regardless of source_ref, so two callers
   * with DIFFERENT source_refs racing the same hash are the exact case the
   * TOCTOU race fix needs to serialize.
   *
   * Mechanics: each holder owns a private `released` promise that resolves
   * only when THIS holder calls release(). The map stores the holder's
   * `released` promise as the "tail" — the NEXT caller awaits that tail
   * via `previous = this.hashLocks.get(key)`. The current caller gets
   * their unique release function once `previous` (the prior holder's
   * release signal) settles, so each holder is guaranteed a UNIQUE release
   * closure bound to their own `released` promise.
   */
  acquireHashLock(entityId: string, sourceHash: string): Promise<() => void> {
    const key = this._hashLockKey(entityId, sourceHash);
    const previous = this.hashLocks.get(key) ?? Promise.resolve();
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
    let fired = false;
    const release = () => {
      if (fired) return;
      fired = true;
      // Unlink from the map ONLY if we are still the current tail; otherwise
      // a fresh holder has already chained a new tail and ours would race.
      if (this.hashLocks.get(key) === released) {
        this.hashLocks.delete(key);
      }
      resolveReleased();
    };
    this.hashLocks.set(key, released);
    // Wait for the prior holder to release, then hand back OUR unique closure.
    return previous.then(() => release);
  }

  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }
  private _reembedKey(entityId: string) { return `${this.prefix}:${entityId}:reembed`; }
  private _globalReembedKey() { return `${this.prefix}:reembed`; }
  private _importKey(entityId: string) { return `${this.prefix}:${entityId}:import`; }
  private _globalImportKey() { return `${this.prefix}:import`; }
  private _forgetKey(entityId: string) { return `${this.prefix}:${entityId}:forget`; }
  private _librarianKey(entityId: string) { return `${this.prefix}:${entityId}:librarian`; }
  private _healKey(entityId: string) { return `${this.prefix}:${entityId}:heal`; }
  private _ontologyBackfillKey(entityId: string) { return `${this.prefix}:${entityId}:ontologyBackfill`; }

  /**
   * Lookup table for acquireLock/releaseLock's dynamic-dispatch branch.
   * Excludes 'ingest' | 'global_reembed' | 'global_import', which those
   * methods already handle via explicit if/else branches before reaching
   * this table.
   */
  private readonly lockKeyFns: Record<
    Exclude<OperationType, 'ingest' | 'global_reembed' | 'global_import'>,
    (entityId: string) => string
  > = {
    prune: (id) => this._pruneKey(id),
    librarian: (id) => this._librarianKey(id),
    heal: (id) => this._healKey(id),
    reembed: (id) => this._reembedKey(id),
    import: (id) => this._importKey(id),
    forget: (id) => this._forgetKey(id),
    ontologyBackfill: (id) => this._ontologyBackfillKey(id),
  };

  private _isReembedActive(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._reembedKey(entityId)) ||
           this.activeMaintenanceJobs.has(this._globalReembedKey());
  }

  /**
   * True while any reembed sweep is in flight — per-entity or global.
   *
   * Read-only; acquires nothing. Callers that mutate embedding failure
   * markers across ALL entities (the dimension-promotion clear) must gate on
   * this and defer, rather than resurrect rows an in-flight sweep already
   * classified. See spec 2026-09-05-reembed-lock-scope-design.md §2.
   *
   * The global key `${prefix}:reembed` also ends in ':reembed', so the suffix
   * scan alone would already match it. The explicit check is kept because it
   * documents the intent and survives any future change to the global key's
   * format.
   */
  isAnyReembedActive(): boolean {
    return this.activeMaintenanceJobs.has(this._globalReembedKey()) ||
           this._isAnyMaintenanceActiveWithSuffix(':reembed');
  }

  private _isImportActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._importKey(entityId)) ||
           this.activeMaintenanceJobs.has(this._globalImportKey());
  }

  private _isForgetActiveFor(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._forgetKey(entityId));
  }

  private _isAnyMaintenanceActiveWithSuffix(suffix: string): boolean {
    const entityKeyPrefix = `${this.prefix}:`;
    for (const k of this.activeMaintenanceJobs) {
      if (k.startsWith(entityKeyPrefix) && k.endsWith(suffix)) return true;
    }
    return false;
  }

  private _hasIngestJob(entityId: string, sourceRef?: string): boolean {
    return this.activeIngestJobs.get(entityId)?.has(sourceRef ?? '') ?? false;
  }

  private _addIngestJob(entityId: string, sourceRef?: string): void {
    const sourceKey = sourceRef ?? '';
    let refs = this.activeIngestJobs.get(entityId);
    if (!refs) {
      refs = new Set<string>();
      this.activeIngestJobs.set(entityId, refs);
    }
    refs.add(sourceKey);
  }

  private _removeIngestJob(entityId: string, sourceRef?: string): void {
    const sourceKey = sourceRef ?? '';
    const refs = this.activeIngestJobs.get(entityId);
    if (!refs) return;
    refs.delete(sourceKey);
    if (refs.size === 0) {
      this.activeIngestJobs.delete(entityId);
    }
  }

  private _isIngestActiveFor(entityId: string): boolean {
    return this.activeIngestJobs.has(entityId);
  }

  acquireLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    let blockingOperation: WikiBusyOperation | null = null;

    if (operation !== 'global_import' && this.activeMaintenanceJobs.has(this._globalImportKey())) {
      throw new WikiBusyError('import', '*');
    }

    switch (operation) {
      case 'prune':
        if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId))) blockingOperation = 'ontologyBackfill';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'librarian':
      case 'heal':
      case 'ontologyBackfill': {
        const opKey = this.lockKeyFns[operation](entityId);
        if (this.activeMaintenanceJobs.has(opKey)) blockingOperation = operation;
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;
      }

      case 'reembed':
        if (this.activeMaintenanceJobs.has(this._reembedKey(entityId))) blockingOperation = 'reembed';
        else if (this.activeMaintenanceJobs.has(this._globalReembedKey())) blockingOperation = 'reembed';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId))) blockingOperation = 'ontologyBackfill';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'global_reembed':
        if (this.activeMaintenanceJobs.has(this._globalReembedKey())) blockingOperation = 'reembed';
        else if (this._isAnyMaintenanceActiveWithSuffix(':reembed')) blockingOperation = 'reembed';
        else if (this._isAnyMaintenanceActiveWithSuffix(':prune')) blockingOperation = 'prune';
        else if (this._isAnyMaintenanceActiveWithSuffix(':librarian')) blockingOperation = 'librarian';
        else if (this._isAnyMaintenanceActiveWithSuffix(':heal')) blockingOperation = 'heal';
        else if (this._isAnyMaintenanceActiveWithSuffix(':ontologyBackfill')) blockingOperation = 'ontologyBackfill';
        else if (this.activeIngestJobs.size > 0) blockingOperation = 'ingest';
        else if (this._isAnyMaintenanceActiveWithSuffix(':import')) blockingOperation = 'import';
        else if (this._isAnyMaintenanceActiveWithSuffix(':forget')) blockingOperation = 'forget';
        break;

      case 'import':
      case 'forget': {
        const selfKey = operation === 'import' ? this._importKey(entityId) : this._forgetKey(entityId);
        if (this.activeMaintenanceJobs.has(selfKey)) blockingOperation = operation;
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId))) blockingOperation = 'ontologyBackfill';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;
      }

      case 'global_import':
        if (this.activeMaintenanceJobs.has(this._globalImportKey())) blockingOperation = 'import';
        break;

      case 'ingest': {
        const sourceKey = sourceRef ?? '';
        if (this._hasIngestJob(entityId, sourceKey)) blockingOperation = 'ingest';
        else if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;
      }
    }

    if (blockingOperation) {
      throw new WikiBusyError(
        blockingOperation,
        operation === 'global_reembed' || operation === 'global_import' ? '*' : entityId
      );
    }

    if (operation === 'ingest') {
      this._addIngestJob(entityId, sourceRef);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.add(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.add(this._globalImportKey());
    } else {
      this.activeMaintenanceJobs.add(this.lockKeyFns[operation as Exclude<OperationType, 'ingest' | 'global_reembed' | 'global_import'>](entityId));
    }

    this._notifyStatusSubscribers(entityId);
  }

  releaseLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    if (operation === 'ingest') {
      this._removeIngestJob(entityId, sourceRef);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.delete(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.delete(this._globalImportKey());
    } else {
      this.activeMaintenanceJobs.delete(this.lockKeyFns[operation as Exclude<OperationType, 'ingest' | 'global_reembed' | 'global_import'>](entityId));
    }

    this._notifyStatusSubscribers(entityId);
  }

  /**
   * Returns true if acquireLock(operation, entityId) would throw WikiBusyError.
   * Use for non-throwing conflict checks (e.g. auto-trigger gating in write()).
   */
  isBlocked(operation: OperationType, entityId: string): boolean {
    if (operation !== 'global_import' && this.activeMaintenanceJobs.has(this._globalImportKey())) return true;

    switch (operation) {
      case 'librarian':
      case 'heal':
      case 'ontologyBackfill':
        return this.activeMaintenanceJobs.has(this.lockKeyFns[operation](entityId)) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      case 'prune':
        return this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._librarianKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._healKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isIngestActiveFor(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      case 'reembed':
        return this.activeMaintenanceJobs.has(this._reembedKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._globalReembedKey()) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._librarianKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._healKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId)) ||
               this._isIngestActiveFor(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      case 'global_reembed':
        return this.activeMaintenanceJobs.has(this._globalReembedKey()) ||
               this._isAnyMaintenanceActiveWithSuffix(':reembed') ||
               this._isAnyMaintenanceActiveWithSuffix(':prune') ||
               this._isAnyMaintenanceActiveWithSuffix(':librarian') ||
               this._isAnyMaintenanceActiveWithSuffix(':heal') ||
               this._isAnyMaintenanceActiveWithSuffix(':ontologyBackfill') ||
               this.activeIngestJobs.size > 0 ||
               this._isAnyMaintenanceActiveWithSuffix(':import') ||
               this._isAnyMaintenanceActiveWithSuffix(':forget');
      case 'import':
      case 'forget': {
        const selfKey = operation === 'import' ? this._importKey(entityId) : this._forgetKey(entityId);
        return this.activeMaintenanceJobs.has(selfKey) ||
               this.activeMaintenanceJobs.has(this._librarianKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._healKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isIngestActiveFor(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      }
      case 'global_import':
        return this.activeMaintenanceJobs.has(this._globalImportKey());
      case 'ingest':
        return this._hasIngestJob(entityId) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      default:
        return false;
    }
  }

  /**
   * Auto-heal historically only gated on the heal self-key. Keep that
   * permissiveness for write() auto-trigger paths — stricter checks stay in
   * acquireLock() — with one exception: reembed sweeps, which are excluded
   * structurally rather than by accident (see below).
   */
  tryAcquireAutoHealLock(entityId: string): boolean {
    // Heal must not run during a sweep. It is safe today only because heal
    // upserts blob-less facts and the marker clear is guarded by
    // `CASE WHEN excluded.embedding_blob IS NOT NULL` — an accident of the
    // current SQL, not a stated rule. Make the exclusion structural so a
    // future heal that carries blobs cannot silently resurrect rows an
    // in-flight sweep classified. Spec 2026-09-05 §3.3.
    //
    // A refused pass is not lost work: WriteService.maybeRunHeal holds its
    // checkpoint back, so the next write retries.
    if (this.isAnyReembedActive()) return false;

    const healKey = this._healKey(entityId);
    if (this.activeMaintenanceJobs.has(healKey)) return false;
    this.activeMaintenanceJobs.add(healKey);
    this._notifyStatusSubscribers(entityId);
    return true;
  }

  /**
   * Centralized ingest lock acquisition. Acquires the hash lock FIRST
   * (FIFO across callers racing the same hash), then the synchronous
   * sourceRef ingest lock (rejects cross-entity conflicts and busy
   * operations). Returns a single zero-argument release closure that
   * unwinds in the opposite order — sourceRef first, hash second — so
   * the sourceRef lock is freed the instant its work is done and only
   * the hash lock keeps serializing the duplicate-content race window.
   *
   * On a sourceRef conflict (WikiBusyError thrown synchronously by the
   * underlying acquireLock) the hash lock is released BEFORE the error
   * propagates, so the next caller in the hash chain is not held up by
   * a request that never reached the DB.
   */
  async acquireIngestLocks(
    entityId: string,
    sourceRef: string,
    sourceHash: string,
  ): Promise<() => void> {
    const releaseHash = await this.acquireHashLock(entityId, sourceHash);
    let sourceLockAcquired = false;
    try {
      this.acquireLock('ingest', entityId, sourceRef);
      sourceLockAcquired = true;
    } catch (err) {
      releaseHash();
      throw err;
    }
    return () => {
      try {
        if (sourceLockAcquired) this.releaseLock('ingest', entityId, sourceRef);
      } finally {
        releaseHash();
      }
    };
  }

  /**
   * Validates then acquires global + per-entity import locks atomically.
   * Validates all entities before acquiring any lock (same as current importDump semantics).
   */
  acquireImportLocks(entityIds: string[]): void {
    for (const entityId of entityIds) {
      if (this.activeMaintenanceJobs.has(this._importKey(entityId))) throw new WikiBusyError('import', entityId);
      if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) throw new WikiBusyError('librarian', entityId);
      if (this.activeMaintenanceJobs.has(this._healKey(entityId))) throw new WikiBusyError('heal', entityId);
      if (this.activeMaintenanceJobs.has(this._ontologyBackfillKey(entityId))) throw new WikiBusyError('ontologyBackfill', entityId);
      if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) throw new WikiBusyError('prune', entityId);
      if (this._isReembedActive(entityId)) throw new WikiBusyError('reembed', entityId);
      if (this._isIngestActiveFor(entityId)) throw new WikiBusyError('ingest', entityId);
      if (this._isForgetActiveFor(entityId)) throw new WikiBusyError('forget', entityId);
    }
    if (this.activeMaintenanceJobs.has(this._globalImportKey())) throw new WikiBusyError('import', '*');

    this.activeMaintenanceJobs.add(this._globalImportKey());
    for (const entityId of entityIds) {
      this.activeMaintenanceJobs.add(this._importKey(entityId));
    }
  }

  releaseImportLocks(entityIds: string[]): void {
    this.activeMaintenanceJobs.delete(this._globalImportKey());
    for (const entityId of entityIds) {
      this.activeMaintenanceJobs.delete(this._importKey(entityId));
    }
  }

  getEntityStatus(entityId: string): EntityStatus {
    return {
      ingesting: this._isIngestActiveFor(entityId),
      librarian: this.activeMaintenanceJobs.has(this._librarianKey(entityId)),
      heal: this.activeMaintenanceJobs.has(this._healKey(entityId)),
    };
  }

  subscribeEntityStatus(entityId: string, callback: (status: EntityStatus) => void): () => void {
    const initial = this.getEntityStatus(entityId);
    let set = this.statusSubscribers.get(entityId);
    if (!set) {
      set = new Set();
      this.statusSubscribers.set(entityId, set);
    }

    const entry = { callback, last: this._copyEntityStatus(initial) };
    set.add(entry);

    try {
      callback(this._copyEntityStatus(initial));
    } catch (err) {
      console.error(`[JobManager] callback error for entityId="${entityId}" during initial emission`, err);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const s = this.statusSubscribers.get(entityId);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) this.statusSubscribers.delete(entityId);
    };
  }

  private _copyEntityStatus(s: EntityStatus): EntityStatus {
    return { ingesting: s.ingesting, librarian: s.librarian, heal: s.heal };
  }

  private _notifyStatusSubscribers(entityId: string): void {
    if (entityId === '*') return;

    const set = this.statusSubscribers.get(entityId);
    if (!set || set.size === 0) return;

    for (const entry of Array.from(set)) {
      if (!set.has(entry)) continue;
      const next = this.getEntityStatus(entityId);

      if (entry.last.ingesting === next.ingesting &&
          entry.last.librarian === next.librarian &&
          entry.last.heal === next.heal) {
        continue;
      }

      entry.last = this._copyEntityStatus(next);
      try {
        entry.callback(this._copyEntityStatus(next));
      } catch (err) {
        console.error(`[JobManager] callback error for entityId="${entityId}" during transition emission`, err);
      }
    }
  }
}
