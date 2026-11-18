//! Parity between the Rust-side schema pin and packages/core's real schema.
//!
//! `REQUIRED_SCHEMA_VERSION` is a hand-maintained mirror of packages/core's
//! `CURRENT_SCHEMA_VERSION` (packages/core/src/db/migrations.ts, which derives
//! it from the last migration). The two live in different languages, so no
//! import can tie them together — the drift that motivated this test left the
//! pin at 11 while core ran on (issue #387). This test parses the migrations
//! file the way core derives the constant (highest `version:` entry) and fails
//! the moment the mirror drifts in either direction.

use std::fs;
use std::path::PathBuf;

/// Highest `version: N,` entry in packages/core/src/db/migrations.ts — the
/// same derivation core's `CURRENT_SCHEMA_VERSION` export uses.
fn core_current_schema_version() -> i64 {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/db/migrations.ts");
    let src =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let mut max = 0;
    let mut count = 0;
    for tok in src.split("version:") {
        // Each `version:` is followed by whitespace, the number, then a comma.
        let rest = tok.trim_start();
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || !rest[digits.len()..].starts_with(',') {
            continue;
        }
        let v: i64 = digits
            .parse()
            .unwrap_or_else(|e| panic!("unparseable version {digits:?} in migrations.ts: {e}"));
        count += 1;
        max = max.max(v);
    }
    assert!(count > 0, "no `version: N,` entries found in migrations.ts");
    max
}

#[test]
fn required_schema_version_matches_core_current() {
    let core = core_current_schema_version();
    assert_eq!(
        graphrag_core::schema_check::REQUIRED_SCHEMA_VERSION,
        core,
        "REQUIRED_SCHEMA_VERSION (crates/graphrag-core/src/schema_check.rs) \
         is out of lockstep with packages/core/src/db/migrations.ts \
         (CURRENT_SCHEMA_VERSION = {core}); bump or derive the pin — issue #387"
    );
}
