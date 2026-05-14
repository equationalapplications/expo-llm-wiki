/**
 * Abstract base for all repositories.
 * Provides db accessor + prefix-aware helpers.
 */
export abstract class BaseRepository {
  protected db: import('../types').SQLiteAdapter;
  protected prefix: string;

  constructor(db: import('../types').SQLiteAdapter, prefix: string) {
    this.db = db;
    this.prefix = prefix;
  }

  /**
   * Return the DB executor for a given transaction handle.
   * If tx is provided, use it; otherwise fall back to this.db.
   */
  protected getExecutor(tx?: import('../types').SQLiteAdapter): import('../types').SQLiteAdapter {
    return tx ?? this.db;
  }
}
