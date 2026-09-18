//! DTO and option types, pinned to `packages/core/src/types.ts` (Task 2).
//!
//! `confidence` and `source_type` are **opaque `String`s** on the native DTO:
//! the baseline's `mapRowToFact` passes persisted values through unvalidated,
//! and REQ-SLICE-02 requires out-of-enum values to round-trip (category-a
//! fixture). Never model them as Rust enums here.
//!
//! Serialized JSON keys must match the TS DTO exactly: every field is already
//! snake_case in TS except `isStale`/`trustTier`, which get explicit renames.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct WikiEdge {
    pub id: String,
    pub entity_id: String,
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub created_at: f64, // i64 ms epoch; f64 only to mirror JS Number in JSON. Use i64 internally.
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WikiFact {
    pub id: String,
    pub entity_id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub confidence: String,
    pub source_type: String,
    pub source_hash: Option<String>,
    pub source_ref: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_accessed_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub access_count: i64,
    pub okf_type: Option<String>,
    pub lifecycle_status: String, // default 'stable'
    pub stale_after: Option<i64>,
    pub generated_by: Option<String>,
    pub okf_sources: serde_json::Value, // JSON array, parsed per rowMappers.parseJsonArray
    pub okf_verified: serde_json::Value, // JSON array
    pub okf_usage_window: serde_json::Value, // JSON object or null
    pub last_verified_at: Option<i64>,
    pub last_verified_by: Option<String>,
    #[serde(rename = "isStale")]
    pub is_stale: bool, // serialized camelCase: isStale
    #[serde(rename = "trustTier")]
    pub trust_tier: String, // trustTier
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Inbound,
    Outbound,
    Both,
}

impl Direction {
    /// The exact TS wire strings, in enum order.
    pub const EXACT_STRINGS: [&'static str; 3] = ["inbound", "outbound", "both"];
}

// Custom Deserialize: exact strings only — no case folding, no aliases.
impl<'de> Deserialize<'de> for Direction {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "inbound" => Ok(Direction::Inbound),
            "outbound" => Ok(Direction::Outbound),
            "both" => Ok(Direction::Both),
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &Direction::EXACT_STRINGS,
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Certain,
    Inferred,
    Tentative,
}

impl Confidence {
    /// Rank order per global constraints: tentative=0, inferred=1, certain=2.
    pub fn rank(self) -> u8 {
        match self {
            Confidence::Tentative => 0,
            Confidence::Inferred => 1,
            Confidence::Certain => 2,
        }
    }

    /// The exact TS wire strings.
    pub const EXACT_STRINGS: [&'static str; 3] = ["certain", "inferred", "tentative"];
}

// Custom Deserialize: exact strings only.
impl<'de> Deserialize<'de> for Confidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "certain" => Ok(Confidence::Certain),
            "inferred" => Ok(Confidence::Inferred),
            "tentative" => Ok(Confidence::Tentative),
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &Confidence::EXACT_STRINGS,
            )),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TraversalOptions {
    #[serde(default)]
    pub max_depth: Option<f64>,
    #[serde(default)]
    pub direction: Option<Direction>, // custom Deserialize: exact strings
    #[serde(default)]
    pub edge_types: Option<Vec<String>>,
    #[serde(default)]
    pub max_traversal_nodes: Option<f64>,
    #[serde(default)]
    pub min_traversal_confidence: Option<Confidence>,
    #[serde(default)]
    pub exclude_source_types: Option<Vec<String>>,
    // Unknown keys ignored: serde's default behavior. Required by REQ-INPUT-01.
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub table_prefix: String, // default "llm_wiki_"
    pub max_traversal_nodes: Option<f64>,
    pub min_traversal_confidence: Option<Confidence>,
    pub traversal_direction: Option<Direction>,
    pub exclude_source_types: Option<Vec<String>>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            table_prefix: String::from("llm_wiki_"),
            max_traversal_nodes: None,
            min_traversal_confidence: None,
            traversal_direction: None,
            exclude_source_types: None,
        }
    }
}

pub struct TraversalRequest {
    pub entity_id: String,
    pub source_id: String,
    pub options: TraversalOptions,
}

#[derive(Debug, Serialize)]
pub struct GraphNeighborhood {
    pub nodes: Vec<WikiFact>, // anchor first, then depth ASC / updated_at DESC
    pub edges: Vec<WikiEdge>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fully-populated WikiFact with an out-of-enum `source_type`
    /// (category-a fixture shape, REQ-SLICE-02).
    fn sample_fact() -> WikiFact {
        WikiFact {
            id: "fact-1".into(),
            entity_id: "entity-alpha".into(),
            title: "Title".into(),
            body: "Body".into(),
            tags: vec!["a".into(), "b".into()],
            confidence: "inferred".into(),
            source_type: "legacy_note".into(),
            source_hash: Some("hash-1".into()),
            source_ref: None,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_005_000,
            last_accessed_at: Some(1_700_000_010_000),
            deleted_at: None,
            access_count: 3,
            okf_type: None,
            lifecycle_status: "stable".into(),
            stale_after: None,
            generated_by: Some("process:importer".into()),
            okf_sources: serde_json::json!([]),
            okf_verified: serde_json::json!([]),
            okf_usage_window: serde_json::Value::Null,
            last_verified_at: None,
            last_verified_by: None,
            is_stale: false,
            trust_tier: "unverified".into(),
        }
    }

    /// Step 2: serialize a WikiFact with an out-of-enum source_type and assert
    /// the JSON keys and values match the TS DTO shape.
    #[test]
    fn wiki_fact_serializes_with_ts_dto_keys() {
        let fact = sample_fact();
        let v: serde_json::Value = serde_json::to_value(&fact).expect("serialize");

        // snake_case keys pass through verbatim.
        assert_eq!(v["id"], "fact-1");
        assert_eq!(v["entity_id"], "entity-alpha");
        assert_eq!(v["source_hash"], "hash-1");
        assert_eq!(v["created_at"], 1_700_000_000_000i64);
        assert_eq!(v["access_count"], 3);
        assert_eq!(v["lifecycle_status"], "stable");
        assert_eq!(v["generated_by"], "process:importer");
        assert!(v["okf_sources"].is_array());
        assert!(v["okf_usage_window"].is_null());

        // The two camelCase TS keys.
        assert_eq!(v["isStale"], false);
        assert_eq!(v["trustTier"], "unverified");
        assert!(v.get("is_stale").is_none(), "must not emit is_stale");
        assert!(v.get("trust_tier").is_none(), "must not emit trust_tier");

        // Exact key set equals the TS WikiFact DTO surface (minus
        // embedding_blob, which the native slice does not carry).
        let mut keys: Vec<&str> = v
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let expected = [
            "access_count",
            "body",
            "confidence",
            "created_at",
            "deleted_at",
            "entity_id",
            "generated_by",
            "id",
            "isStale",
            "last_accessed_at",
            "last_verified_at",
            "last_verified_by",
            "lifecycle_status",
            "okf_sources",
            "okf_type",
            "okf_usage_window",
            "okf_verified",
            "source_hash",
            "source_ref",
            "source_type",
            "stale_after",
            "tags",
            "title",
            "trustTier",
            "updated_at",
        ];
        let mut expected: Vec<&str> = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected);
    }

    /// REQ-SLICE-02: out-of-enum values round-trip unvalidated.
    #[test]
    fn out_of_enum_source_type_and_confidence_round_trip() {
        let mut fact = sample_fact();
        fact.source_type = "category-a".into();
        fact.confidence = "totally-unheard-of".into();
        let json = serde_json::to_string(&fact).expect("serialize");
        let v: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(v["source_type"], "category-a");
        assert_eq!(v["confidence"], "totally-unheard-of");
    }

    #[test]
    fn wiki_edge_serializes_with_ts_keys() {
        let edge = WikiEdge {
            id: "e1".into(),
            entity_id: "entity-alpha".into(),
            source_id: "fact-1".into(),
            target_id: "fact-2".into(),
            edge_type: "supports".into(),
            created_at: 1_700_000_000_000.0,
        };
        let v: serde_json::Value = serde_json::to_value(&edge).expect("serialize");
        assert_eq!(v["entity_id"], "entity-alpha");
        assert_eq!(v["source_id"], "fact-1");
        assert_eq!(v["target_id"], "fact-2");
        assert_eq!(v["edge_type"], "supports");
        assert_eq!(v["created_at"], 1_700_000_000_000.0);
    }

    #[test]
    fn direction_deserializes_exact_strings_only() {
        assert_eq!(
            serde_json::from_str::<Direction>("\"inbound\"").unwrap(),
            Direction::Inbound
        );
        assert_eq!(
            serde_json::from_str::<Direction>("\"outbound\"").unwrap(),
            Direction::Outbound
        );
        assert_eq!(
            serde_json::from_str::<Direction>("\"both\"").unwrap(),
            Direction::Both
        );
        // No case folding, no aliases.
        assert!(serde_json::from_str::<Direction>("\"BOTH\"").is_err());
        assert!(serde_json::from_str::<Direction>("\"bothways\"").is_err());
    }

    #[test]
    fn confidence_deserializes_exact_strings_only() {
        assert_eq!(
            serde_json::from_str::<Confidence>("\"certain\"").unwrap(),
            Confidence::Certain
        );
        assert_eq!(
            serde_json::from_str::<Confidence>("\"inferred\"").unwrap(),
            Confidence::Inferred
        );
        assert_eq!(
            serde_json::from_str::<Confidence>("\"tentative\"").unwrap(),
            Confidence::Tentative
        );
        assert!(serde_json::from_str::<Confidence>("\"Certain\"").is_err());
        assert!(serde_json::from_str::<Confidence>("\"guess\"").is_err());
    }

    #[test]
    fn confidence_rank_order_is_tentative_inferred_certain() {
        assert!(Confidence::Tentative.rank() < Confidence::Inferred.rank());
        assert!(Confidence::Inferred.rank() < Confidence::Certain.rank());
    }

    #[test]
    fn traversal_options_defaults_are_none_and_unknown_keys_ignored() {
        // REQ-INPUT-01: unknown keys ignored; omitted keys default to None.
        let opts: TraversalOptions = serde_json::from_str(
            r#"{
                "max_depth": 2,
                "direction": "outbound",
                "edge_types": ["supports"],
                "max_traversal_nodes": 50,
                "min_traversal_confidence": "inferred",
                "exclude_source_types": ["legacy_note"],
                "futureUnknownKey": { "nested": true }
            }"#,
        )
        .expect("deserialize");
        assert_eq!(opts.max_depth, Some(2.0));
        assert_eq!(opts.direction, Some(Direction::Outbound));
        assert_eq!(opts.edge_types, Some(vec!["supports".to_string()]));
        assert_eq!(opts.max_traversal_nodes, Some(50.0));
        assert_eq!(opts.min_traversal_confidence, Some(Confidence::Inferred));
        assert_eq!(
            opts.exclude_source_types,
            Some(vec!["legacy_note".to_string()])
        );

        // Empty object: every field defaults to None.
        let empty: TraversalOptions = serde_json::from_str("{}").expect("deserialize");
        assert_eq!(empty.max_depth, None);
        assert_eq!(empty.direction, None);
        assert_eq!(empty.edge_types, None);
        assert_eq!(empty.max_traversal_nodes, None);
        assert_eq!(empty.min_traversal_confidence, None);
        assert_eq!(empty.exclude_source_types, None);
    }

    #[test]
    fn engine_config_default_table_prefix() {
        let cfg = EngineConfig::default();
        assert_eq!(cfg.table_prefix, "llm_wiki_");
        assert_eq!(cfg.max_traversal_nodes, None);
        assert_eq!(cfg.min_traversal_confidence, None);
        assert_eq!(cfg.traversal_direction, None);
        assert_eq!(cfg.exclude_source_types, None);
    }

    #[test]
    fn graph_neighborhood_serializes() {
        let hood = GraphNeighborhood {
            nodes: vec![sample_fact()],
            edges: vec![WikiEdge {
                id: "e1".into(),
                entity_id: "entity-alpha".into(),
                source_id: "fact-1".into(),
                target_id: "fact-2".into(),
                edge_type: "supports".into(),
                created_at: 0.0,
            }],
        };
        let v: serde_json::Value = serde_json::to_value(&hood).expect("serialize");
        assert_eq!(v["nodes"].as_array().map(Vec::len), Some(1));
        assert_eq!(v["edges"].as_array().map(Vec::len), Some(1));
        assert_eq!(v["nodes"][0]["entity_id"], "entity-alpha");
        assert_eq!(v["nodes"][0]["isStale"], false);
    }
}
