//! Induced-edge tests: REQ-SCALE-01 chunked, variable-limit-safe fetch (Task 8).
//!
//! Baseline (packages/core/src/repositories/EdgeRepository.ts:200-208) binds
//! ONE variable per neighborhood node in a single unchunked VALUES CTE,
//! exceeding SQLITE_MAX_VARIABLE_NUMBER for large neighborhoods. The native
//! fetch chunks the IN-list and post-filters in Rust, preserving UNION
//! semantics: an edge is induced iff BOTH endpoints are in the selected set
//! AND the entity matches.
//!
//! Fixture seeds are hand-written mirrors of the TS generator's seed bodies
//! in packages/core/__tests__/traversalFixtures.generator.test.ts (same
//! pattern as walk_tests.rs, kept self-contained).

use std::collections::HashSet;

use graphrag_core::edges::induced_edges;
use graphrag_core::error::GraphragError;
use rusqlite::Connection;
use serde_json::Value;

const PREFIX: &str = "llm_wiki_";
const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

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

fn create_db(conn: &Connection) {
    conn.execute_batch(EDGES_DDL).unwrap();
}

fn seed_edge(
    conn: &Connection,
    id: &str,
    entity_id: &str,
    source_id: &str,
    target_id: &str,
    edge_type: &str,
) {
    conn.execute(
        &format!(
            "INSERT INTO {PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at)
             VALUES (?, ?, ?, ?, ?, 1)"
        ),
        rusqlite::params![id, entity_id, source_id, target_id, edge_type],
    )
    .unwrap();
}

fn load_fixture(category: &str, name: &str) -> Value {
    let path = format!("{FIXTURE_DIR}/{category}/{name}.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {path} unreadable: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {path} bad JSON: {e}"))
}

/// Seed rows straight from a fixture envelope's `expectedEdges` (id, source,
/// target, edge_type — all under the envelope's entityId).
fn seed_fixture_edges(conn: &Connection, fx: &Value) {
    create_db(conn);
    let entity = fx["entityId"].as_str().unwrap();
    for e in fx["expectedEdges"].as_array().unwrap() {
        seed_edge(
            conn,
            e["id"].as_str().unwrap(),
            entity,
            e["source_id"].as_str().unwrap(),
            e["target_id"].as_str().unwrap(),
            e["edge_type"].as_str().unwrap(),
        );
    }
}

fn fixture_node_ids(fx: &Value) -> Vec<String> {
    fx["expectedNodeIds"]
        .as_array()
        .expect("fixture must pin expectedNodeIds")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn ids(edges: &[graphrag_core::types::WikiEdge]) -> Vec<&str> {
    edges.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn both_endpoints_in_set_is_induced() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e1", "entity1", "a", "b", "mentions");
    let nodes = vec!["a".to_string(), "b".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(ids(&out), vec!["e1"]);
    assert_eq!(out[0].edge_type, "mentions");
    assert_eq!(out[0].entity_id, "entity1");
    assert!((out[0].created_at - 1.0).abs() < f64::EPSILON);
}

#[test]
fn self_loop_is_induced() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e1", "entity1", "a", "a", "mentions");
    let nodes = vec!["a".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(ids(&out), vec!["e1"]);
}

#[test]
fn one_endpoint_outside_set_excluded() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e1", "entity1", "a", "b", "mentions");
    seed_edge(&conn, "e2", "entity1", "b", "z", "mentions");
    seed_edge(&conn, "e3", "entity1", "z", "a", "mentions");
    // Only a is selected: e1 has b outside, e2 both outside, e3 z outside.
    let nodes = vec!["a".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert!(out.is_empty());

    // a+b selected: e1 induced, the z-touching edges stay excluded.
    let nodes = vec!["a".to_string(), "b".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(ids(&out), vec!["e1"]);
}

#[test]
fn entity_scoping_excludes_other_entity() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e1", "entity1", "a", "b", "mentions");
    seed_edge(&conn, "e2", "entity2", "a", "b", "mentions");
    let nodes = vec!["a".to_string(), "b".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(ids(&out), vec!["e1"]);
}

#[test]
fn cross_chunk_edge_survives_post_filter() {
    // chunk_size 1: source in chunk 1, target in chunk 2. Filtering each
    // chunk's IN-list alone would lose the edge; the full-set post-filter
    // must keep it (pins the chunking-both-endpoints failure mode).
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e1", "entity1", "a", "b", "mentions");
    let nodes = vec!["a".to_string(), "b".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 1).unwrap();
    assert_eq!(ids(&out), vec!["e1"]);
}

#[test]
fn chunking_1200_nodes_all_induced_no_duplicates() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    // 1200-node ring: n_i -> n_{i+1}; every edge has both endpoints in set.
    let nodes: Vec<String> = (0..1200).map(|i| format!("n{i}")).collect();
    for i in 0..1200 {
        seed_edge(
            &conn,
            &format!("e{i}"),
            "entity1",
            &format!("n{i}"),
            &format!("n{}", (i + 1) % 1200),
            "mentions",
        );
    }
    // Also seed an edge reaching outside the set: must stay excluded.
    seed_edge(&conn, "e_out", "entity1", "n0", "outside", "mentions");

    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(out.len(), 1200, "all 1200 ring edges induced (3 chunks)");
    let seen: HashSet<&str> = out.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(seen.len(), out.len(), "no duplicates across chunks");
    assert!(!seen.contains(&"e_out"));
}

#[test]
fn chunk_boundary_exactly_500_nodes() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    let nodes: Vec<String> = (0..500).map(|i| format!("n{i}")).collect();
    for i in 0..500 {
        seed_edge(
            &conn,
            &format!("e{i}"),
            "entity1",
            &format!("n{i}"),
            &format!("n{}", (i + 1) % 500),
            "mentions",
        );
    }
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    assert_eq!(out.len(), 500);
    let seen: HashSet<&str> = out.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(seen.len(), out.len());
}

#[test]
fn chunk_size_zero_is_invalid_argument() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    let nodes = vec!["a".to_string()];
    let err = induced_edges(&conn, PREFIX, &nodes, "entity1", 0).unwrap_err();
    assert!(matches!(err, GraphragError::InvalidArgument { .. }));
}

#[test]
fn empty_node_set_returns_empty() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    let out = induced_edges(&conn, PREFIX, &[], "entity1", 500).unwrap();
    assert!(out.is_empty());
}

#[test]
fn result_sorted_deterministically() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_edge(&conn, "e3", "entity1", "b", "c", "mentions");
    seed_edge(&conn, "e1", "entity1", "a", "c", "mentions");
    seed_edge(&conn, "e2", "entity1", "a", "b", "reports_to");
    let nodes = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let out = induced_edges(&conn, PREFIX, &nodes, "entity1", 500).unwrap();
    // (a,b,reports_to) < (a,c,mentions) < (b,c,mentions).
    assert_eq!(ids(&out), vec!["e2", "e1", "e3"]);
}

// ---- committed fixture replays ------------------------------------------------

/// robustness/oversized_edge_types.json: 150 edgeTypes in the discovery
/// filter; the induced-edge stage must not reapply or re-chunk-bind the
/// filter — the induced edge appears with its stored type.
#[test]
fn replay_oversized_edge_types() {
    let fx = load_fixture("robustness", "oversized_edge_types");
    let conn = Connection::open_in_memory().unwrap();
    seed_fixture_edges(&conn, &fx);
    let nodes = fixture_node_ids(&fx);
    let out = induced_edges(&conn, PREFIX, &nodes, fx["entityId"].as_str().unwrap(), 500)
        .expect("chunked fetch must succeed");
    let expected: Vec<&str> = fx["expectedEdges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids(&out), expected);
    assert_eq!(out[0].edge_type, "type_0");
}

/// parity/induced_edges_outside_discovery_filter.json: induced edges include
/// both-endpoint pairs regardless of the discovery filter (reports_to is
/// outside edgeTypes ['mentions'] but is still induced).
#[test]
fn replay_induced_edges_outside_discovery_filter() {
    let fx = load_fixture("parity", "induced_edges_outside_discovery_filter");
    let conn = Connection::open_in_memory().unwrap();
    seed_fixture_edges(&conn, &fx);
    let nodes = fixture_node_ids(&fx);
    let out = induced_edges(&conn, PREFIX, &nodes, fx["entityId"].as_str().unwrap(), 500)
        .expect("chunked fetch must succeed");
    let expected: Vec<&str> = fx["expectedEdges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids(&out), expected);
    let types: Vec<&str> = out.iter().map(|e| e.edge_type.as_str()).collect();
    assert!(
        types.contains(&"reports_to"),
        "filter-external type induced"
    );
}
