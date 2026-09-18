//! Bounded breadth-first traversal (Task 7, REQ-SLICE-01).
//!
//! Walks the `{prefix}entries` / `{prefix}edges` tables from an anchor node,
//! applying the baseline-compatible discovery gates, real-valued depth
//! bound, collision-free visited set, and final (min_depth ASC,
//! updated_at DESC) ordering with an after-sort cap truncation. No edge
//! materialization happens here (Task 8 owns induced edges).

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use crate::error::GraphragError;
use crate::types::{Confidence, Direction};
use crate::validation::ResolvedInputs;

/// Ordered node ids plus a per-node (depth, updated_at) map.
pub struct WalkOutput {
    /// Anchor first, then (min_depth ASC, updated_at DESC), capped.
    pub node_ids: Vec<String>,
    /// Discovered node id -> (BFS depth, updated_at). Includes the anchor.
    pub nodes: HashMap<String, (i64, i64)>,
}

/// Anchor lookup: entity match + not soft-deleted. Missing anchor yields an
/// empty walk (no error), mirroring the baseline.
fn find_anchor(
    conn: &Connection,
    prefix: &str,
    entity_id: &str,
    source_id: &str,
) -> Result<Option<i64>, GraphragError> {
    let sql = format!(
        "SELECT id FROM {prefix}entries WHERE id = ?1 AND entity_id = ?2 AND deleted_at IS NULL LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(GraphragError::Sql)?;
    let mut rows = stmt
        .query(rusqlite::params![source_id, entity_id])
        .map_err(GraphragError::Sql)?;
    match rows.next().map_err(GraphragError::Sql)? {
        Some(_) => Ok(Some(0)),
        None => Ok(None),
    }
}

/// A discovered neighbor row: (id, updated_at, confidence, source_type, edge_type).
type NeighborRow = (String, i64, String, String, String);

/// Neighbor rows of `node_id` per resolved direction; caller applies gates.
/// Returns (neighbor_id, updated_at, confidence, source_type, edge_type).
/// Both = outbound ∪ inbound, deduped by neighbor id.
fn neighbors(
    conn: &Connection,
    prefix: &str,
    entity_id: &str,
    node_id: &str,
    direction: Direction,
) -> Result<Vec<NeighborRow>, GraphragError> {
    let (dir_side, dir_fixed) = match direction {
        Direction::Outbound => ("target_id", "source_id"),
        Direction::Inbound => ("source_id", "target_id"),
        Direction::Both => ("target_id", "source_id"),
    };
    let mut out: Vec<NeighborRow> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let directions: [(&str, &str); 1] = [(dir_side, dir_fixed)];
    let all: Vec<(&str, &str)> = if direction == Direction::Both {
        vec![("target_id", "source_id"), ("source_id", "target_id")]
    } else {
        directions.to_vec()
    };

    for (side, fixed) in all {
        let query = format!(
            "SELECT e.id, e.updated_at, e.confidence, e.source_type, x.edge_type
               FROM {prefix}edges x
               JOIN {prefix}entries e
                 ON e.id = x.{side} AND e.entity_id = x.entity_id AND e.deleted_at IS NULL
              WHERE x.entity_id = ?1 AND x.{fixed} = ?2"
        );
        let mut stmt = conn.prepare(&query).map_err(GraphragError::Sql)?;
        let mut rows = stmt
            .query(rusqlite::params![entity_id, node_id])
            .map_err(GraphragError::Sql)?;
        while let Some(row) = rows.next().map_err(GraphragError::Sql)? {
            let id: String = row.get(0)?;
            if seen.insert(id.clone()) {
                out.push((id, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?));
            }
        }
    }
    Ok(out)
}

/// Discovery gate: confidence rank and source_type exclusion (exact text;
/// empty exclusion list = no predicate).
fn passes_gates(
    confidence: &str,
    source_type: &str,
    min_confidence: Confidence,
    exclude_source_types: &[String],
) -> bool {
    let rank = match confidence {
        "certain" => 2u8,
        "inferred" => 1,
        "tentative" => 0,
        _ => u8::MAX, // unknown values rank below every minimum
    };
    let min_rank = match min_confidence {
        Confidence::Certain => 2,
        Confidence::Inferred => 1,
        Confidence::Tentative => 0,
    };
    // Baseline CASE: tentative 0 / inferred 1 / certain 2 / unknown -1.
    if rank == u8::MAX {
        return false; // unknown confidence (-1) < any min rank
    }
    if rank < min_rank {
        return false;
    }
    !exclude_source_types.iter().any(|x| x == source_type)
}

/// Bounded BFS from the anchor. See module docs for the contract.
pub fn walk(
    conn: &Connection,
    prefix: &str,
    inputs: &ResolvedInputs,
    entity_id: &str,
    source_id: &str,
) -> Result<WalkOutput, GraphragError> {
    if let Some(types) = &inputs.edge_types {
        if types.is_empty() {
            return anchor_only(conn, prefix, entity_id, source_id, inputs);
        }
    }

    if find_anchor(conn, prefix, entity_id, source_id)?.is_none() {
        return Ok(WalkOutput {
            node_ids: Vec::new(),
            nodes: HashMap::new(),
        });
    }

    let mut nodes: HashMap<String, (i64, i64)> = HashMap::new(); // id -> (depth, updated_at)
    let mut visited: HashSet<String> = HashSet::new();
    let anchor_updated_at: i64 = conn
        .query_row(
            &format!("SELECT updated_at FROM {prefix}entries WHERE id = ?1 AND entity_id = ?2"),
            rusqlite::params![source_id, entity_id],
            |r| r.get(0),
        )
        .map_err(GraphragError::Sql)?;
    nodes.insert(source_id.to_string(), (0, anchor_updated_at));
    visited.insert(source_id.to_string());

    let mut frontier: Vec<String> = vec![source_id.to_string()];
    let mut k: f64 = 1.0; // next frontier depth
                          // Expand frontier k-1 -> k iff (k-1) < d.
    while k - 1.0 < inputs.max_depth {
        let mut next: Vec<String> = Vec::new();
        for node in &frontier {
            for (id, updated_at, confidence, source_type, edge_type) in
                neighbors(conn, prefix, entity_id, node, inputs.direction)?
            {
                if visited.contains(&id) {
                    continue;
                }
                if let Some(types) = &inputs.edge_types {
                    if !types.contains(&edge_type) {
                        continue;
                    }
                }
                if !passes_gates(
                    &confidence,
                    &source_type,
                    inputs.min_confidence,
                    &inputs.exclude_source_types,
                ) {
                    continue;
                }
                visited.insert(id.clone());
                nodes.insert(id.clone(), (k as i64, updated_at));
                next.push(id);
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
        k += 1.0;
    }

    // Final ordering: batched updated_at fetch already captured during BFS;
    // sort by (min_depth ASC, updated_at DESC).
    let mut ordered: Vec<(String, i64, i64)> = nodes
        .iter()
        .map(|(id, (depth, updated_at))| (id.clone(), *depth, *updated_at))
        .collect();
    ordered.sort_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)));
    let mut node_ids: Vec<String> = ordered.into_iter().map(|(id, _, _)| id).collect();
    node_ids.truncate(inputs.max_nodes as usize);
    Ok(WalkOutput { node_ids, nodes })
}

/// Anchor-only walk used by the edge_types Some(empty) short circuit.
fn anchor_only(
    conn: &Connection,
    prefix: &str,
    entity_id: &str,
    source_id: &str,
    inputs: &ResolvedInputs,
) -> Result<WalkOutput, GraphragError> {
    if find_anchor(conn, prefix, entity_id, source_id)?.is_none() {
        return Ok(WalkOutput {
            node_ids: Vec::new(),
            nodes: HashMap::new(),
        });
    }
    let updated_at: i64 = conn
        .query_row(
            &format!("SELECT updated_at FROM {prefix}entries WHERE id = ?1 AND entity_id = ?2"),
            rusqlite::params![source_id, entity_id],
            |r| r.get(0),
        )
        .map_err(GraphragError::Sql)?;
    let mut nodes = HashMap::new();
    nodes.insert(source_id.to_string(), (0i64, updated_at));
    let node_ids = if inputs.max_nodes >= 1 {
        vec![source_id.to_string()]
    } else {
        Vec::new()
    };
    Ok(WalkOutput { node_ids, nodes })
}
