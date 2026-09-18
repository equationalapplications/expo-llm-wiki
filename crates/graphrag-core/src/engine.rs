//! Public engine assembly (Task 10, REQ-SQL-01).
//!
//! [`GraphRagEngine`] composes schema validation, request validation, walk,
//! induced-edge fetch, and hydration into one neighborhood read. Two distinct
//! entry paths — never an ambiguous function that guesses transaction
//! ownership:
//!
//! - [`GraphRagEngine::traverse`] takes a bare [`Connection`]. The engine
//!   BEGINS a deferred read transaction (one snapshot for all neighborhood
//!   queries), runs the pipeline, and ENDS it before returning; on error the
//!   transaction is rolled back and never left open.
//! - [`GraphRagEngine::traverse_tx`] takes a host-owned [`Transaction`]. The
//!   engine never begins, commits, or rolls back: reads run inside the
//!   caller's transaction, and an engine error leaves it open and usable.
//!
//! Edge re-filter: `induced_edges` guarantees both endpoints ∈ walk node ids,
//! but hydration silently drops soft-deleted rows. Mirroring the baseline
//! GraphTraversalService (lines 42-45), edges are re-filtered after hydration
//! so only edges with both endpoints present in the hydrated set survive
//! ([`filter_induced_edges`]).

use std::collections::HashSet;

use rusqlite::{Connection, Transaction};

use crate::edges::induced_edges;
use crate::error::GraphragError;
use crate::hydrate::hydrate_facts;
use crate::schema_check::validate_schema_conn;
use crate::types::{EngineConfig, GraphNeighborhood, TraversalRequest, WikiEdge};
use crate::validation::validate_request;
use crate::walk::walk;

/// Default chunk size for edge fetch and hydration (EntryRepository.chunkSize).
const CHUNK_SIZE: usize = 500;

/// The assembled engine. Clones its config per call path; cheap.
#[derive(Debug, Clone)]
pub struct GraphRagEngine {
    config: EngineConfig,
}

impl GraphRagEngine {
    pub fn new(config: EngineConfig) -> Self {
        GraphRagEngine { config }
    }

    /// Connection entry path: host has exclusive access and is NOT in a
    /// transaction. The engine opens a deferred read transaction, performs
    /// every neighborhood query inside that one snapshot, and ends the
    /// transaction before returning. On error the snapshot is rolled back
    /// (see [`SnapshotGuard`]) and the error propagated; no transaction is
    /// ever left open on the connection.
    pub fn traverse(
        &self,
        conn: &Connection,
        req: &TraversalRequest,
        now_ms: i64,
    ) -> Result<GraphNeighborhood, GraphragError> {
        let snapshot = SnapshotGuard::begin(conn)?;
        let result = {
            // Deref coercion: &Transaction -> &Connection.
            let tx = snapshot.tx.as_ref().expect("guard holds its snapshot");
            self.run(tx, req, now_ms)
        };
        match result {
            Ok(hood) => {
                snapshot.end()?;
                Ok(hood)
            }
            Err(err) => {
                snapshot.rollback();
                Err(err)
            }
        }
    }

    /// Transaction entry path: host owns the transaction. Same pipeline, but
    /// the engine never begins, commits, or rolls back anything — reads run
    /// inside the caller's transaction and an engine error leaves that
    /// transaction open and usable.
    pub fn traverse_tx(
        &self,
        tx: &Transaction<'_>,
        req: &TraversalRequest,
        now_ms: i64,
    ) -> Result<GraphNeighborhood, GraphragError> {
        self.run(tx, req, now_ms)
    }

    /// Shared pipeline: validate schema → validate request → walk → induced
    /// edges (chunk 500) → hydrate (chunk 500) → re-filter edges → assemble.
    fn run(
        &self,
        reader: &Connection,
        req: &TraversalRequest,
        now_ms: i64,
    ) -> Result<GraphNeighborhood, GraphragError> {
        let prefix = &self.config.table_prefix;
        validate_schema_conn(reader, prefix)?;
        let resolved = validate_request(req, &self.config)?;
        let walked = walk(reader, prefix, &resolved, &req.entity_id, &req.source_id)?;
        let edges = induced_edges(reader, prefix, &walked.node_ids, &req.entity_id, CHUNK_SIZE)?;
        let nodes = hydrate_facts(
            reader,
            prefix,
            &walked.node_ids,
            std::slice::from_ref(&req.entity_id),
            CHUNK_SIZE,
            now_ms,
        )?;

        // Hydration dropped soft-deleted rows; edges whose endpoints no
        // longer hydrate must not dangle in the DTO (baseline 42-45 parity).
        let hydrated_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
        let edges = filter_induced_edges(edges, &hydrated_ids);

        Ok(GraphNeighborhood { nodes, edges })
    }
}

/// Re-filter induced edges down to those whose BOTH endpoints are present in
/// the hydrated node set. Baseline GraphTraversalService lines 42-45 parity.
/// Order and edge contents pass through unchanged.
pub fn filter_induced_edges(edges: Vec<WikiEdge>, hydrated_ids: &[String]) -> Vec<WikiEdge> {
    let live: HashSet<&str> = hydrated_ids.iter().map(String::as_str).collect();
    edges
        .into_iter()
        .filter(|e| live.contains(e.source_id.as_str()) && live.contains(e.target_id.as_str()))
        .collect()
}

/// RAII guard for the connection path's snapshot read transaction.
///
/// Begins a deferred transaction via `unchecked_transaction` (read-only in
/// intent: the pipeline only SELECTs). `end` finishes the snapshot on success;
/// `Drop` rolls back whatever is left, so an early `?` or panic can never
/// leave a transaction open on the host's connection.
struct SnapshotGuard<'conn> {
    tx: Option<Transaction<'conn>>,
}

impl<'conn> SnapshotGuard<'conn> {
    fn begin(conn: &'conn Connection) -> Result<Self, GraphragError> {
        let tx = conn.unchecked_transaction().map_err(GraphragError::Sql)?;
        Ok(SnapshotGuard { tx: Some(tx) })
    }

    /// Ends the snapshot. Read-only pipeline: `finish()` yields the guard's
    /// default Rollback drop behavior, which is behaviorally identical to
    /// COMMIT for a transaction that only SELECTed — and strictly safer.
    fn end(mut self) -> Result<(), GraphragError> {
        if let Some(tx) = self.tx.take() {
            tx.finish().map_err(GraphragError::Sql)?;
        }
        Ok(())
    }

    fn rollback(mut self) {
        self.tx = None; // Transaction::drop rolls back.
    }
}

impl Drop for SnapshotGuard<'_> {
    fn drop(&mut self) {
        // Dropping the Transaction rolls back if not already finished.
        self.tx = None;
    }
}
