// packages/core/src/services/search/fts5Sql.ts
//
// All FTS5 SQL text in one place. Spec 2026-10-05 §PR-2 revision.

export const FTS5_STATE_KEY = 'fts5_index_state';
export const FTS5_DRAIN_CHUNK = 500;

export function fts5TriggerNames(prefix: string): readonly [string, string, string] {
  return [`${prefix}entries_fts_ai`, `${prefix}entries_fts_au`, `${prefix}entries_fts_ad`];
}

/**
 * SQL twin of `toIndexDoc`'s tags handling: a JSON array becomes its elements
 * space-joined, and anything else passes through. CASE is lazily evaluated,
 * so `json_type`/`json_each` never see invalid JSON. Booleans map to
 * 'true'/'false' and null to '' to match `Array.prototype.join`.
 */
export function tagsExpr(col: string): string {
  return `CASE WHEN json_valid(${col}) THEN
      CASE WHEN json_type(${col}) = 'array' THEN
        (SELECT group_concat(CASE type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
                                       WHEN 'null' THEN '' ELSE value END, ' ')
           FROM json_each(${col}))
      ELSE ${col} END
    ELSE ${col} END`;
}

export function fts5TablesDdl(p: string): string {
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS ${p}entries_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, title, body, tags,
  tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS ${p}fts_map (
  fts_rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}fts_map_entity ON ${p}fts_map(entity_id);
CREATE TABLE IF NOT EXISTS ${p}fts_pending (
  seq INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL,
  id TEXT NOT NULL
);`;
}

export function fts5TriggersDdl(p: string): string {
  const [ai, au, ad] = fts5TriggerNames(p);
  return `
CREATE TRIGGER IF NOT EXISTS ${ai} AFTER INSERT ON ${p}entries BEGIN
  INSERT INTO ${p}fts_pending (entity_id, id) VALUES (NEW.entity_id, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS ${au}
AFTER UPDATE OF id, entity_id, title, body, tags, deleted_at ON ${p}entries BEGIN
  INSERT INTO ${p}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
  INSERT INTO ${p}fts_pending (entity_id, id)
    SELECT NEW.entity_id, NEW.id WHERE NEW.id <> OLD.id OR NEW.entity_id <> OLD.entity_id;
END;
CREATE TRIGGER IF NOT EXISTS ${ad} AFTER DELETE ON ${p}entries BEGIN
  INSERT INTO ${p}fts_pending (entity_id, id) VALUES (OLD.entity_id, OLD.id);
END;`;
}

export function drainHiSql(p: string): string {
  return `SELECT max(seq) AS hi FROM (SELECT seq FROM ${p}fts_pending ORDER BY seq LIMIT ${FTS5_DRAIN_CHUNK})`;
}

/** One drain chunk. Every statement binds `?` = hi. Run in one transaction, in order. */
export function drainChunkSql(p: string): readonly string[] {
  const chunkIds = `SELECT id FROM ${p}fts_pending WHERE seq <= ?`;
  return [
    `DELETE FROM ${p}entries_fts WHERE rowid IN (SELECT m.fts_rowid FROM ${p}fts_map m WHERE m.id IN (${chunkIds}))`,
    `DELETE FROM ${p}fts_map WHERE id IN (${chunkIds})`,
    `INSERT INTO ${p}fts_map (id, entity_id)
       SELECT e.id, e.entity_id FROM ${p}entries e WHERE e.id IN (${chunkIds}) AND e.deleted_at IS NULL`,
    `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags)
       SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ${tagsExpr('e.tags')}
       FROM ${p}fts_map m JOIN ${p}entries e ON e.id = m.id
       WHERE m.id IN (${chunkIds})`,
    `DELETE FROM ${p}fts_pending WHERE seq <= ?`,
  ];
}

/** Full rebuild from live entries. Caller empties the three tables first, in the same transaction. */
export function rebuildSql(p: string): readonly string[] {
  return [
    `INSERT INTO ${p}fts_map (id, entity_id) SELECT id, entity_id FROM ${p}entries WHERE deleted_at IS NULL`,
    `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags)
       SELECT m.fts_rowid, e.id, e.entity_id, e.title, e.body, ${tagsExpr('e.tags')}
       FROM ${p}fts_map m JOIN ${p}entries e ON e.id = m.id`,
  ];
}

/** Remove triggers and ordinary ledger tables. Never touches entries_fts (needs the fts5 module). */
export function fts5LedgerDropSql(p: string): string {
  return [
    ...fts5TriggerNames(p).map((n) => `DROP TRIGGER IF EXISTS ${n};`),
    `DROP TABLE IF EXISTS ${p}fts_pending;`,
    `DROP TABLE IF EXISTS ${p}fts_map;`,
  ].join('\n');
}
