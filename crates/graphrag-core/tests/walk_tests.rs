//! Walk tests: REQ-SLICE-01 bounded BFS traversal (Task 7).
//!
//! Replays committed baseline compatibility fixtures (parity + the two
//! declared-difference scenarios the walk participates in). Seed graphs are
//! hand-written mirrors of the TS generator's seed bodies in
//! packages/core/__tests__/traversalFixtures.generator.test.ts.

use graphrag_core::error::GraphragError;
use graphrag_core::types::{Confidence, EngineConfig, TraversalOptions, TraversalRequest};
use graphrag_core::validation::validate_request;
use graphrag_core::walk::{walk, WalkOutput};
use rusqlite::Connection;
use serde_json::Value;

/// Adapter: tests drive walk() with the request directly, so rebuild the
/// entity/source pair from the envelope.
fn walk_req(
    conn: &Connection,
    prefix: &str,
    resolved: &graphrag_core::validation::ResolvedInputs,
    req: &TraversalRequest,
) -> Result<WalkOutput, GraphragError> {
    walk(
        conn,
        prefix,
        resolved,
        req.entity_id.as_str(),
        req.source_id.as_str(),
    )
}

const PREFIX: &str = "llm_wiki_";
const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

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

/// Mirror of the TS generator's `seedEntry` (same defaults).
fn seed_entry(conn: &Connection, o: SeedEntry) {
    let id = o.id;
    let entity_id = o.entity_id.unwrap_or("entity1");
    let title = format!("t_{id}");
    let confidence = o.confidence.unwrap_or("certain");
    let source_type = o.source_type.unwrap_or("user_stated");
    let created_at = o.created_at.unwrap_or(1);
    let updated_at = o.updated_at.unwrap_or(1);
    let deleted_at = o.deleted_at;
    conn.execute(
        &format!(
            "INSERT INTO {PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, 'body', '[]', ?, ?, ?, ?, ?)"
        ),
        rusqlite::params![id, entity_id, title, confidence, source_type, created_at, updated_at, deleted_at],
    )
    .unwrap();
}

#[derive(Default)]
struct SeedEntry<'a> {
    id: &'a str,
    entity_id: Option<&'a str>,
    confidence: Option<&'a str>,
    source_type: Option<&'a str>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    deleted_at: Option<i64>,
}

/// Mirror of the TS generator's `seedEdge` (same defaults).
fn seed_edge(conn: &Connection, id: &str, entity_id: &str, source_id: &str, target_id: &str) {
    conn.execute(
        &format!(
            "INSERT INTO {PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at)
             VALUES (?, ?, ?, ?, 'mentions', 1)"
        ),
        rusqlite::params![id, entity_id, source_id, target_id],
    )
    .unwrap();
}

fn seed_edge_typed(
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

/// Load a fixture envelope from tests/fixtures/<category>/<name>.json.
fn load_fixture(category: &str, name: &str) -> Value {
    let path = format!("{FIXTURE_DIR}/{category}/{name}.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {path} unreadable: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {path} bad JSON: {e}"))
}

/// Map a fixture `config` JSON object onto EngineConfig (manual: EngineConfig
/// is a plain struct, not a Deserialize target).
fn config_from_fixture(v: &Value) -> EngineConfig {
    let mut cfg = EngineConfig::default();
    if let Some(min_conf) = v.get("minTraversalConfidence").and_then(|x| x.as_str()) {
        cfg.min_traversal_confidence = Some(min_conf.parse_conf());
    }
    if let Some(dir) = v.get("traversalDirection").and_then(|x| x.as_str()) {
        cfg.traversal_direction = Some(parse_direction(dir));
    }
    if let Some(cap) = v.get("maxTraversalNodes").and_then(|x| x.as_f64()) {
        cfg.max_traversal_nodes = Some(cap);
    }
    if let Some(list) = v.get("excludeSourceTypes").and_then(|x| x.as_array()) {
        cfg.exclude_source_types = Some(
            list.iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect(),
        );
    }
    cfg
}

fn parse_direction(s: &str) -> graphrag_core::types::Direction {
    use graphrag_core::types::Direction::*;
    match s {
        "inbound" => Inbound,
        "outbound" => Outbound,
        "both" => Both,
        other => panic!("unknown direction string {other}"),
    }
}

trait ParseConf {
    fn parse_conf(self) -> Confidence;
}
impl ParseConf for &str {
    fn parse_conf(self) -> Confidence {
        match self {
            "certain" => Confidence::Certain,
            "inferred" => Confidence::Inferred,
            "tentative" => Confidence::Tentative,
            other => panic!("unknown confidence string {other}"),
        }
    }
}

/// Build the request from a fixture envelope and run the walk.
fn run_fixture(category: &str, name: &str) -> (Value, WalkOutput) {
    let fx = load_fixture(category, name);
    let config = config_from_fixture(&fx["config"]);
    let options: TraversalOptions = serde_json::from_value(fx["options"].clone())
        .expect("fixture options must deserialize as TraversalOptions");
    let req = TraversalRequest {
        entity_id: fx["entityId"].as_str().unwrap().to_string(),
        source_id: fx["sourceId"].as_str().unwrap().to_string(),
        options,
    };
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    seed_fixture_graph(&conn, category, name);
    let resolved = validate_request(&req, &config).expect("fixture inputs must resolve");
    let out = walk_req(&conn, PREFIX, &resolved, &req).expect("walk must succeed");
    (fx, out)
}

fn e(c: &Connection, id: &str) {
    seed_entry(
        c,
        SeedEntry {
            id,
            ..Default::default()
        },
    );
}
fn eu(c: &Connection, id: &str, updated_at: i64) {
    seed_entry(
        c,
        SeedEntry {
            id,
            updated_at: Some(updated_at),
            ..Default::default()
        },
    );
}
fn eo(c: &Connection, o: SeedEntry) {
    seed_entry(c, o);
}
fn ed(c: &Connection, id: &str, s: &str, t: &str) {
    seed_edge(c, id, "entity1", s, t);
}
fn edt(c: &Connection, id: &str, s: &str, t: &str, ty: &str) {
    seed_edge_typed(c, id, "entity1", s, t, ty);
}

/// Hand-written seed graphs mirroring the TS generator's seed bodies.
fn seed_fixture_graph(conn: &Connection, category: &str, name: &str) {
    match (category, name) {
        ("parity", "one_hop_outbound") => {
            e(conn, "a");
            e(conn, "b");
            ed(conn, "e1", "a", "b");
        }
        ("parity", "two_hop_chain") | ("declared_difference", "fractional_depth_1_5") => {
            e(conn, "a");
            e(conn, "b");
            e(conn, "c");
            ed(conn, "e1", "a", "b");
            ed(conn, "e2", "b", "c");
        }
        ("parity", "depth3_chain") => {
            for id in ["a", "b", "c", "d"] {
                e(conn, id);
            }
            ed(conn, "e1", "a", "b");
            ed(conn, "e2", "b", "c");
            ed(conn, "e3", "c", "d");
        }
        ("parity", "direction_inbound") => {
            e(conn, "a");
            e(conn, "b");
            e(conn, "c");
            ed(conn, "e1", "b", "a");
            ed(conn, "e2", "a", "c");
        }
        ("parity", "direction_both") => {
            e(conn, "a");
            e(conn, "b");
            ed(conn, "e1", "a", "b");
        }
        ("parity", "cycle_guard_both_directions") => {
            e(conn, "a");
            e(conn, "b");
            // TS seed: reciprocal cycle edges.
            ed(conn, "e1", "a", "b");
            ed(conn, "e1r", "b", "a");
        }
        ("parity", "edge_types_allow_list") => {
            e(conn, "a");
            e(conn, "b");
            e(conn, "c");
            edt(conn, "e1", "a", "b", "reports_to");
            edt(conn, "e2", "a", "c", "mentions");
        }
        ("parity", "edge_types_empty_short_circuit") => {
            e(conn, "a");
            e(conn, "b");
            ed(conn, "e1", "a", "b");
        }
        ("parity", "tentative_dead_end") => {
            e(conn, "a");
            eo(
                conn,
                SeedEntry {
                    id: "b",
                    confidence: Some("tentative"),
                    ..Default::default()
                },
            );
            e(conn, "c");
            ed(conn, "e1", "a", "b");
            ed(conn, "e2", "b", "c");
        }
        ("parity", "exclude_source_types_dead_end") => {
            e(conn, "a");
            eo(
                conn,
                SeedEntry {
                    id: "b",
                    source_type: Some("immutable_document"),
                    ..Default::default()
                },
            );
            e(conn, "c");
            ed(conn, "e1", "a", "b");
            ed(conn, "e2", "b", "c");
        }
        ("parity", "out_of_enum_source_type") => {
            e(conn, "a");
            eo(
                conn,
                SeedEntry {
                    id: "b",
                    source_type: Some("some_future_kind"),
                    ..Default::default()
                },
            );
            e(conn, "c");
            ed(conn, "e1", "a", "b");
            ed(conn, "e2", "b", "c");
        }
        ("parity", "node_cap_ordering") => {
            eu(conn, "a", 1);
            eu(conn, "b", 400);
            eu(conn, "c", 300);
            eu(conn, "d", 200);
            eu(conn, "e", 100);
            for t in ["b", "c", "d", "e"] {
                ed(conn, &format!("e_{t}"), "a", t);
            }
        }
        ("parity", "capped_tie_group") => {
            eu(conn, "a", 1);
            eu(conn, "b", 100);
            eu(conn, "c", 100);
            ed(conn, "e_b", "a", "b");
            ed(conn, "e_c", "a", "c");
        }
        ("parity", "anchor_exempt_from_gates") => {
            eo(
                conn,
                SeedEntry {
                    id: "a",
                    confidence: Some("tentative"),
                    source_type: Some("immutable_document"),
                    ..Default::default()
                },
            );
            ed(conn, "e1", "a", "b");
        }
        ("parity", "missing_source_empty") => {
            e(conn, "a");
            e(conn, "b");
            ed(conn, "e1", "a", "b");
        }
        ("parity", "foreign_entity_source_empty") => {
            eo(
                conn,
                SeedEntry {
                    id: "a",
                    entity_id: Some("entity2"),
                    ..Default::default()
                },
            );
        }
        ("parity", "soft_deleted_source_empty") => {
            eo(
                conn,
                SeedEntry {
                    id: "a",
                    deleted_at: Some(999),
                    ..Default::default()
                },
            );
        }
        ("parity", "cap_within_i64_accepts") | ("parity", "cap_2to53_band") => {
            e(conn, "a");
            e(conn, "b");
            ed(conn, "e1", "a", "b");
        }
        ("parity", "explicit_empty_exclude_source_types") => {
            e(conn, "a");
            eo(
                conn,
                SeedEntry {
                    id: "b",
                    source_type: Some("immutable_document"),
                    ..Default::default()
                },
            );
            ed(conn, "e1", "a", "b");
        }
        ("declared_difference", "comma_ids_cycle") => {
            e(conn, "a,b");
            e(conn, "b,a");
            ed(conn, "e1", "a,b", "b,a");
        }
        _ => panic!("unmapped fixture seed: {category}/{name}"),
    }
}

// ---- fixture replay tests ----------------------------------------------------

fn expected_ids(fx: &Value) -> Vec<String> {
    fx["expectedNodeIds"]
        .as_array()
        .expect("fixture must pin expectedNodeIds")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn replay_one_hop_outbound() {
    let (fx, out) = run_fixture("parity", "one_hop_outbound");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_two_hop_chain() {
    let (fx, out) = run_fixture("parity", "two_hop_chain");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_depth3_chain() {
    let (fx, out) = run_fixture("parity", "depth3_chain");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_direction_inbound() {
    let (fx, out) = run_fixture("parity", "direction_inbound");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_direction_both() {
    let (fx, out) = run_fixture("parity", "direction_both");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_cycle_guard_both_directions() {
    let (fx, out) = run_fixture("parity", "cycle_guard_both_directions");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_edge_types_allow_list() {
    let (fx, out) = run_fixture("parity", "edge_types_allow_list");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_edge_types_empty_short_circuit() {
    let (fx, out) = run_fixture("parity", "edge_types_empty_short_circuit");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_tentative_dead_end() {
    let (fx, out) = run_fixture("parity", "tentative_dead_end");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_exclude_source_types_dead_end() {
    let (fx, out) = run_fixture("parity", "exclude_source_types_dead_end");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_out_of_enum_source_type() {
    let (fx, out) = run_fixture("parity", "out_of_enum_source_type");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_node_cap_ordering() {
    let (fx, out) = run_fixture("parity", "node_cap_ordering");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

/// Tie rule: anchor prefix pinned; exactly one member of eligibleTiedIds at
/// the cap boundary (engines may choose different tied subsets).
#[test]
fn replay_capped_tie_group() {
    let (fx, out) = run_fixture("parity", "capped_tie_group");
    let expected = expected_ids(&fx); // ["a"]
    assert_eq!(out.node_ids[..expected.len()], expected[..]);
    assert_eq!(out.node_ids.len(), expected.len() + 1);
    let tied: Vec<&str> = fx["eligibleTiedIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let last = out.node_ids.last().unwrap().as_str();
    assert!(
        tied.contains(&last),
        "cap-boundary node {last} must be one of {tied:?}"
    );
}

#[test]
fn replay_anchor_exempt_from_gates() {
    let (fx, out) = run_fixture("parity", "anchor_exempt_from_gates");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_missing_source_empty() {
    let (fx, out) = run_fixture("parity", "missing_source_empty");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_foreign_entity_source_empty() {
    let (fx, out) = run_fixture("parity", "foreign_entity_source_empty");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_soft_deleted_source_empty() {
    let (fx, out) = run_fixture("parity", "soft_deleted_source_empty");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_cap_within_i64_accepts() {
    let (fx, out) = run_fixture("parity", "cap_within_i64_accepts");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

#[test]
fn replay_cap_2to53_band() {
    // Native test asserts acceptance + floor value, not traversal output.
    let fx = load_fixture("parity", "cap_2to53_band");
    let options: TraversalOptions = serde_json::from_value(fx["options"].clone()).unwrap();
    let req = TraversalRequest {
        entity_id: "entity1".into(),
        source_id: "a".into(),
        options,
    };
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(
        resolved.max_nodes, 9007199254740992u64,
        "2^53+1 must decode as f64 2^53 then floor"
    );
}

#[test]
fn replay_explicit_empty_exclude_source_types() {
    let (fx, out) = run_fixture("parity", "explicit_empty_exclude_source_types");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

// ---- declared differences ----------------------------------------------------

/// DD-2: native real-valued bound d=1.5 reaches depth-2 nodes.
#[test]
fn replay_declared_fractional_depth_1_5() {
    let (fx, out) = run_fixture("declared_difference", "fractional_depth_1_5");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

/// DD-1: collision-free visited set — comma-containing ids both returned,
/// traversal terminates despite cycle semantics.
#[test]
fn replay_declared_comma_ids_cycle() {
    let (fx, out) = run_fixture("declared_difference", "comma_ids_cycle");
    assert_eq!(out.node_ids, expected_ids(&fx));
}

// ---- non-fixture unit coverage ------------------------------------------------

/// Depth map: anchor depth 0, discovered nodes carry their BFS depth.
#[test]
fn depth_map_reports_bfs_depths() {
    let options = TraversalOptions {
        max_depth: Some(3.0),
        direction: Some(parse_direction("outbound")),
        ..Default::default()
    };
    let req = TraversalRequest {
        entity_id: "entity1".into(),
        source_id: "a".into(),
        options,
    };
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    // a -> b -> c
    e(&conn, "a");
    e(&conn, "b");
    e(&conn, "c");
    ed(&conn, "e1", "a", "b");
    ed(&conn, "e2", "b", "c");
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    let out = walk_req(&conn, PREFIX, &resolved, &req).unwrap();
    assert_eq!(out.node_ids, vec!["a", "b", "c"]);
    assert_eq!(out.nodes["a"].0, 0);
    assert_eq!(out.nodes["b"].0, 1);
    assert_eq!(out.nodes["c"].0, 2);
}

/// Ordering: within equal depth, updated_at DESC wins; d=1.0 stops frontier
/// expansion past depth 1.
#[test]
fn depth_one_stops_expansion_and_orders_by_updated_at_desc() {
    let options = TraversalOptions {
        max_depth: Some(1.0),
        direction: Some(parse_direction("outbound")),
        ..Default::default()
    };
    let req = TraversalRequest {
        entity_id: "entity1".into(),
        source_id: "a".into(),
        options,
    };
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    eu(&conn, "a", 1);
    eu(&conn, "b", 400);
    eu(&conn, "c", 300);
    ed(&conn, "e1", "a", "b");
    ed(&conn, "e2", "b", "c"); // beyond depth 1; must not be reached
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    let out = walk_req(&conn, PREFIX, &resolved, &req).unwrap();
    assert_eq!(out.node_ids, vec!["a", "b"]);
}

/// d=1.5 expands frontier 1 and reaches depth 2, but NOT depth 3
/// (frontier 2 expands iff 2-1 < 1.5 is false... 1 < 1.5 true — pinned by
/// fixture; here assert 1.5 does not reach depth 3).
#[test]
fn fractional_depth_does_not_reach_depth_three() {
    let options = TraversalOptions {
        max_depth: Some(1.5),
        ..Default::default()
    };
    let req = TraversalRequest {
        entity_id: "entity1".into(),
        source_id: "a".into(),
        options,
    };
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    for id in ["a", "b", "c", "d"] {
        e(&conn, id);
    }
    ed(&conn, "e1", "a", "b");
    ed(&conn, "e2", "b", "c");
    ed(&conn, "e3", "c", "d");
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    let out = walk_req(&conn, PREFIX, &resolved, &req).unwrap();
    assert_eq!(out.node_ids, vec!["a", "b", "c"]);
}
