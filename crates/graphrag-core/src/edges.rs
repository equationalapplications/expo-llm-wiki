//! Chunked induced-edge fetch (Task 8, REQ-SCALE-01).
//!
//! Baseline (`packages/core/src/repositories/EdgeRepository.ts` lines
//! 200-208) builds a `VALUES (?,...)` CTE with ONE bound variable per
//! neighborhood node in a single query, exceeding
//! `SQLITE_MAX_VARIABLE_NUMBER` for large neighborhoods. The native fetch
//! instead chunks the selected node ids: per chunk it selects edges whose
//! source_id is in the chunk, then post-filters in Rust so only edges whose
//! target_id is also in the FULL selected set survive. Per-query variable
//! count is therefore `chunk_size + 1` regardless of neighborhood size.
//!
//! UNION semantics: an edge is induced iff BOTH endpoints are in the
//! selected set AND the entity matches. Because the post-filter runs against
//! the full set, edges spanning chunk boundaries are never lost and rows can
//! never be duplicated (each candidate row is examined exactly once).
//! Direction/edge-type discovery filters are NOT reapplied here (the walk
//! owns discovery; induced edges ignore it — see the
//! `induced_edges_outside_discovery_filter` fixture).
//!
//! REQ-SLICE-02 declared difference (ordering only): the baseline returns
//! rows in unspecified order for multi-chunk results; the native fetch sorts
//! deterministically by (source_id, target_id, edge_type, id).

use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::{invalid_argument, GraphragError};
use crate::types::WikiEdge;

/// Default chunk size, matching EntryRepository.chunkSize.
pub const DEFAULT_CHUNK_SIZE: usize = 500;

/// Fetch induced edges for `entity_id` over `node_ids`.
///
/// An edge is induced iff both `source_id` and `target_id` are in `node_ids`
/// and `entity_id` matches. Node ids are bound in chunks of `chunk_size`
/// (each query binds at most `chunk_size + 1` variables); target membership
/// is filtered in Rust against the full set. Result is deduped by edge
/// identity (rows cannot repeat by construction) and sorted by
/// (source_id, target_id, edge_type, id).
pub fn induced_edges(
    conn: &Connection,
    prefix: &str,
    node_ids: &[String],
    entity_id: &str,
    chunk_size: usize,
) -> Result<Vec<WikiEdge>, GraphragError> {
    if chunk_size == 0 {
        return Err(invalid_argument("chunkSize", "must be >= 1"));
    }
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }

    let selected: HashSet<&str> = node_ids.iter().map(String::as_str).collect();
    let mut out: Vec<WikiEdge> = Vec::new();
    for chunk in node_ids.chunks(chunk_size) {
        // Per-chunk placeholders: a short final chunk binds fewer variables
        // (variable count stays <= chunk_size + 1).
        let sql = format!(
            "SELECT id, entity_id, source_id, target_id, edge_type, created_at
               FROM {prefix}edges
              WHERE entity_id = ? AND source_id IN ({placeholders})",
            placeholders = vec!["?"; chunk.len()].join(", ")
        );
        let mut stmt = conn.prepare(&sql).map_err(GraphragError::Sql)?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(
                std::iter::once(entity_id).chain(chunk.iter().map(String::as_str)),
            ))
            .map_err(GraphragError::Sql)?;
        while let Some(row) = rows.next().map_err(GraphragError::Sql)? {
            let target_id: String = row.get(3)?;
            if !selected.contains(target_id.as_str()) {
                continue;
            }
            out.push(WikiEdge {
                id: row.get(0)?,
                entity_id: row.get(1)?,
                source_id: row.get(2)?,
                target_id,
                edge_type: row.get(4)?,
                created_at: row.get::<_, i64>(5)? as f64,
            });
        }
    }

    out.sort_by(|a, b| {
        a.source_id
            .cmp(&b.source_id)
            .then(a.target_id.cmp(&b.target_id))
            .then(a.edge_type.cmp(&b.edge_type))
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_size_zero_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        let err = induced_edges(&conn, "p_", &["a".to_string()], "e", 0).unwrap_err();
        assert!(matches!(err, GraphragError::InvalidArgument { .. }));
    }

    #[test]
    fn empty_node_list_short_circuits() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(induced_edges(&conn, "p_", &[], "e", 500)
            .unwrap()
            .is_empty());
    }
}
