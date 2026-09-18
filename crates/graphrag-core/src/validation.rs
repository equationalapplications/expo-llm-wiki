//! REQ-INPUT-01 validation matrix (Task 3).
//!
//! Bridges the raw `TraversalRequest` (bound from camelCase TS JSON via
//! `TraversalOptions`) and `EngineConfig` into fully-resolved `ResolvedInputs`
//! for the traversal engine. Precedence everywhere is **call > config >
//! default**. No rounding, no wrapping, no clamping beyond the pinned rules:
//!
//! - `max_depth`: NaN/±∞ → `InvalidArgument`; else `max(1, min(v, 3))`,
//!   unrounded (1.5 stays 1.5).
//! - `max_traversal_nodes`: f64-then-floor sanitization; a value whose floor
//!   exceeds `i64::MAX` is `UnsupportedLimit` — never wrapped or clamped.
//! - enums: unknown strings are already rejected at the JSON layer by the
//!   custom `Deserialize` impls; the direct Rust API carries parsed enums
//!   only, so invalid strings cannot reach this module.

use crate::error::{invalid_argument, GraphragError};
use crate::types::{Confidence, Direction, EngineConfig, TraversalRequest};

/// Fully-resolved traversal inputs; the engine's single source of truth.
#[derive(Debug)]
pub struct ResolvedInputs {
    pub max_depth: f64,                    // clamped real bound, unrounded
    pub direction: Direction,              // call > config > Both
    pub edge_types: Option<Vec<String>>,   // None = no filter; Some([]) = match nothing
    pub min_confidence: Confidence,        // call > config > Tentative
    pub exclude_source_types: Vec<String>, // call (even empty) > config > []
    pub max_nodes: u64,                    // sanitized cap (see `resolve_cap`)
}

/// Accept a cap candidate only if it is finite and >= 1.0; return its floor.
fn sanitize_cap(v: f64) -> Option<f64> {
    if v.is_finite() && v >= 1.0 {
        Some(v.floor())
    } else {
        None
    }
}

/// call > config > hard default 20, with an i64-range hard stop.
///
/// A floor exceeding `i64::MAX` is `UnsupportedLimit` — never wrap, never
/// clamp (REQ-INPUT-01: an absurd cap must fail loudly, not silently bind).
fn resolve_cap(call: Option<f64>, config: Option<f64>) -> Result<u64, GraphragError> {
    let eff = sanitize_cap(call.unwrap_or(f64::NAN))
        .or_else(|| sanitize_cap(config.unwrap_or(f64::NAN)))
        .unwrap_or(20.0);
    // `i64::MAX as f64` rounds UP to 2^63, so a plain `>` would admit exactly
    // 2^63 (which floors to itself, above i64::MAX). Strict lower bound:
    if eff >= 9_223_372_036_854_775_808.0 {
        Err(GraphragError::UnsupportedLimit {
            field: "maxTraversalNodes".into(),
            value: eff,
        })
    } else {
        Ok(eff as u64)
    }
}

/// Validate a traversal request against engine config and resolve all inputs.
pub fn validate_request(
    req: &TraversalRequest,
    config: &EngineConfig,
) -> Result<ResolvedInputs, GraphragError> {
    if req.entity_id.is_empty() {
        return Err(invalid_argument("entity_id", "must be a non-empty string"));
    }
    if req.source_id.is_empty() {
        return Err(invalid_argument("source_id", "must be a non-empty string"));
    }

    let opts = &req.options;

    let max_depth = match opts.max_depth {
        Some(d) if d.is_nan() || d.is_infinite() => {
            return Err(invalid_argument("maxDepth", "must be a finite number"));
        }
        // NaN/±inf already rejected above, so clamp is equivalent to
        // max(1, min(d, 3)) and warning-free under clippy.
        Some(d) => d.clamp(1.0, 3.0),
        None => 1.0,
    };

    let direction = opts
        .direction
        .or(config.traversal_direction)
        .unwrap_or(Direction::Both);
    let min_confidence = opts
        .min_traversal_confidence
        .or(config.min_traversal_confidence)
        .unwrap_or(Confidence::Tentative);

    // Opaque passthrough: no enum/shape validation on these strings anywhere
    // in the chain (REQ-SLICE-02). Call wins even when it is an empty vec.
    let exclude_source_types = opts
        .exclude_source_types
        .clone()
        .or_else(|| config.exclude_source_types.clone())
        .unwrap_or_default();

    let edge_types = opts.edge_types.clone(); // Some([]) preserved: match nothing

    let max_nodes = resolve_cap(opts.max_traversal_nodes, config.max_traversal_nodes)?;

    Ok(ResolvedInputs {
        max_depth,
        direction,
        edge_types,
        min_confidence,
        exclude_source_types,
        max_nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_cap_rules() {
        assert_eq!(sanitize_cap(1.9), Some(1.0));
        assert_eq!(sanitize_cap(0.5), None);
        assert_eq!(sanitize_cap(-3.0), None);
        assert_eq!(sanitize_cap(f64::NAN), None);
        assert_eq!(sanitize_cap(f64::INFINITY), None);
    }
}
