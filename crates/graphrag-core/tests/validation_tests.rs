//! REQ-INPUT-01 validation matrix tests (Task 3).
//!
//! RED phase: `validation` module not yet implemented — this file must fail
//! to compile until `validate_request` and `ResolvedInputs` exist.

use graphrag_core::error::GraphragError;
use graphrag_core::types::{
    Confidence, Direction, EngineConfig, TraversalOptions, TraversalRequest,
};
use graphrag_core::validation::validate_request;

/// A valid request with all-empty options.
fn base_request() -> TraversalRequest {
    TraversalRequest {
        entity_id: "entity-alpha".to_string(),
        source_id: "fact-1".to_string(),
        options: TraversalOptions::default(),
    }
}

fn config_with(
    max_nodes: Option<f64>,
    min_conf: Option<Confidence>,
    direction: Option<Direction>,
    exclude: Option<Vec<String>>,
) -> EngineConfig {
    EngineConfig {
        table_prefix: "llm_wiki_".to_string(),
        max_traversal_nodes: max_nodes,
        min_traversal_confidence: min_conf,
        traversal_direction: direction,
        exclude_source_types: exclude,
    }
}

// ---------------------------------------------------------------------------
// entity_id / source_id presence
// ---------------------------------------------------------------------------

#[test]
fn missing_entity_id_is_invalid_argument_naming_field() {
    let mut req = base_request();
    req.entity_id = String::new();
    match validate_request(&req, &EngineConfig::default()) {
        Err(GraphragError::InvalidArgument { field, .. }) => assert_eq!(field, "entity_id"),
        other => panic!("expected InvalidArgument(entity_id), got {:?}", other),
    }
}

#[test]
fn missing_source_id_is_invalid_argument_naming_field() {
    let mut req = base_request();
    req.source_id = String::new();
    match validate_request(&req, &EngineConfig::default()) {
        Err(GraphragError::InvalidArgument { field, .. }) => assert_eq!(field, "source_id"),
        other => panic!("expected InvalidArgument(source_id), got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// max_depth hardening (direct-API: NaN / +inf / -inf)
// ---------------------------------------------------------------------------

#[test]
fn max_depth_nan_is_invalid_argument() {
    let mut req = base_request();
    req.options.max_depth = Some(f64::NAN);
    match validate_request(&req, &EngineConfig::default()) {
        Err(GraphragError::InvalidArgument { field, .. }) => assert_eq!(field, "maxDepth"),
        other => panic!("expected InvalidArgument(maxDepth), got {:?}", other),
    }
}

#[test]
fn max_depth_positive_infinity_is_invalid_argument() {
    let mut req = base_request();
    req.options.max_depth = Some(f64::INFINITY);
    assert!(matches!(
        validate_request(&req, &EngineConfig::default()),
        Err(GraphragError::InvalidArgument { .. })
    ));
}

#[test]
fn max_depth_negative_infinity_is_invalid_argument() {
    let mut req = base_request();
    req.options.max_depth = Some(f64::NEG_INFINITY);
    assert!(matches!(
        validate_request(&req, &EngineConfig::default()),
        Err(GraphragError::InvalidArgument { .. })
    ));
}

// ---------------------------------------------------------------------------
// max_depth clamping: d = max(1, min(maxDepth ?? 1, 3)), unrounded
// ---------------------------------------------------------------------------

#[test]
fn max_depth_zero_clamps_up_to_one() {
    let mut req = base_request();
    req.options.max_depth = Some(0.0);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 1.0);
}

#[test]
fn max_depth_four_clamps_down_to_three() {
    let mut req = base_request();
    req.options.max_depth = Some(4.0);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 3.0);
}

#[test]
fn max_depth_one_point_five_is_unrounded() {
    let mut req = base_request();
    req.options.max_depth = Some(1.5);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 1.5);
}

#[test]
fn max_depth_none_defaults_to_one() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 1.0);
}

// ---------------------------------------------------------------------------
// direction: call > config > Both; unknown strings rejected upstream by
// serde, but the direct Rust API must also reject when possible
// ---------------------------------------------------------------------------

#[test]
fn direction_defaults_to_both() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.direction, Direction::Both);
}

#[test]
fn config_direction_used_when_call_omits() {
    let resolved = validate_request(
        &base_request(),
        &config_with(None, None, Some(Direction::Inbound), None),
    )
    .unwrap();
    assert_eq!(resolved.direction, Direction::Inbound);
}

#[test]
fn call_direction_overrides_config() {
    let mut req = base_request();
    req.options.direction = Some(Direction::Outbound);
    let resolved = validate_request(
        &req,
        &config_with(None, None, Some(Direction::Inbound), None),
    )
    .unwrap();
    assert_eq!(resolved.direction, Direction::Outbound);
}

// ---------------------------------------------------------------------------
// edge_types: None = no filter; Some([]) = match nothing (preserved)
// ---------------------------------------------------------------------------

#[test]
fn edge_types_none_passes_through_as_none() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.edge_types, None);
}

#[test]
fn edge_types_empty_vec_preserved_as_match_nothing() {
    let mut req = base_request();
    req.options.edge_types = Some(vec![]);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.edge_types, Some(vec![] as Vec<String>));
}

// ---------------------------------------------------------------------------
// min_confidence: call > config > Tentative
// ---------------------------------------------------------------------------

#[test]
fn min_confidence_defaults_to_tentative() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.min_confidence, Confidence::Tentative);
}

#[test]
fn config_min_confidence_used_when_call_omits() {
    let resolved = validate_request(
        &base_request(),
        &config_with(None, Some(Confidence::Certain), None, None),
    )
    .unwrap();
    assert_eq!(resolved.min_confidence, Confidence::Certain);
}

#[test]
fn call_min_confidence_overrides_config() {
    let mut req = base_request();
    req.options.min_traversal_confidence = Some(Confidence::Inferred);
    let resolved = validate_request(
        &req,
        &config_with(None, Some(Confidence::Certain), None, None),
    )
    .unwrap();
    assert_eq!(resolved.min_confidence, Confidence::Inferred);
}

// ---------------------------------------------------------------------------
// exclude_source_types: call (even empty) > config > []
// ---------------------------------------------------------------------------

#[test]
fn exclude_source_types_defaults_to_empty() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.exclude_source_types, Vec::<String>::new());
}

#[test]
fn exclude_source_types_call_empty_overrides_config() {
    let mut req = base_request();
    req.options.exclude_source_types = Some(vec![]);
    let resolved = validate_request(
        &req,
        &config_with(None, None, None, Some(vec!["legacy_note".to_string()])),
    )
    .unwrap();
    assert_eq!(resolved.exclude_source_types, Vec::<String>::new());
}

#[test]
fn exclude_source_types_config_used_when_call_omits() {
    let resolved = validate_request(
        &base_request(),
        &config_with(
            None,
            None,
            None,
            Some(vec!["legacy_note".to_string(), "sensor".to_string()]),
        ),
    )
    .unwrap();
    assert_eq!(
        resolved.exclude_source_types,
        vec!["legacy_note".to_string(), "sensor".to_string()]
    );
}

#[test]
fn exclude_source_types_call_overrides_config() {
    let mut req = base_request();
    req.options.exclude_source_types = Some(vec!["opaque-value".to_string()]);
    let resolved = validate_request(
        &req,
        &config_with(None, None, None, Some(vec!["legacy_note".to_string()])),
    )
    .unwrap();
    assert_eq!(
        resolved.exclude_source_types,
        vec!["opaque-value".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Cap sanitization chain (f64-then-floor; i64 boundary)
// ---------------------------------------------------------------------------

#[test]
fn cap_none_none_defaults_to_20() {
    let resolved = validate_request(&base_request(), &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_nodes, 20);
}

#[test]
fn cap_call_fractional_floors() {
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(1.9);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_nodes, 1);
}

#[test]
fn cap_call_nan_falls_to_config() {
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(f64::NAN);
    let resolved = validate_request(&req, &config_with(Some(5.0), None, None, None)).unwrap();
    assert_eq!(resolved.max_nodes, 5);
}

#[test]
fn cap_both_invalid_falls_to_20() {
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(0.5); // < 1.0 → invalid
    let resolved = validate_request(&req, &config_with(Some(-3.0), None, None, None)).unwrap();
    assert_eq!(resolved.max_nodes, 20);
}

#[test]
fn cap_call_huge_exceeding_i64_is_unsupported_limit() {
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(1e20);
    match validate_request(&req, &EngineConfig::default()) {
        Err(GraphragError::UnsupportedLimit { field, value }) => {
            assert_eq!(field, "maxTraversalNodes");
            assert_eq!(value, 1e20_f64.floor());
        }
        other => panic!(
            "expected UnsupportedLimit(maxTraversalNodes), got {:?}",
            other
        ),
    }
}

#[test]
fn cap_call_9_3e18_floors_above_i64_max_is_unsupported_limit() {
    // Pre-verified: 9.3e18 floors to 9.3e18 exactly (f64 representable),
    // which exceeds i64::MAX = 9.223372036854775807e18.
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(9.3e18);
    match validate_request(&req, &EngineConfig::default()) {
        Err(GraphragError::UnsupportedLimit { field, .. }) => {
            assert_eq!(field, "maxTraversalNodes");
        }
        other => panic!(
            "expected UnsupportedLimit(maxTraversalNodes), got {:?}",
            other
        ),
    }
}

#[test]
fn cap_call_9_2e18_floors_within_range_is_accepted() {
    // Pre-verified: 9.2e18 floors within i64 range → accepted.
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(9.2e18);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_nodes, 9_200_000_000_000_000_000u64);
}

#[test]
fn cap_call_9_223372036854775e18_floors_within_range_is_accepted() {
    // Pre-verified: 9.223372036854775e18 floors to 9223372036854774784,
    // which is <= i64::MAX → accepted.
    let mut req = base_request();
    req.options.max_traversal_nodes = Some(9.223372036854775e18);
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_nodes, 9_223_372_036_854_774_784u64);
}

// ---------------------------------------------------------------------------
// camelCase JSON binding (REQ-INPUT-01 TS shape) end-to-end through
// TraversalOptions → validate_request
// ---------------------------------------------------------------------------

#[test]
fn camelcase_json_binds_and_validates_end_to_end() {
    // REQ-INPUT-01 (amended, commit 72d8964): camelCase is the binding form
    // for TraversalOptions. `TraversalRequest` itself is a plain Rust struct
    // (the host supplies entity/source ids directly), so JSON binding is
    // exercised on the options payload — exactly what the TS bridge sends.
    let opts: TraversalOptions =
        serde_json::from_str(r#"{"maxDepth":2,"edgeTypes":[]}"#).expect("deserialize");
    let req = TraversalRequest {
        entity_id: "entity-alpha".to_string(),
        source_id: "fact-1".to_string(),
        options: opts,
    };
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 2.0);
    assert_eq!(resolved.edge_types, Some(vec![] as Vec<String>));
}

#[test]
fn snake_case_options_keys_are_ignored_as_unknown() {
    // REQ-INPUT-01 pins the TS input shape: camelCase only. snake_case keys
    // inside `options` must not bind (they land as ignored unknown keys).
    let opts: TraversalOptions =
        serde_json::from_str(r#"{"max_depth":2,"edge_types":[]}"#).expect("deserialize");
    let req = TraversalRequest {
        entity_id: "e".to_string(),
        source_id: "s".to_string(),
        options: opts,
    };
    let resolved = validate_request(&req, &EngineConfig::default()).unwrap();
    assert_eq!(resolved.max_depth, 1.0); // max_depth key ignored → default
    assert_eq!(resolved.edge_types, None); // edge_types key ignored → None
}
