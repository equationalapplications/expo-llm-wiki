//! Ordered chunked fact hydration (Task 9, REQ-SLICE-01).
//!
//! Native port of `EntryRepository.findByIds` (packages/core/src/repositories/
//! EntryRepository.ts:115-146) plus `mapRowToFact` (lines 33-80). Chunk size
//! defaults to 500 (matching the TS `chunkSize = 500` at line 109) so per-query
//! variable count stays under `SQLITE_MAX_VARIABLE_NUMBER`; `entity_id IN`
//! scoping binds only when the caller supplies entity ids; `deleted_at IS
//! NULL` always.
//!
//! Order restoration mirrors the TS Map semantics: results follow INPUT id
//! order, first match wins (a duplicate input id yields one row), and missing
//! ids are silently dropped.
//!
//! REQ-PERF-01 ablation: the projection deliberately EXCLUDES `embedding_blob`
//! (declared difference from the TS `SELECT *`).
//!
//! REQ-SLICE-02 declared difference (clock only): the TS mapper samples
//! `Date.now()` per row; here `now_ms` is a caller-controlled parameter, so
//! staleness is deterministic and testable. Trust-tier derivation is
//! clock-independent.

use rusqlite::Connection;

use crate::error::{invalid_argument, GraphragError};
use crate::okf::{derive_trust_tier, is_stale_after};
use crate::types::WikiFact;

/// Default chunk size, matching EntryRepository.chunkSize.
pub const DEFAULT_CHUNK_SIZE: usize = 500;

/// Column projection for hydration. `embedding_blob` is deliberately excluded
/// (REQ-PERF-01 ablation pins this).
const FACT_COLUMNS: &str = "id, entity_id, title, body, tags, confidence, source_type, \
     source_hash, source_ref, created_at, updated_at, last_accessed_at, \
     access_count, deleted_at, okf_type, lifecycle_status, stale_after, \
     generated_by, okf_sources, okf_verified, okf_usage_window, \
     last_verified_at, last_verified_by";

/// Fetch facts by ids in INPUT id order, optionally scoped to entity ids.
///
/// Ids are bound in chunks of `chunk_size`; per chunk the query is
/// `SELECT {FACT_COLUMNS} FROM {prefix}entries WHERE id IN (...) [AND
/// entity_id IN (...)] AND deleted_at IS NULL`. Rows are mapped through the
/// `mapRowToFact` port (see `map_row_to_fact`), then restored to input order
/// with first-match-wins; missing ids are silently dropped.
pub fn hydrate_facts(
    conn: &Connection,
    prefix: &str,
    ids: &[String],
    entity_ids: &[String],
    chunk_size: usize,
    now_ms: i64,
) -> Result<Vec<WikiFact>, GraphragError> {
    if chunk_size == 0 {
        return Err(invalid_argument("chunkSize", "must be >= 1"));
    }

    // Per-chunk rows: the map dedupes by id so the later input-order walk sees
    // first-match-wins exactly like the TS Map built via `new Map(rows...)`.
    let mut by_id: std::collections::HashMap<String, WikiFact> = std::collections::HashMap::new();
    for chunk in ids.chunks(chunk_size) {
        // Entity scoping binds ONLY when entity ids are supplied (TS builds
        // the clause conditionally the same way).
        let entity_clause = if entity_ids.is_empty() {
            String::new()
        } else {
            format!(
                " AND entity_id IN ({})",
                vec!["?"; entity_ids.len()].join(", ")
            )
        };
        let sql = format!(
            "SELECT {FACT_COLUMNS}\n               FROM {prefix}entries\n              \
              WHERE id IN ({placeholders}){entity_clause} AND deleted_at IS NULL",
            placeholders = vec!["?"; chunk.len()].join(", ")
        );

        let mut stmt = conn.prepare(&sql).map_err(GraphragError::Sql)?;
        let mut params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        params.extend(entity_ids.iter().map(|s| s as &dyn rusqlite::ToSql));

        let mut rows = stmt.query(params.as_slice()).map_err(GraphragError::Sql)?;
        while let Some(row) = rows.next().map_err(GraphragError::Sql)? {
            let fact = map_row_to_fact(row, now_ms);
            // First match wins: a row already mapped for this id stays.
            by_id.entry(fact.id.clone()).or_insert(fact);
        }
    }

    // Order restoration: input id order, missing ids silently dropped, and
    // duplicate input ids yield the row ONCE (TS builds the result from the
    // byId Map, so a repeated id emits the same value once per unique key).
    let mut seen = std::collections::HashSet::new();
    Ok(ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter_map(|id| by_id.get(id).cloned())
        .collect())
}

/// Rust port of `mapRowToFact` (EntryRepository.ts:33-80). Column indices
/// follow `FACT_COLUMNS`. All coercions mirror the TS mapper:
/// - tags: JSON parse with `[]` fallback (already-array tolerated)
/// - okf_sources / okf_verified: JSON-array parse with `[]` fallback
/// - okf_usage_window: JSON-object parse; non-objects (incl. arrays) -> null
/// - nullability: `?? null`, `Number-or-null`, `access_count ?? 0`,
///   `lifecycle_status ?? 'stable'`
/// - derived: `isStale = isStaleAfter(stale_after, now)`,
///   `trustTier = deriveTrustTier(okf_verified)` (spec §2.7 + §5.3)
fn map_row_to_fact(row: &rusqlite::Row<'_>, now_ms: i64) -> WikiFact {
    let tags_raw: Option<String> = row.get(4).ok();
    let tags = parse_json_array(&tags_raw)
        .and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
        })
        .unwrap_or_default();

    let okf_sources_raw: Option<String> = row.get(18).ok();
    let okf_sources = parse_json_array(&okf_sources_raw).unwrap_or_else(|| serde_json::json!([]));
    let okf_verified_raw: Option<String> = row.get(19).ok();
    let okf_verified = parse_json_array(&okf_verified_raw).unwrap_or_else(|| serde_json::json!([]));
    let okf_usage_window_raw: Option<String> = row.get(20).ok();
    let okf_usage_window = okf_usage_window_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_object())
        .unwrap_or(serde_json::Value::Null);

    // stale_after is INTEGER epoch ms; read as string-able raw then coerce
    // via parse_stale_after (which also tolerates a 'YYYY-MM-DD' text column,
    // mirroring the TS Number(...) read path's leniency).
    let stale_after: Option<i64> = row
        .get::<_, Option<rusqlite::types::Value>>(16)
        .ok()
        .flatten()
        .and_then(|raw| match raw {
            rusqlite::types::Value::Null => None,
            rusqlite::types::Value::Integer(i) => Some(i),
            rusqlite::types::Value::Real(f) => Some(f as i64),
            rusqlite::types::Value::Text(s) => {
                crate::okf::parse_stale_after(&serde_json::Value::String(s))
            }
            _ => None,
        });

    let trust_tier = derive_trust_tier(&okf_verified);

    WikiFact {
        id: row.get(0).unwrap_or_default(),
        entity_id: row.get(1).unwrap_or_default(),
        title: row.get(2).unwrap_or_default(),
        body: row.get(3).unwrap_or_default(),
        tags,
        confidence: row.get(5).unwrap_or_default(),
        source_type: row.get(6).unwrap_or_default(),
        source_hash: row.get(7).ok(),
        source_ref: row.get(8).ok(),
        created_at: row.get::<_, Option<i64>>(9).ok().flatten().unwrap_or(0),
        updated_at: row.get::<_, Option<i64>>(10).ok().flatten().unwrap_or(0),
        last_accessed_at: row.get(11).ok(),
        deleted_at: row.get::<_, Option<i64>>(13).ok().flatten(),
        access_count: row.get::<_, Option<i64>>(12).ok().flatten().unwrap_or(0),
        okf_type: row.get(14).ok(),
        lifecycle_status: row
            .get::<_, Option<String>>(15)
            .ok()
            .flatten()
            .unwrap_or_else(|| "stable".to_string()),
        stale_after,
        generated_by: row.get(17).ok(),
        okf_sources,
        okf_verified,
        okf_usage_window,
        last_verified_at: row.get(21).ok(),
        last_verified_by: row.get(22).ok(),
        // Spec §2.7 + §5.3: hydrate so consumers don't re-call okf helpers.
        // now_ms is the caller-controlled clock (declared difference).
        is_stale: is_stale_after(
            &stale_after
                .map(|v| serde_json::json!(v))
                .unwrap_or(serde_json::Value::Null),
            now_ms,
        ),
        trust_tier: trust_tier.as_str().to_string(),
    }
}

/// Helper mirroring rowMappers.parseJsonArray: parse a JSON column, returning
/// None when the value is absent, unparsable, or NOT an array.
fn parse_json_array(raw: &Option<String>) -> Option<serde_json::Value> {
    raw.as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_array())
}
