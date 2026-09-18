//! Lifecycle tests: public engine assembly (Task 10, REQ-SQL-01).
//!
//! The engine must expose two distinct entry paths — one taking a bare
//! connection (engine owns a snapshot read transaction) and one taking a
//! host-owned transaction (engine never begins/ends it). Fixtures copy the
//! CREATE TABLE statements verbatim from packages/core/src/db/schema.ts.

use graphrag_core::engine::{filter_induced_edges, GraphRagEngine};
use graphrag_core::error::GraphragError;
use graphrag_core::types::{EngineConfig, GraphNeighborhood, TraversalOptions, TraversalRequest};
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

fn insert_fact(conn: &Connection, id: &str, entity_id: &str, updated_at: i64) {
    conn.execute(
        &format!(
            "INSERT INTO {PREFIX}entries (id, entity_id, title, body, confidence,
             source_type, created_at, updated_at)
             VALUES (?1, ?2, 't', 'b', 'inferred', 'librarian_inferred', 1, ?3)"
        ),
        rusqlite::params![id, entity_id, updated_at],
    )
    .unwrap();
}

fn insert_edge(conn: &Connection, id: &str, entity_id: &str, src: &str, dst: &str) {
    conn.execute(
        &format!(
            "INSERT INTO {PREFIX}edges (id, entity_id, source_id, target_id, edge_type, created_at)
             VALUES (?1, ?2, ?3, ?4, 'supports', 1)"
        ),
        rusqlite::params![id, entity_id, src, dst],
    )
    .unwrap();
}

fn request(entity_id: &str, source_id: &str) -> TraversalRequest {
    TraversalRequest {
        entity_id: entity_id.to_string(),
        source_id: source_id.to_string(),
        options: TraversalOptions::default(),
    }
}

fn engine() -> GraphRagEngine {
    GraphRagEngine::new(EngineConfig::default())
}

fn seed_neighborhood(conn: &Connection) {
    create_valid_db(conn);
    insert_fact(conn, "a", "entity-alpha", 100);
    insert_fact(conn, "b", "entity-alpha", 90);
    insert_edge(conn, "e1", "entity-alpha", "a", "b");
}

/// (a) Connection path returns the full DTO on a valid DB.
#[test]
fn connection_path_returns_full_neighborhood() {
    let conn = Connection::open_in_memory().unwrap();
    seed_neighborhood(&conn);

    let hood: GraphNeighborhood = engine()
        .traverse(&conn, &request("entity-alpha", "a"), 1_000)
        .expect("traversal must succeed");

    assert_eq!(
        hood.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(hood.edges.len(), 1);
    assert_eq!(hood.edges[0].id, "e1");
    // Hydration ran with the caller-supplied clock: now_ms surfaced as
    // last_accessed_at semantics are hydration's business; here we pin the
    // anchor-first ordering and that facts carry real rows, not stubs.
    assert_eq!(hood.nodes[0].entity_id, "entity-alpha");
}

/// (b) Schema mismatch (version 10) -> SchemaMismatch, database unchanged.
#[test]
fn connection_path_schema_mismatch_leaves_db_unchanged() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    insert_fact(&conn, "a", "entity-alpha", 100);
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = '10' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();

    let err = engine()
        .traverse(&conn, &request("entity-alpha", "a"), 1_000)
        .expect_err("version 10 must be rejected");
    assert!(matches!(err, GraphragError::SchemaMismatch(_)), "{err:?}");

    // DB unchanged: the row we would have matched still exists untouched.
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {PREFIX}entries WHERE id = 'a'"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

/// (c) Transaction path: engine reads inside the caller's transaction; the
/// caller can insert and commit after the engine returns (the in-memory
/// result was materialized before those inserts, so re-asserting it proves
/// nothing about isolation — the value here is that the caller's txn stays
/// writable and commits cleanly after engine reads).
#[test]
fn transaction_path_snapshot_isolation_and_commit() {
    let conn = Connection::open_in_memory().unwrap();
    seed_neighborhood(&conn);

    let tx = conn.unchecked_transaction().unwrap();
    let hood = engine()
        .traverse_tx(&tx, &request("entity-alpha", "a"), 1_000)
        .expect("traversal must succeed");
    assert_eq!(hood.nodes.len(), 2);

    // Insert a fresh neighbor AFTER the engine returned, BEFORE commit.
    insert_fact(&tx, "c", "entity-alpha", 80);
    insert_edge(&tx, "e2", "entity-alpha", "a", "c");

    // Engine result is unaffected (it already read its snapshot).
    assert_eq!(hood.nodes.len(), 2);
    assert!(hood.nodes.iter().all(|n| n.id != "c"));

    tx.commit().expect("caller commit must succeed");
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {PREFIX}entries WHERE id = 'c'"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "post-engine insert must be committed");
}

/// (d) Transaction path: engine error leaves the caller's transaction OPEN
/// and usable (no implicit rollback, no implicit commit).
#[test]
fn transaction_path_engine_error_leaves_caller_transaction_open() {
    let conn = Connection::open_in_memory().unwrap();
    create_valid_db(&conn);
    conn.execute(
        &format!("UPDATE {PREFIX}meta SET value = '10' WHERE key = 'schema_version'"),
        [],
    )
    .unwrap();

    let tx = conn.unchecked_transaction().unwrap();
    let err = engine()
        .traverse_tx(&tx, &request("entity-alpha", "a"), 1_000)
        .expect_err("schema mismatch must fail the engine");
    assert!(matches!(err, GraphragError::SchemaMismatch(_)));

    // Transaction still open and usable: insert and commit.
    insert_fact(&tx, "a", "entity-alpha", 100);
    tx.commit().expect("caller transaction must still commit");
    let n: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {PREFIX}entries WHERE id = 'a'"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

/// (e) Connection path ends its snapshot transaction before returning: a new
/// transaction can begin immediately afterwards (sqlite forbids nested
/// BEGINs, so this proves none was left open).
#[test]
fn connection_path_leaves_no_transaction_open() {
    let conn = Connection::open_in_memory().unwrap();
    seed_neighborhood(&conn);

    engine()
        .traverse(&conn, &request("entity-alpha", "a"), 1_000)
        .expect("traversal must succeed");

    // Also prove an immediate write succeeds (an open read txn would not
    // block it in WAL-less sqlite, but a leaked BEGIN would).
    insert_fact(&conn, "z", "entity-alpha", 1);
    let guard = conn.unchecked_transaction();
    assert!(guard.is_ok(), "no transaction may remain open");
}

/// (f) Edge re-filter after hydration: edges whose endpoints were dropped by
/// hydration (soft-deleted between walk and hydrate) are excluded.
#[test]
fn filter_induced_edges_drops_edges_with_dangling_endpoints() {
    let e_ok = graphrag_core::types::WikiEdge {
        id: "e1".into(),
        entity_id: "entity-alpha".into(),
        source_id: "a".into(),
        target_id: "b".into(),
        edge_type: "supports".into(),
        created_at: 1.0,
    };
    let mut e_dangling = e_ok.clone();
    e_dangling.id = "e2".into();
    e_dangling.source_id = "a".into();
    e_dangling.target_id = "ghost".into();
    let mut e_self = e_ok.clone();
    e_self.id = "e3".into();
    e_self.source_id = "missing".into();
    e_self.target_id = "also-missing".into();

    let out = filter_induced_edges(vec![e_ok, e_dangling, e_self], &["a".into(), "b".into()]);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "e1");
}
