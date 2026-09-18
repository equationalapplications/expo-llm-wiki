//! Lifecycle tests: REQ-SQL-04 schema contract validation.
//!
//! The validator is read-only: it must fail explicitly (SchemaMismatch) without
//! mutating the database. Fixtures copy the CREATE TABLE statements verbatim
//! from packages/core/src/db/schema.ts with prefix `llm_wiki_`.

use graphrag_core::schema_check::{validate_schema, validate_schema_conn};
use rusqlite::Connection;

const PREFIX: &str = "llm_wiki_";

/// Verbatim `llm_wiki_entries` DDL from packages/core/src/db/schema.ts.
const ENTRIES_DDL: &str = "CREATE TABLE IF NOT EXISTS llm_wiki_entries (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'inferred',
      source_type TEXT NOT NULL DEFAULT 'librarian_inferred',
      source_hash TEXT,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      embedding TEXT,
      embedding_blob BLOB,
      okf_type TEXT,
      ontology_checked_at INTEGER,
      heal_checked_at INTEGER,
      lifecycle_status TEXT NOT NULL DEFAULT 'stable',
      stale_after INTEGER,
      generated_by TEXT,
      last_verified_at INTEGER,
      last_verified_by TEXT,
      okf_sources TEXT,
      okf_verified TEXT,
      okf_usage_window TEXT,
      embedding_failed_at INTEGER,
      embedding_failure_kind TEXT,
      embedding_attempts INTEGER NOT NULL DEFAULT 0
    );";

/// Verbatim `llm_wiki_edges` DDL from packages/core/src/db/schema.ts.
const EDGES_DDL: &str = "CREATE TABLE IF NOT EXISTS llm_wiki_edges (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(entity_id, source_id, target_id, edge_type)
    );";

/// Verbatim `llm_wiki_meta` DDL from packages/core/src/db/schema.ts.
const META_DDL: &str = "CREATE TABLE IF NOT EXISTS llm_wiki_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );";

fn create_valid_db(conn: &Connection) {
    conn.execute_batch(&format!("{ENTRIES_DDL}\n{EDGES_DDL}\n{META_DDL}"))
        .unwrap();
    conn.execute(
        &format!("INSERT INTO {PREFIX}meta (key, value) VALUES ('schema_version', '11')"),
        [],
    )
    .unwrap();
}

#[test]
fn valid_schema_passes() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    let tx = conn.unchecked_transaction().unwrap();
    validate_schema(&tx, PREFIX).expect("valid schema must pass");
}

#[test]
fn missing_meta_row_fails() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    conn.execute(
        &format!("DELETE FROM {PREFIX}meta WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("missing marker must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn non_numeric_marker_fails() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = 'eleven' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("non-numeric marker must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn wrong_version_fails() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = '10' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("version 10 must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn missing_edges_table_fails() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!("{ENTRIES_DDL}\n{META_DDL}"))
        .unwrap();
    conn.execute(
        &format!("INSERT INTO {PREFIX}meta (key, value) VALUES ('schema_version', '11')"),
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("missing edges table must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn missing_meta_table_fails() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&format!("{ENTRIES_DDL}\n{EDGES_DDL}"))
        .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("missing meta table must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn missing_required_column_fails() {
    let conn = Connection::open_in_memory().unwrap();
    // entries without `okf_verified`.
    let broken = ENTRIES_DDL.replace("okf_verified TEXT,", "");
    conn.execute_batch(&format!("{broken}\n{EDGES_DDL}\n{META_DDL}"))
        .unwrap();
    conn.execute(
        &format!("INSERT INTO {PREFIX}meta (key, value) VALUES ('schema_version', '11')"),
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let err = validate_schema(&tx, PREFIX).expect_err("missing column must fail");
    assert!(
        matches!(err, graphrag_core::error::GraphragError::SchemaMismatch(_)),
        "expected SchemaMismatch, got {err:?}"
    );
}

#[test]
fn failed_validation_does_not_mutate_file_db() {
    // Cheap stable-within-run checksum so assertion failures stay readable.
    fn checksum(bytes: &[u8]) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        bytes.hash(&mut h);
        h.finish()
    }

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graphrag.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode = DELETE").unwrap();
    create_valid_db(&conn);
    // Extra row so we can also assert row counts are unchanged.
    conn.execute(
        &format!("INSERT INTO {PREFIX}meta (key, value) VALUES ('other_key', 'x')"),
        [],
    )
    .unwrap();
    // Break the version: this deliberate setup write is the LAST write; the
    // snapshot below is taken after it, so any diff is the validator's fault.
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = '10' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();
    drop(conn);

    let conn = Connection::open(&path).unwrap();
    let before = checksum(&std::fs::read(&path).unwrap());
    let tx = conn.unchecked_transaction().unwrap();
    assert!(validate_schema(&tx, PREFIX).is_err());
    drop(tx);
    // The connection itself must not have written anything either.
    let meta_count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {PREFIX}meta"), [], |r| {
            r.get(0)
        })
        .unwrap();
    let after_open = checksum(&std::fs::read(&path).unwrap());
    drop(conn);

    let after_closed = checksum(&std::fs::read(&path).unwrap());
    assert_eq!(
        before, after_open,
        "failed validation must not mutate the DB file"
    );
    assert_eq!(
        before, after_closed,
        "closing the connection after a failed validation must not mutate the DB file"
    );
    assert_eq!(meta_count, 2, "row counts must be unchanged");

    // Also exercise the &Connection convenience wrapper on the valid DB.
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = '11' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();
    validate_schema_conn(&conn, PREFIX).expect("wrapper must pass on valid schema");
}
