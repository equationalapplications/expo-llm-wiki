//! graphrag-core: portable native GraphRAG engine (vertical slice).
//!
//! Owns graph algorithms, graph SQL, and typed results. No Tauri, windowing,
//! Node, or React Native dependency. Hosts own connections, credentials, and
//! lifecycle (REQ-OWN-01).
pub mod edges;
pub mod error;
pub mod hydrate;
pub mod okf;
pub mod schema_check;
pub mod types;
pub mod validation;
pub mod walk;

#[cfg(test)]
mod tests {
    use super::error::{invalid_argument, GraphragError};

    /// Smoke test: the crate compiles and the shared error type works.
    #[test]
    fn scaffold_is_alive() {
        let err = invalid_argument("limit", "must be positive");
        assert!(matches!(err, GraphragError::InvalidArgument { .. }));
        assert_eq!(
            err.to_string(),
            "invalid_argument: field 'limit': must be positive"
        );
    }
}
