//! Hydration tests: REQ-SLICE-01 ordered chunked fact fetch (Task 9).
//!
//! Baseline: EntryRepository.findByIds (packages/core/src/repositories/
//! EntryRepository.ts:115-146) + mapRowToFact (lines 33-80). The native port
//! chunks ids (default 500, matching line 109), scopes by entity only when
//! entity ids are supplied, always excludes soft-deleted rows, restores INPUT
//! id order with first-match-wins, and mirrors every mapRowToFact coercion
//! including the derived isStale/trustTier fields. Declared difference
//! (REQ-SLICE-02): `now_ms` is a caller parameter instead of per-row
//! `Date.now()`, so the clock is pinned in tests.

use graphrag_core::error::GraphragError;
use graphrag_core::hydrate::hydrate_facts;
use rusqlite::Connection;
use serde_json::Value;

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

fn create_db(conn: &Connection) {
    conn.execute_batch(ENTRIES_DDL).unwrap();
}

fn load_fixture(category: &str, name: &str) -> Value {
    let path = format!("{FIXTURE_DIR}/{category}/{name}.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {path} unreadable: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {path} unparsable: {e}"))
}

/// Seed a row with explicit column overrides; omitted columns take schema
/// defaults (tags '[]', confidence 'inferred', access_count 0, ...).
fn seed_row(conn: &Connection, id: &str, entity_id: &str, overrides: &[(&str, Value)]) {
    let mut cols = vec![
        "id",
        "entity_id",
        "title",
        "body",
        "created_at",
        "updated_at",
    ];
    let mut vals: Vec<String> = vec![
        format!("'{}'", id.replace('\'', "''")),
        format!("'{}'", entity_id.replace('\'', "''")),
        format!("'title-{}'", id.replace('\'', "''")),
        format!("'body-{}'", id.replace('\'', "''")),
        "1".to_string(),
        "1".to_string(),
    ];
    for (col, v) in overrides {
        cols.push(col);
        vals.push(match v {
            Value::Null => "NULL".to_string(),
            Value::String(s) => format!("'{}'", s.replace('\'', "''")),
            other => other.to_string(),
        });
    }
    let sql = format!(
        "INSERT INTO {PREFIX}entries ({}) VALUES ({})",
        cols.join(", "),
        vals.join(", ")
    );
    conn.execute(&sql, []).unwrap();
}

fn id(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

// ---- 1. input-order restoration (interleaved insert order) ----

#[test]
fn restores_input_order_not_insert_order() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    // Insert order: c, a, b — input order must win.
    seed_row(&conn, "c", "entity1", &[]);
    seed_row(&conn, "a", "entity1", &[]);
    seed_row(&conn, "b", "entity1", &[]);

    let got = hydrate_facts(
        &conn,
        PREFIX,
        &["b".into(), "a".into(), "c".into()],
        &[],
        500,
        0,
    )
    .unwrap();
    let got_ids: Vec<&str> = got.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(got_ids, vec!["b", "a", "c"]);
}

// ---- 2. missing id silently dropped ----

#[test]
fn missing_ids_silently_dropped() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(&conn, "a", "entity1", &[]);

    let got = hydrate_facts(&conn, PREFIX, &["a".into(), "nope".into()], &[], 500, 0).unwrap();
    let got_ids: Vec<&str> = got.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(got_ids, vec!["a"]);
}

// ---- 3. duplicate input id yields single row ----

#[test]
fn duplicate_input_ids_yield_single_row() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    // Two physical rows with the same id can't exist (id is PRIMARY KEY), so
    // first-match-wins is asserted via duplicated INPUT ids: TS Map-based
    // restore emits the row once per UNIQUE id, not once per occurrence.
    seed_row(&conn, "a", "entity1", &[]);

    let got = hydrate_facts(
        &conn,
        PREFIX,
        &["a".into(), "a".into(), "a".into()],
        &[],
        500,
        0,
    )
    .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].id, "a");
}

// ---- 4. chunking across 1200 ids ----

#[test]
fn chunks_beyond_variable_limit_preserve_order() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    // Insert in REVERSE order so input-order restoration is observable.
    for i in (0..1200).rev() {
        seed_row(&conn, &format!("id{i:04}"), "entity1", &[]);
    }
    let ids: Vec<String> = (0..1200).map(|i| format!("id{i:04}")).collect();

    let got = hydrate_facts(&conn, PREFIX, &ids, &[], 500, 0).unwrap();
    assert_eq!(got.len(), 1200);
    for (i, fact) in got.iter().enumerate() {
        assert_eq!(fact.id, format!("id{i:04}"), "order must match input");
    }
}

// ---- 5. chunk_size 0 rejected ----

#[test]
fn chunk_size_zero_rejected() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    let err = hydrate_facts(&conn, PREFIX, &["a".into()], &[], 0, 0).unwrap_err();
    assert!(matches!(err, GraphragError::InvalidArgument { .. }));
}

// ---- 6. entity scoping ----

#[test]
fn entity_ids_scope_results() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(&conn, "in", "entity1", &[]);
    seed_row(&conn, "out", "entity2", &[]);

    let scoped = hydrate_facts(
        &conn,
        PREFIX,
        &["in".into(), "out".into()],
        &["entity1".to_string()],
        500,
        0,
    )
    .unwrap();
    let scoped_ids: Vec<&str> = scoped.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(scoped_ids, vec!["in"]);

    // Empty entity_ids -> no scoping.
    let unscoped = hydrate_facts(&conn, PREFIX, &["in".into(), "out".into()], &[], 500, 0).unwrap();
    assert_eq!(unscoped.len(), 2);
}

// ---- 7. soft-deleted excluded ----

#[test]
fn soft_deleted_excluded() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(&conn, "live", "entity1", &[]);
    seed_row(
        &conn,
        "dead",
        "entity1",
        &[("deleted_at", Value::from(123))],
    );

    let got = hydrate_facts(&conn, PREFIX, &["live".into(), "dead".into()], &[], 500, 0).unwrap();
    let got_ids: Vec<&str> = got.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(got_ids, vec!["live"]);
}

// ---- 8. mapper coercions (mapRowToFact parity) ----

#[test]
fn bad_tags_json_falls_back_to_empty() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(&conn, "a", "entity1", &[("tags", Value::from("not-json{"))]);
    let got = hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 0).unwrap();
    assert!(got[0].tags.is_empty());
}

#[test]
fn non_array_okf_verified_falls_back_to_empty_unverified() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(
        &conn,
        "a",
        "entity1",
        &[("okf_verified", Value::from(r#"{"by":"human:x"}"#))],
    );
    let got = hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 0).unwrap();
    assert_eq!(got[0].okf_verified, serde_json::json!([]));
    assert_eq!(got[0].trust_tier, "unverified");
}

#[test]
fn array_okf_usage_window_rejected_to_null() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(
        &conn,
        "a",
        "entity1",
        &[("okf_usage_window", Value::from("[1,2]"))],
    );
    let got = hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 0).unwrap();
    assert_eq!(got[0].okf_usage_window, Value::Null);
}

#[test]
fn nullability_coercions_match_maprowtofact() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    // All nullable columns NULL, lifecycle_status NULL (schema default only
    // applies when omitted; explicit NULL tests the `?? 'stable'` coercion).
    // access_count is NOT NULL in the shipped schema, so the `?? 0` coercion
    // is exercised with an explicit NULL under a relaxed table: rebuild the
    // column as nullable, mirroring what mapRowToFact must tolerate from
    // legacy/external databases.
    conn.execute_batch(
        "ALTER TABLE llm_wiki_entries RENAME TO entries_relaxed;
         CREATE TABLE llm_wiki_entries (
           id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, title TEXT NOT NULL,
           body TEXT NOT NULL, tags TEXT, confidence TEXT, source_type TEXT,
           source_hash TEXT, source_ref TEXT, created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, last_accessed_at INTEGER,
           access_count INTEGER, deleted_at INTEGER, okf_type TEXT,
           lifecycle_status TEXT, stale_after INTEGER, generated_by TEXT,
           last_verified_at INTEGER, last_verified_by TEXT, okf_sources TEXT,
           okf_verified TEXT, okf_usage_window TEXT
         );",
    )
    .unwrap();
    seed_row(
        &conn,
        "a",
        "entity1",
        &[
            ("source_hash", Value::Null),
            ("source_ref", Value::Null),
            ("okf_type", Value::Null),
            ("generated_by", Value::Null),
            ("last_accessed_at", Value::Null),
            ("deleted_at", Value::Null),
            ("last_verified_at", Value::Null),
            ("last_verified_by", Value::Null),
            ("lifecycle_status", Value::Null),
            ("access_count", Value::Null),
            ("stale_after", Value::Null),
        ],
    );
    let f = &hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 0).unwrap()[0];
    assert_eq!(f.source_hash, None);
    assert_eq!(f.source_ref, None);
    assert_eq!(f.okf_type, None);
    assert_eq!(f.generated_by, None);
    assert_eq!(f.last_accessed_at, None);
    assert_eq!(f.deleted_at, None);
    assert_eq!(f.last_verified_at, None);
    assert_eq!(f.last_verified_by, None);
    assert_eq!(f.lifecycle_status, "stable");
    assert_eq!(f.access_count, 0);
    assert_eq!(f.stale_after, None);
    assert_eq!(f.okf_sources, serde_json::json!([]));
}

// ---- 9. derived fields + now_ms parameter ----

#[test]
fn derived_fields_from_stale_after_and_okf_verified() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(
        &conn,
        "a",
        "entity1",
        &[
            ("stale_after", Value::from(1_577_836_800_000_i64)),
            (
                "okf_verified",
                Value::from(r#"[{"by":"human:x","at":"2025-01-01T00:00:00Z"}]"#),
            ),
        ],
    );
    let f = &hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 1_600_000_000_000).unwrap()[0];
    assert!(f.is_stale);
    assert_eq!(f.trust_tier, "human-reviewed");
}

#[test]
fn now_ms_parameter_is_respected_by_caller() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    seed_row(
        &conn,
        "a",
        "entity1",
        &[("stale_after", Value::from(1_600_000_000_000_i64))],
    );

    let before =
        &hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 1_599_999_999_999).unwrap()[0];
    assert!(!before.is_stale);

    let after =
        &hydrate_facts(&conn, PREFIX, &["a".into()], &[], 500, 1_600_000_000_000).unwrap()[0];
    assert!(after.is_stale);
}

// ---- 10. fixture replay: time_derived_fact_fields.json ----

#[test]
fn replays_time_derived_fact_fields_fixture() {
    let conn = Connection::open_in_memory().unwrap();
    create_db(&conn);
    let fixture = load_fixture("parity", "time_derived_fact_fields");
    let entity = fixture["entityId"].as_str().unwrap();

    // Per fixture notes: stale_after 2020-01-01 epoch ms keeps isStale true
    // for any current clock; okf_verified human:reviewer pins trustTier
    // human-reviewed on 'a'; 'b' stays default (isStale false, unverified).
    seed_row(
        &conn,
        "a",
        entity,
        &[
            ("stale_after", Value::from(1_577_836_800_000_i64)),
            (
                "okf_verified",
                Value::from(r#"[{"by":"human:reviewer-1","at":"2025-01-01T00:00:00Z"}]"#),
            ),
        ],
    );
    seed_row(&conn, "b", entity, &[]);

    let facts = hydrate_facts(
        &conn,
        PREFIX,
        &fixture["expectedNodeIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(id)
            .collect::<Vec<_>>(),
        &[entity.to_string()],
        500,
        1_600_000_000_000,
    )
    .unwrap();

    let expected = fixture["expectedFactProjections"].as_array().unwrap();
    assert_eq!(facts.len(), expected.len());
    for (fact, want) in facts.iter().zip(expected.iter()) {
        assert_eq!(Value::from(fact.id.as_str()), want["id"]);
        assert_eq!(Value::from(fact.is_stale), want["isStale"]);
        assert_eq!(Value::from(fact.trust_tier.as_str()), want["trustTier"]);
    }
}
