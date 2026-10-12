//! Pure rules for scheduled sends: time validation, retry policy and error classification.

/// Seconds a time may already be in the past and still be accepted (a send "now" from the picker).
pub const GRACE_SECS: i64 = 60;
/// A time further away than this is sent by the timer; closer times are sent immediately.
pub const IMMEDIATE_SECS: i64 = 10;
/// Retry delay for transient failures, and how many attempts are made in total.
pub const RETRY_DELAY_SECS: i64 = 5 * 60;
pub const MAX_ATTEMPTS: i64 = 3;
/// Scheduling further ahead than this is refused.
pub const MAX_AHEAD_SECS: i64 = 366 * 24 * 3600;

/// Reject a send time that has already passed (beyond the grace period) or is absurdly far away.
pub fn validate_send_at(send_at: i64, now: i64) -> Result<(), String> {
    if send_at < now - GRACE_SECS {
        return Err("SCHEDULE_IN_PAST: That time has passed. Pick a later time, or send now.".into());
    }
    if send_at > now + MAX_AHEAD_SECS {
        return Err("SCHEDULE_TOO_FAR: Pick a date within a year.".into());
    }
    Ok(())
}

/// True when the message should be queued for later rather than sent right away.
pub fn should_queue(send_at: Option<i64>, now: i64) -> bool {
    matches!(send_at, Some(at) if at > now + IMMEDIATE_SECS)
}

/// Network hiccups and temporary server errors are worth retrying; login and address errors are not.
pub fn is_transient(error: &str) -> bool {
    let e = error.to_lowercase();
    const PERMANENT: [&str; 8] = ["login", "auth", "535", "550", "553", "invalid", "bad address", "5.7."];
    if PERMANENT.iter().any(|p| e.contains(p)) {
        return false;
    }
    const TRANSIENT: [&str; 10] = ["timed out", "timeout", "connection", "network", "temporar", "reset", "refused", "lookup", "421", "451"];
    TRANSIENT.iter().any(|t| e.contains(t))
}

/// After a failed attempt: `Some(next_due)` to try again, `None` when the message should be marked failed.
pub fn retry_at(error: &str, attempts_so_far: i64, retry_enabled: bool, now: i64) -> Option<i64> {
    if retry_enabled && attempts_so_far < MAX_ATTEMPTS && is_transient(error) {
        Some(now + RETRY_DELAY_SECS)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn past_times_are_rejected() {
        let e = validate_send_at(NOW - 3600, NOW).unwrap_err();
        assert!(e.starts_with("SCHEDULE_IN_PAST"), "{e}");
    }

    #[test]
    fn a_minute_ago_is_still_accepted_as_send_now() {
        assert!(validate_send_at(NOW - 30, NOW).is_ok());
    }

    #[test]
    fn future_times_within_a_year_are_accepted() {
        assert!(validate_send_at(NOW + 3600, NOW).is_ok());
        assert!(validate_send_at(NOW + 300 * 24 * 3600, NOW).is_ok());
    }

    #[test]
    fn times_beyond_a_year_are_refused() {
        let e = validate_send_at(NOW + 400 * 24 * 3600, NOW).unwrap_err();
        assert!(e.starts_with("SCHEDULE_TOO_FAR"), "{e}");
    }

    #[test]
    fn only_times_clearly_in_the_future_are_queued() {
        assert!(should_queue(Some(NOW + 3600), NOW));
        assert!(!should_queue(Some(NOW + 5), NOW), "a few seconds away is sent right away");
        assert!(!should_queue(None, NOW));
    }

    #[test]
    fn network_errors_retry_and_auth_errors_do_not() {
        assert!(is_transient("SMTP send failed: connection timed out"));
        assert!(is_transient("SMTP send failed: 451 try again later"));
        assert!(!is_transient("SMTP send failed: 535 5.7.8 authentication failed"));
        assert!(!is_transient("SMTP login failed: invalid credentials"));
        assert!(!is_transient("bad address 'nobody'"));
    }

    #[test]
    fn retries_are_limited_and_can_be_turned_off() {
        assert_eq!(retry_at("connection reset", 1, true, NOW), Some(NOW + RETRY_DELAY_SECS));
        assert_eq!(retry_at("connection reset", MAX_ATTEMPTS, true, NOW), None, "gives up after the last attempt");
        assert_eq!(retry_at("connection reset", 1, false, NOW), None, "retry switched off");
        assert_eq!(retry_at("535 authentication failed", 1, true, NOW), None, "permanent errors fail at once");
    }
}
