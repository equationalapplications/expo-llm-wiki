import { EntityStatus, WikiBusyError } from '../types';

export type OperationType =
  | 'prune'
  | 'librarian'
  | 'heal'
  | 'ingest'
  | 'reembed'
  | 'global_reembed'
  | 'import'
  | 'global_import'
  | 'forget';

export class JobManager {
  private activeMaintenanceJobs = new Set<string>();
  private activeIngestJobs = new Set<string>();
  private statusSubscribers = new Map<
    string,
    Set<{ callback: (s: EntityStatus) => void; last: EntityStatus }>
  >();

  constructor(private prefix: string) {}

  private _pruneKey(entityId: string) { return `${this.prefix}:${entityId}:prune`; }
  private _reembedKey(entityId: string) { return `${this.prefix}:${entityId}:reembed`; }
  private _globalReembedKey() { return `${this.prefix}:reembed`; }
  private _importKey(entityId: string) { return `${this.prefix}:${entityId}:import`; }
  private _globalImportKey() { return `${this.prefix}:import`; }
  private _forgetKey(entityId: string) { return `${this.prefix}:${entityId}:forget`; }
  private _librarianKey(entityId: string) { return `${this.prefix}:${entityId}:librarian`; }
  private _healKey(entityId: string) { return `${this.prefix}:${entityId}:heal`; }

  private _isReembedActive(entityId: string): boolean {
    return this.activeMaintenanceJobs.has(this._reembedKey(entityId)) ||
           this.activeMaintenanceJobs.has(this._globalReembedKey());
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

  private _isIngestActiveFor(entityId: string): boolean {
    const entityKeyPrefix = `${this.prefix}:${entityId}:`;
    for (const k of this.activeIngestJobs) {
      if (k.startsWith(entityKeyPrefix)) return true;
    }
    return false;
  }

  acquireLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    let blockingOperation: string | null = null;

    if (operation !== 'global_import' && this.activeMaintenanceJobs.has(this._globalImportKey())) {
      throw new WikiBusyError('import', '*');
    }

    switch (operation) {
      case 'prune':
        if (this.activeMaintenanceJobs.has(this._pruneKey(entityId))) blockingOperation = 'prune';
        else if (this.activeMaintenanceJobs.has(this._librarianKey(entityId))) blockingOperation = 'librarian';
        else if (this.activeMaintenanceJobs.has(this._healKey(entityId))) blockingOperation = 'heal';
        else if (this._isReembedActive(entityId)) blockingOperation = 'reembed';
        else if (this._isIngestActiveFor(entityId)) blockingOperation = 'ingest';
        else if (this._isImportActiveFor(entityId)) blockingOperation = 'import';
        else if (this._isForgetActiveFor(entityId)) blockingOperation = 'forget';
        break;

      case 'librarian':
      case 'heal': {
        const opKey = operation === 'librarian' ? this._librarianKey(entityId) : this._healKey(entityId);
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
        const ingestJobKey = `${this.prefix}:${entityId}:${sourceRef}`;
        if (this.activeIngestJobs.has(ingestJobKey)) blockingOperation = 'ingest';
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
      this.activeIngestJobs.add(`${this.prefix}:${entityId}:${sourceRef}`);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.add(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.add(this._globalImportKey());
    } else {
      const keyFnName = `_${operation}Key` as keyof this;
      const keyFn = this[keyFnName] as (id: string) => string;
      this.activeMaintenanceJobs.add(keyFn.call(this, entityId));
    }

    this._notifyStatusSubscribers(entityId);
  }

  releaseLock(operation: OperationType, entityId: string, sourceRef?: string): void {
    if (operation === 'ingest') {
      this.activeIngestJobs.delete(`${this.prefix}:${entityId}:${sourceRef}`);
    } else if (operation === 'global_reembed') {
      this.activeMaintenanceJobs.delete(this._globalReembedKey());
    } else if (operation === 'global_import') {
      this.activeMaintenanceJobs.delete(this._globalImportKey());
    } else {
      const keyFnName = `_${operation}Key` as keyof this;
      const keyFn = this[keyFnName] as (id: string) => string;
      this.activeMaintenanceJobs.delete(keyFn.call(this, entityId));
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
        return this.activeMaintenanceJobs.has(this._librarianKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      case 'heal':
        return this.activeMaintenanceJobs.has(this._healKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      case 'prune':
        return this.activeMaintenanceJobs.has(this._pruneKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._librarianKey(entityId)) ||
               this.activeMaintenanceJobs.has(this._healKey(entityId)) ||
               this._isReembedActive(entityId) ||
               this._isIngestActiveFor(entityId) ||
               this._isImportActiveFor(entityId) ||
               this._isForgetActiveFor(entityId);
      default:
        return false;
    }
  }

  /**
   * Auto-heal historically only gated on the heal self-key. Keep that behavior
   * for write() auto-trigger paths while preserving stricter checks in acquireLock().
   */
  tryAcquireAutoHealLock(entityId: string): boolean {
    const healKey = this._healKey(entityId);
    if (this.activeMaintenanceJobs.has(healKey)) return false;
    this.activeMaintenanceJobs.add(healKey);
    this._notifyStatusSubscribers(entityId);
    return true;
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
