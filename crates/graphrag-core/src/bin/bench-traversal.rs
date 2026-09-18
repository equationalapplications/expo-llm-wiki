//! Bench-traversal harness scaffold (REQ-PERF-01, Task 12).
//!
//! A runnable, dependency-free timing harness: seeds an in-memory SQLite
//! graph with N entries and ~2N edges, then calls
//! [`GraphRagEngine::traverse`] M times and prints total wall time plus the
//! mean microseconds per traversal. This is a SCAFFOLD, not a benchmark
//! suite — output is "deterministic-ish" wall-clock timing on whatever
//! machine runs it, and makes no publishable performance claims (see the
//! crate README's performance disclaimers). A criterion-based bench under
//! `benches/` is deferred until there are numbers worth publishing.
//!
//! Run:
//!
//!     cargo run -p graphrag-core --bin bench-traversal
//!
//! Exits 0 on success; nonzero if seeding or any traversal errors.

use std::time::Instant;

use graphrag_core::engine::GraphRagEngine;
use graphrag_core::types::{Direction, EngineConfig, TraversalOptions, TraversalRequest};
use rusqlite::Connection;

/// Nodes in the seeded graph (plan Task 12: N=1000).
const NODES: usize = 1000;
/// Traversal repetitions for the mean.
const RUNS: usize = 50;

/// Schema-accurate `llm_wiki_entries` DDL (same shape as examples/proof.rs).
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

/// Verbatim `llm_wiki_meta` DDL; schema_version must equal 11 (REQ-SQL-04).
const META_DDL: &str = "CREATE TABLE IF NOT EXISTS llm_wiki_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );";

fn main() {
    let conn = Connection::open_in_memory().expect("open in-memory sqlite");
    conn.execute_batch(&format!("{ENTRIES_DDL}\n{EDGES_DDL}\n{META_DDL}"))
        .expect("create llm_wiki_* schema");
    conn.execute(
        "INSERT INTO llm_wiki_meta (key, value) VALUES ('schema_version', '11')",
        [],
    )
    .expect("stamp schema_version");

    // Seed N entries in one entity; updated_at DESC gives the walk a stable
    // visit order. All facts pass the discovery gates (inferred confidence,
    // librarian_inferred source type, never soft-deleted).
    //
    // Topology: hub-and-leaf. The engine clamps maxDepth to 3 (baseline
    // parity, validation.rs), so a chain would leave almost the whole graph
    // unreachable (depth ~N). Instead the anchor fans out to HUBS hub nodes
    // (depth 1) and every remaining entry is a leaf (depth 2) with two
    // inbound hub edges — the depth-3 BFS reaches ~all N nodes and the edge
    // count lands near 2 per node, matching the plan's "1000 entries,
    // ~2000 edges" shape.
    const HUBS: usize = 30;
    conn.execute("BEGIN", []).expect("begin seed");
    for i in 0..NODES {
        conn.execute(
            "INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence,
             source_type, created_at, updated_at)
             VALUES (?1, 'bench-entity', 't', 'b', 'inferred', 'librarian_inferred', 1, ?2)",
            rusqlite::params![format!("fact-{i:04}"), 1_000_000 - i as i64],
        )
        .expect("insert fact");
    }
    // fact-0000 is the anchor; 1..=HUBS are hubs; the rest are leaves.
    let mut edge_no: usize = 0;
    let mut add_edge = |src: usize, dst: usize| {
        conn.execute(
            "INSERT INTO llm_wiki_edges (id, entity_id, source_id, target_id, edge_type, created_at)
             VALUES (?1, 'bench-entity', ?2, ?3, 'supports', 1)",
            rusqlite::params![
                format!("edge-{edge_no:05}"),
                format!("fact-{src:04}"),
                format!("fact-{dst:04}")
            ],
        )
        .expect("insert edge");
        edge_no += 1;
    };
    for h in 1..=HUBS {
        add_edge(0, h); // anchor -> hub (depth 1)
    }
    for leaf in (HUBS + 1)..NODES {
        // Two inbound hub edges per leaf, round-robin with a stagger so the
        // second hub differs from the first (~2 edges per node overall).
        add_edge(1 + (leaf - HUBS - 1) % HUBS, leaf);
        add_edge(1 + (leaf - HUBS - 1 + HUBS / 2) % HUBS, leaf);
    }
    conn.execute("COMMIT", []).expect("commit seed");

    let engine = GraphRagEngine::new(EngineConfig::default());
    let request = TraversalRequest {
        entity_id: "bench-entity".to_string(),
        source_id: "fact-0000".to_string(),
        options: TraversalOptions {
            // Engine clamps maxDepth to 3; the hub-and-leaf topology puts every
            // node within depth 2 of the anchor, so the walk covers the graph.
            // max_traversal_nodes caps it at the seeded population.
            max_depth: Some(f64::from(NODES as u32)),
            direction: Some(Direction::Outbound),
            max_traversal_nodes: Some(NODES as f64),
            ..TraversalOptions::default()
        },
    };

    // Warm-up run (page cache, statement prep) — not timed.
    let warmup = engine
        .traverse(&conn, &request, 1_700_000_000_000)
        .expect("warm-up traversal");
    println!(
        "seed: {} entries, {} edges; traversal returned {} nodes, {} edges",
        NODES,
        edge_no,
        warmup.nodes.len(),
        warmup.edges.len()
    );

    let start = Instant::now();
    for _ in 0..RUNS {
        let hood = engine
            .traverse(&conn, &request, 1_700_000_000_000)
            .expect("timed traversal");
        std::hint::black_box(&hood);
    }
    let total = start.elapsed();

    let total_us = total.as_micros();
    let mean_us = total_us / RUNS as u128;
    println!("runs: {RUNS}");
    println!("total_us: {total_us}");
    println!("mean_us_per_traversal: {mean_us}");
    println!("bench-traversal: OK");
}
