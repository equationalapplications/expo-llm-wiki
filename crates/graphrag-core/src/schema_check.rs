//! Schema contract validation (REQ-SQL-04).
//!
//! Validates that a host-supplied SQLite database matches the schema contract
//! of packages/core (core 7.1.3): the tables and columns the engine reads must
//! exist, and the `{prefix}meta` marker row `schema_version` must equal
//! [`REQUIRED_SCHEMA_VERSION`].
//!
//! Read-only by construction: the validator only issues `SELECT`s and
//! `PRAGMA table_info` reads. It never creates tables, never runs migrations,
//! and never writes. On any mismatch it fails explicitly with
//! [`GraphragError::SchemaMismatch`], leaving the database unchanged.

use crate::error::GraphragError;
use rusqlite::Transaction;

/// Core 7.1.3 `CURRENT_SCHEMA_VERSION` (packages/core/src/db/migrations.ts).
pub const REQUIRED_SCHEMA_VERSION: i64 = 11;

/// Required columns of `{prefix}entries` (schema.ts, verbatim names).
const REQUIRED_ENTRIES_COLUMNS: &[&str] = &[
    "id",
    "entity_id",
    "confidence",
    "source_type",
    "updated_at",
    "deleted_at",
    "title",
    "body",
    "tags",
    "source_hash",
    "source_ref",
    "created_at",
    "last_accessed_at",
    "access_count",
    "okf_type",
    "lifecycle_status",
    "stale_after",
    "generated_by",
    "okf_sources",
    "okf_verified",
    "okf_usage_window",
    "last_verified_at",
    "last_verified_by",
];

/// Required columns of `{prefix}edges` (schema.ts, verbatim names).
const REQUIRED_EDGES_COLUMNS: &[&str] = &[
    "id",
    "entity_id",
    "source_id",
    "target_id",
    "edge_type",
    "created_at",
];

/// Validate the schema contract against an open transaction.
///
/// Fails with [`GraphragError::SchemaMismatch`] when a required table/column is
/// missing or the `{prefix}meta.schema_version` marker is absent, unreadable,
/// or not equal to [`REQUIRED_SCHEMA_VERSION`]. Performs no writes.
pub fn validate_schema(tx: &Transaction<'_>, prefix: &str) -> Result<(), GraphragError> {
    validate_schema_conn(tx, prefix)
}

/// Same contract check against a bare connection (host convenience wrapper).
pub fn validate_schema_conn(
    conn: &rusqlite::Connection,
    prefix: &str,
) -> Result<(), GraphragError> {
    check_table_columns(conn, prefix, "entries", REQUIRED_ENTRIES_COLUMNS)?;
    check_table_columns(conn, prefix, "edges", REQUIRED_EDGES_COLUMNS)?;
    check_marker(conn, prefix)
}

/// Assert every listed column exists on `{prefix}{table}` via `PRAGMA table_info`.
fn check_table_columns(
    conn: &rusqlite::Connection,
    prefix: &str,
    table: &str,
    required: &[&str],
) -> Result<(), GraphragError> {
    let full_table = format!("{prefix}{table}");
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({full_table})"))
        .map_err(mismatch(&full_table, "table missing or unreadable"))?;
    let mut found: Vec<String> = Vec::new();
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(mismatch(&full_table, "table missing or unreadable"))?;
    for row in rows {
        found.push(row.map_err(mismatch(&full_table, "column read failed"))?);
    }
    for col in required {
        if !found.iter().any(|c| c == col) {
            return Err(GraphragError::SchemaMismatch(format!(
                "missing required column {full_table}.{col}"
            )));
        }
    }
    Ok(())
}

/// Read and check the `{prefix}meta.schema_version` marker.
fn check_marker(conn: &rusqlite::Connection, prefix: &str) -> Result<(), GraphragError> {
    let meta = format!("{prefix}meta");
    // `parse` maps a non-numeric value to None; NoRows means the marker row is
    // absent. Both are SchemaMismatch; other errors surface as unreadable.
    let version: Option<Option<i64>> = conn
        .query_row(
            &format!("SELECT value FROM {meta} WHERE key = 'schema_version'"),
            [],
            |r| r.get::<_, String>(0).map(|s| s.trim().parse::<i64>().ok()),
        )
        .ok();
    match version {
        Some(Some(v)) if v == REQUIRED_SCHEMA_VERSION => Ok(()),
        Some(_) => Err(GraphragError::SchemaMismatch(format!(
            "expected {meta}.schema_version = {REQUIRED_SCHEMA_VERSION}"
        ))),
        None => Err(GraphragError::SchemaMismatch(format!(
            "{meta}.schema_version marker missing or unreadable"
        ))),
    }
}

/// Uniform mapper: any rusqlite error while reading schema shape is a mismatch.
fn mismatch<'a>(what: &'a str, why: &'a str) -> impl Fn(rusqlite::Error) -> GraphragError + 'a {
    move |e| GraphragError::SchemaMismatch(format!("{what}: {why}: {e}"))
}
