//! OKF helper port: trust-tier derivation and staleness checks.
//!
//! Rust port of the read path in `packages/okf/src/v02-helpers.ts`
//! (deriveTrustTier, parseStaleAfter, isStaleAfter), matching TS semantics
//! exactly.

/// TrustTier mirrors the TS union: `'unverified' | 'machine-confirmed' | 'human-reviewed'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustTier {
    Unverified,
    MachineConfirmed,
    HumanReviewed,
}

impl TrustTier {
    /// The exact TS string literal, used for DTO hydration parity.
    pub fn as_str(self) -> &'static str {
        match self {
            TrustTier::Unverified => "unverified",
            TrustTier::MachineConfirmed => "machine-confirmed",
            TrustTier::HumanReviewed => "human-reviewed",
        }
    }
}

/// TS `deriveTrustTier(verified)`:
/// - `!verified || verified.length === 0` -> `unverified`
/// - any entry with `typeof v?.by === 'string' && v.by.startsWith('human:')`
///   -> `human-reviewed`
/// - otherwise -> `machine-confirmed`
///
/// `okf_verified` arrives as the parsed JSON column (array of objects). A
/// non-array value, or an entry whose `by` is missing or not a string, is
/// treated as non-human — mirroring the TS `typeof` guard, never panicking.
///
/// NOTE (Task 9 hydration): the TS read path samples `Date.now()` per row in
/// `mapRowToFact`; here `now` is a parameter so the hydration layer can
/// preserve that per-row sampling.
pub fn derive_trust_tier(okf_verified: &serde_json::Value) -> TrustTier {
    let entries = match okf_verified.as_array() {
        Some(arr) if !arr.is_empty() => arr,
        _ => return TrustTier::Unverified,
    };
    for entry in entries {
        if let Some(by) = entry.get("by").and_then(|b| b.as_str()) {
            if by.starts_with("human:") {
                return TrustTier::HumanReviewed;
            }
        }
    }
    TrustTier::MachineConfirmed
}

/// TS `parseStaleAfter(staleAfter)` read-path port.
///
/// SCOPE: the hydrated `stale_after` column is INTEGER epoch ms — the TS
/// write path converts `YYYY-MM-DD` strings to UTC epoch ms before storage,
/// and `mapRowToFact` reads it back via `Number(...)`. The string-parsing
/// branch is kept only for parity safety in case the column ever holds text.
///
/// - `null` -> `None` (TS `isStaleAfter` maps any unparseable cutoff to `false`)
/// - number -> `Some(value)` (finite integers; the stored column is i64 ms)
/// - string `YYYY-MM-DD` -> UTC epoch ms with strict calendar validation,
///   round-trip rejecting normalized dates exactly like the TS code (so
///   `2025-02-29`, which `Date.UTC` would normalize to `2025-03-01`, is
///   rejected)
/// - anything else -> `None`
pub fn parse_stale_after(raw: &serde_json::Value) -> Option<i64> {
    match raw {
        serde_json::Value::Null => None,
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => parse_stale_after_date(s),
        _ => None,
    }
}

/// Strict `YYYY-MM-DD` -> UTC epoch ms. Mirrors the TS implementation:
/// regex-match the shape, compute `Date.UTC(...)` (days-from-civil), then
/// round-trip back to calendar components and reject any mismatch — this is
/// what rejects calendar-invalid dates like `2025-02-29` and `2025-04-31`.
fn parse_stale_after_date(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes[..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: i64 = s[5..7].parse().ok()?;
    let day: i64 = s[8..10].parse().ok()?;

    let ts = utc_ms_from_civil(year, month, day);

    // Round-trip back through the calendar and reject any component that
    // doesn't match (mirrors the TS `new Date(ts)` component check).
    let (ry, rm, rd) = civil_from_utc_days(ts / 86_400_000);
    if ry != year || rm != month || rd != day {
        return None;
    }
    Some(ts)
}

/// Days-from-civil (Howard Hinnant) -> epoch ms at UTC midnight, equivalent
/// to `Date.UTC(year, month - 1, day)`.
fn utc_ms_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let mp = (month + 9) % 12; // Mar=0..Feb=11
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let epoch_days = era * 146_097 + doe - 719_468;
    epoch_days * 86_400_000
}

/// Epoch days -> civil date; inverse of `utc_ms_from_civil`, mirroring the
/// TS round-trip through `new Date(ts)` UTC getters.
fn civil_from_utc_days(epoch_days: i64) -> (i64, i64, i64) {
    let z = epoch_days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// TS `isStaleAfter(staleAfter, now)`:
/// - unparseable/null cutoff -> `false`
/// - else `now >= cutoff` (inclusive boundary: `stale_after` is the first
///   day that IS stale)
pub fn is_stale_after(stale_after: &serde_json::Value, now: i64) -> bool {
    match parse_stale_after(stale_after) {
        Some(cutoff) => now >= cutoff,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- derive_trust_tier ----

    #[test]
    fn trust_tier_none_is_unverified() {
        assert_eq!(
            derive_trust_tier(&serde_json::Value::Null),
            TrustTier::Unverified
        );
    }

    #[test]
    fn trust_tier_empty_array_is_unverified() {
        assert_eq!(derive_trust_tier(&json!([])), TrustTier::Unverified);
    }

    #[test]
    fn trust_tier_human_reviewed_when_by_human_prefixed() {
        let v = json!([{"by": "human:kurt", "at": "2025-01-01T00:00:00Z"}]);
        assert_eq!(derive_trust_tier(&v), TrustTier::HumanReviewed);
    }

    #[test]
    fn trust_tier_machine_confirmed_when_no_human() {
        let v = json!([
            {"by": "machine:tagger", "at": "2025-01-01T00:00:00Z"},
            {"by": "machine:other", "at": "2025-01-02T00:00:00Z"},
        ]);
        assert_eq!(derive_trust_tier(&v), TrustTier::MachineConfirmed);
    }

    #[test]
    fn trust_tier_mixed_human_wins() {
        let v = json!([
            {"by": "machine:tagger", "at": "2025-01-01T00:00:00Z"},
            {"by": "human:kurt", "at": "2025-01-02T00:00:00Z"},
        ]);
        assert_eq!(derive_trust_tier(&v), TrustTier::HumanReviewed);
    }

    #[test]
    fn trust_tier_non_string_by_is_not_human() {
        let v = json!([{"by": 123, "at": "2025-01-01T00:00:00Z"}]);
        assert_eq!(derive_trust_tier(&v), TrustTier::MachineConfirmed);
    }

    #[test]
    fn trust_tier_missing_by_is_not_human() {
        let v = json!([{"at": "2025-01-01T00:00:00Z"}]);
        assert_eq!(derive_trust_tier(&v), TrustTier::MachineConfirmed);
    }

    #[test]
    fn trust_tier_non_array_is_unverified() {
        assert_eq!(
            derive_trust_tier(&json!({"by": "human:x"})),
            TrustTier::Unverified
        );
    }

    #[test]
    fn trust_tier_string_literals_match_ts() {
        assert_eq!(TrustTier::Unverified.as_str(), "unverified");
        assert_eq!(TrustTier::MachineConfirmed.as_str(), "machine-confirmed");
        assert_eq!(TrustTier::HumanReviewed.as_str(), "human-reviewed");
    }

    // ---- parse_stale_after ----

    #[test]
    fn stale_after_null_is_none() {
        assert_eq!(parse_stale_after(&serde_json::Value::Null), None);
    }

    #[test]
    fn stale_after_numeric_is_value() {
        assert_eq!(
            parse_stale_after(&json!(1_738_368_000_000_i64)),
            Some(1_738_368_000_000)
        );
    }

    #[test]
    fn stale_after_invalid_string_is_none() {
        assert_eq!(parse_stale_after(&json!("not-a-date")), None);
        assert_eq!(parse_stale_after(&json!("2025-2-1")), None);
        assert_eq!(parse_stale_after(&json!("")), None);
    }

    #[test]
    fn stale_after_leap_day_rejected() {
        assert_eq!(parse_stale_after(&json!("2025-02-29")), None);
    }

    #[test]
    fn stale_after_valid_date_is_utc_midnight() {
        // Date.UTC(2025, 1, 28) = 2025-02-28T00:00:00Z (verified via node)
        assert_eq!(
            parse_stale_after(&json!("2025-02-28")),
            Some(1_740_700_800_000)
        );
    }

    #[test]
    fn stale_after_leap_day_accepted_in_leap_year() {
        // Date.UTC(2024, 1, 29) = 2024-02-29T00:00:00Z
        assert_eq!(
            parse_stale_after(&json!("2024-02-29")),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn stale_after_invalid_month_day_rejected() {
        assert_eq!(parse_stale_after(&json!("2025-13-01")), None);
        assert_eq!(parse_stale_after(&json!("2025-04-31")), None);
        assert_eq!(parse_stale_after(&json!("2025-00-10")), None);
        assert_eq!(parse_stale_after(&json!("2025-01-00")), None);
    }

    #[test]
    fn stale_after_non_scalar_is_none() {
        assert_eq!(parse_stale_after(&json!([1, 2, 3])), None);
        assert_eq!(parse_stale_after(&json!({"ts": 1})), None);
    }

    // ---- is_stale_after ----

    #[test]
    fn stale_null_is_false() {
        assert!(!is_stale_after(&serde_json::Value::Null, 1_735_219_200_000));
    }

    #[test]
    fn stale_now_equals_cutoff_is_true() {
        let cutoff = 1_735_219_200_000_i64;
        assert!(is_stale_after(&json!(cutoff), cutoff));
    }

    #[test]
    fn stale_now_before_cutoff_is_false() {
        assert!(!is_stale_after(
            &json!(1_735_219_200_000_i64),
            1_735_219_199_999
        ));
    }

    #[test]
    fn stale_now_after_cutoff_is_true() {
        assert!(is_stale_after(
            &json!(1_735_219_200_000_i64),
            1_735_219_200_001
        ));
    }

    #[test]
    fn stale_string_cutoff_uses_first_day_stale() {
        // stale_after is the first day that IS stale (UTC midnight).
        let cutoff = 1_740_700_800_000_i64; // 2025-02-28T00:00:00Z
        assert!(!is_stale_after(&json!("2025-02-28"), cutoff - 1));
        assert!(is_stale_after(&json!("2025-02-28"), cutoff));
    }

    #[test]
    fn stale_unparseable_is_false() {
        assert!(!is_stale_after(&json!("garbage"), 9_999_999_999_999));
    }
}
