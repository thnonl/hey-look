//! Message importance (Outlook's "High importance" / "Low importance"): the headers a message is sent with, and how the four
//! headers that other mail programs use for it are read back on receipt.
//!
//! Sending: `Normal` adds no header at all (there is no `Importance: normal`). `High` / `Low` write the four headers Outlook,
//! Apple Mail, Thunderbird and older clients each look at, so every recipient program shows the mark.
//! Receiving: `Importance` first (RFC 2156), then `X-Priority`, then `X-MSMail-Priority`, then `Priority`; the first header that is
//! present and understood decides. A header with a value this code does not know is skipped, not taken as "normal".

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Importance {
    #[default]
    Normal,
    High,
    Low,
}

impl Importance {
    /// The value kept in the `messages.importance` column: 0 normal, 1 high, 2 low.
    pub fn to_db(self) -> i64 {
        match self {
            Importance::Normal => 0,
            Importance::High => 1,
            Importance::Low => 2,
        }
    }

    pub fn from_db(v: i64) -> Importance {
        match v {
            1 => Importance::High,
            2 => Importance::Low,
            _ => Importance::Normal,
        }
    }

    /// The headers to add to an outgoing message (name, value); none for Normal.
    pub fn headers(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Importance::Normal => &[],
            Importance::High => &[("Importance", "high"), ("X-Priority", "1 (Highest)"), ("Priority", "urgent"), ("X-MSMail-Priority", "High")],
            Importance::Low => &[("Importance", "low"), ("X-Priority", "5 (Lowest)"), ("Priority", "non-urgent"), ("X-MSMail-Priority", "Low")],
        }
    }
}

/// `Importance:` header value (RFC 2156): high | normal | low. Anything else is not understood.
fn from_importance(v: &str) -> Option<Importance> {
    match v.trim().to_ascii_lowercase().as_str() {
        "high" => Some(Importance::High),
        "normal" => Some(Importance::Normal),
        "low" => Some(Importance::Low),
        _ => None,
    }
}

/// `X-Priority:` `1 (Highest)` | `2 (High)` | `3 (Normal)` | `4 (Low)` | `5 (Lowest)`; only the leading number counts.
fn from_x_priority(v: &str) -> Option<Importance> {
    let digits: String = v.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u32>().ok()? {
        1 | 2 => Some(Importance::High),
        3 => Some(Importance::Normal),
        4 | 5 => Some(Importance::Low),
        _ => None,
    }
}

/// `X-MSMail-Priority:` High | Normal | Low.
fn from_ms_priority(v: &str) -> Option<Importance> {
    from_importance(v)
}

/// `Priority:` (RFC 2156) urgent | normal | non-urgent.
fn from_priority(v: &str) -> Option<Importance> {
    match v.trim().to_ascii_lowercase().as_str() {
        "urgent" => Some(Importance::High),
        "normal" => Some(Importance::Normal),
        "non-urgent" => Some(Importance::Low),
        _ => None,
    }
}

/// The importance a message was sent with, from its (outer) header block.
pub fn from_headers(headers: &crate::pgpmail::Headers) -> Importance {
    let get = |name: &str| crate::pgpmail::header(headers, name);
    get("Importance")
        .and_then(from_importance)
        .or_else(|| get("X-Priority").and_then(from_x_priority))
        .or_else(|| get("X-MSMail-Priority").and_then(from_ms_priority))
        .or_else(|| get("Priority").and_then(from_priority))
        .unwrap_or_default()
}

/// The importance of a raw message.
pub fn from_raw(raw: &[u8]) -> Importance {
    from_headers(&crate::pgpmail::parse_headers(raw).0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(headers: &[(&str, &str)]) -> Importance {
        let h: crate::pgpmail::Headers = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        from_headers(&h)
    }

    #[test]
    fn normal_adds_no_header_and_the_other_two_add_the_four() {
        assert!(Importance::Normal.headers().is_empty());
        assert_eq!(
            Importance::High.headers(),
            &[("Importance", "high"), ("X-Priority", "1 (Highest)"), ("Priority", "urgent"), ("X-MSMail-Priority", "High")]
        );
        assert_eq!(
            Importance::Low.headers(),
            &[("Importance", "low"), ("X-Priority", "5 (Lowest)"), ("Priority", "non-urgent"), ("X-MSMail-Priority", "Low")]
        );
    }

    #[test]
    fn the_headers_we_write_are_read_back() {
        for i in [Importance::Normal, Importance::High, Importance::Low] {
            let h: Vec<(&str, &str)> = i.headers().to_vec();
            assert_eq!(of(&h), i);
        }
    }

    #[test]
    fn importance_header_is_case_insensitive() {
        for (v, want) in [("high", Importance::High), ("HIGH", Importance::High), (" High ", Importance::High), ("Low", Importance::Low), ("LOW", Importance::Low), ("normal", Importance::Normal), ("Normal", Importance::Normal)] {
            assert_eq!(of(&[("Importance", v)]), want, "{v:?}");
        }
        assert_eq!(of(&[("importance", "high")]), Importance::High, "header names too");
    }

    #[test]
    fn x_priority_levels() {
        for (v, want) in [
            ("1 (Highest)", Importance::High),
            ("1", Importance::High),
            ("2", Importance::High),
            ("2 (High)", Importance::High),
            ("3", Importance::Normal),
            ("3 (Normal)", Importance::Normal),
            ("4", Importance::Low),
            ("4 (Low)", Importance::Low),
            ("5 (Lowest)", Importance::Low),
            ("5", Importance::Low),
            ("0", Importance::Normal),
            ("9", Importance::Normal),
            ("urgent", Importance::Normal),
            ("", Importance::Normal),
        ] {
            assert_eq!(of(&[("X-Priority", v)]), want, "{v:?}");
        }
    }

    #[test]
    fn ms_mail_priority_and_priority() {
        assert_eq!(of(&[("X-MSMail-Priority", "High")]), Importance::High);
        assert_eq!(of(&[("X-MSMail-Priority", "low")]), Importance::Low);
        assert_eq!(of(&[("X-MSMail-Priority", "Normal")]), Importance::Normal);
        assert_eq!(of(&[("Priority", "urgent")]), Importance::High);
        assert_eq!(of(&[("Priority", "Non-Urgent")]), Importance::Low);
        assert_eq!(of(&[("Priority", "normal")]), Importance::Normal);
        // `Precedence: bulk` is a different header and says nothing about importance
        assert_eq!(of(&[("Precedence", "bulk")]), Importance::Normal);
    }

    #[test]
    fn precedence_importance_then_x_priority_then_ms_then_priority() {
        // Importance wins over everything
        assert_eq!(of(&[("X-Priority", "1"), ("Importance", "low"), ("Priority", "urgent")]), Importance::Low);
        assert_eq!(of(&[("Importance", "normal"), ("X-Priority", "1")]), Importance::Normal);
        // X-Priority over X-MSMail-Priority and Priority
        assert_eq!(of(&[("X-MSMail-Priority", "High"), ("X-Priority", "5"), ("Priority", "urgent")]), Importance::Low);
        // X-MSMail-Priority over Priority
        assert_eq!(of(&[("Priority", "urgent"), ("X-MSMail-Priority", "Low")]), Importance::Low);
        // a header we do not understand is skipped, the next one decides
        assert_eq!(of(&[("Importance", "very"), ("X-Priority", "2")]), Importance::High);
        assert_eq!(of(&[("Importance", "bogus"), ("X-Priority", "bogus"), ("X-MSMail-Priority", "bogus"), ("Priority", "urgent")]), Importance::High);
        assert_eq!(of(&[("Importance", "bogus")]), Importance::Normal);
        assert_eq!(of(&[]), Importance::Normal);
    }

    #[test]
    fn read_from_raw_bytes_with_folded_and_crlf_headers() {
        let raw = b"From: a@b.c\r\nX-Priority: 1\r\n (Highest)\r\nSubject: hi\r\n\r\nImportance: low\r\n";
        assert_eq!(from_raw(raw), Importance::High, "a header in the body does not count");
        assert_eq!(from_raw(b"Subject: x\nimportance: LOW\n\nbody"), Importance::Low);
    }

    #[test]
    fn db_values_round_trip() {
        for i in [Importance::Normal, Importance::High, Importance::Low] {
            assert_eq!(Importance::from_db(i.to_db()), i);
        }
        assert_eq!(Importance::from_db(99), Importance::Normal);
    }

    #[test]
    fn serde_names_and_default() {
        assert_eq!(serde_json::to_string(&Importance::High).unwrap(), "\"high\"");
        assert_eq!(serde_json::from_str::<Importance>("\"low\"").unwrap(), Importance::Low);
        assert_eq!(serde_json::from_str::<Importance>("\"normal\"").unwrap(), Importance::Normal);
        assert_eq!(Importance::default(), Importance::Normal);
    }
}
