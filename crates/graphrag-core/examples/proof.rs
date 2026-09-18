//! Headless proof (REQ-SLICE-03): the crate runs a full GraphRAG neighborhood
//! read end-to-end with no Tauri, Node, React Native, or TypeScript — just an
//! in-memory SQLite database and this file.
//!
//! Run:
//!
//!     cargo run -p graphrag-core --example proof
//!
//! Builds a 3-node graph, calls [`GraphRagEngine::traverse`] (the connection
//! entry path, where the engine owns its snapshot transaction per REQ-SQL-01),
//! and prints the resulting neighborhood as JSON. Exits nonzero on any error.

use graphrag_core::engine::GraphRagEngine;
use graphrag_core::types::{EngineConfig, TraversalOptions, TraversalRequest};
use rusqlite::Connection;

/// Schema-accurate `llm_wiki_entries` DDL (all columns present; embedding_blob
/// stays NULL and is excluded from the engine's read projection).
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

/// Verbatim `llm_wiki_meta` DDL; the `schema_version` marker must equal 11
/// (REQ-SQL-04). The engine validates, never migrates.
const META_DDL: &str = "CREATE TABLE IF NOT EXISTS llm_wiki_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );";

fn main() {
    // 1. In-memory database with the exact host schema.
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    conn.execute_batch(&format!("{ENTRIES_DDL}\n{EDGES_DDL}\n{META_DDL}"))
        .expect("create llm_wiki_* schema");
    conn.execute(
        "INSERT INTO llm_wiki_meta (key, value) VALUES ('schema_version', '11')",
        [],
    )
    .expect("stamp schema_version");

    // 2. Seed a tiny 3-node graph: anchor (id = source_id) -> fact-b -> fact-c
    //    (outbound chain within one entity).
    let facts: [(&str, &str, i64); 3] = [
        ("fact-a", "entity-alpha", 100),
        ("fact-b", "entity-alpha", 90),
        ("fact-c", "entity-alpha", 80),
    ];
    for (id, entity, updated_at) in facts {
        conn.execute(
            "INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence,
             source_type, created_at, updated_at)
             VALUES (?1, ?2, 't', 'b', 'inferred', 'librarian_inferred', 1, ?3)",
            rusqlite::params![id, entity, updated_at],
        )
        .expect("insert fact");
    }
    for (id, src, dst) in [("e1", "fact-a", "fact-b"), ("e2", "fact-b", "fact-c")] {
        conn.execute(
            "INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at)
             VALUES (?1, 'entity-alpha', ?2, ?3, 'supports', 1)",
            rusqlite::params![id, src, dst],
        )
        .expect("insert edge");
    }

    // 3. Traverse from the anchor, 2 hops outbound. The engine owns the
    //    snapshot transaction here (connection entry path, REQ-SQL-01);
    //    the caller-supplied clock now_ms drives staleness fields.
    let engine = GraphRagEngine::new(EngineConfig::default());
    let request = TraversalRequest {
        entity_id: "entity-alpha".to_string(),
        source_id: "fact-a".to_string(),
        options: TraversalOptions {
            max_depth: Some(2.0),
            direction: Some(graphrag_core::types::Direction::Outbound),
            ..TraversalOptions::default()
        },
    };
    let neighborhood = engine
        .traverse(&conn, &request, 1_700_000_010_000)
        .expect("traverse must succeed on the seeded graph");

    // 4. Print the typed result as TS-shaped JSON and exit 0.
    println!(
        "{}",
        serde_json::to_string_pretty(&neighborhood).expect("serialize")
    );
    println!(
        "\nproof: {} nodes, {} edges — headless pipeline OK",
        neighborhood.nodes.len(),
        neighborhood.edges.len()
    );
}
