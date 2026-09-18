use thiserror::Error;

#[derive(Debug, Error)]
pub enum GraphragError {
    #[error("invalid_argument: field '{field}': {reason}")]
    InvalidArgument { field: String, reason: String },
    #[error(
        "unsupported_limit: field '{field}': value {value} exceeds the supported 64-bit range"
    )]
    UnsupportedLimit { field: String, value: f64 },
    #[error("schema_mismatch: {0}")]
    SchemaMismatch(String),
    #[error("sqlite error: {0}")]
    Sql(#[from] rusqlite::Error),
}

pub fn invalid_argument(field: &str, reason: &str) -> GraphragError {
    GraphragError::InvalidArgument {
        field: field.to_string(),
        reason: reason.to_string(),
    }
}
