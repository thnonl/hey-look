//! What the receiving mail server says about the sender of a message (1.0.7 W7.3): the verdict of its `Authentication-Results` header
//! (RFC 8601), used only to make the calendar stricter. The app does no DKIM / SPF / DMARC check of its own (no DNS lookups).
//!
//! Only the **topmost** `Authentication-Results` header counts: a receiving server adds its own on top, anything below it was written
//! by an earlier hop or by the sender and can be forged. `ARC-Authentication-Results` is a different header and is ignored. A verdict
//! of `Fail` holds a calendar change; `Pass` and `Unknown` change nothing against 1.0.6, so a forged "pass" gains an attacker nothing.

/// The sender check of one message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Auth {
    Pass,
    Fail,
    /// no header, no useful result (softfail, neutral, none, temperror, permerror), or a message stored before the app kept the verdict
    #[default]
    Unknown,
}

impl Auth {
    /// Value of `messages.auth_result`: `NULL` for Unknown.
    pub fn to_db(self) -> Option<&'static str> {
        match self {
            Auth::Pass => Some("pass"),
            Auth::Fail => Some("fail"),
            Auth::Unknown => None,
        }
    }

    pub fn from_db(v: Option<&str>) -> Auth {
        match v {
            Some("pass") => Auth::Pass,
            Some("fail") => Auth::Fail,
            _ => Auth::Unknown,
        }
    }
}

/// The text with every parenthesised comment (they nest) and every quoted string removed: comments carry free text such as
/// `(p=reject sp=none)` or `(sender IP is 1.2.3.4)`, and a quoted `reason="..."` may carry words that look like results.
fn strip_comments_and_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    let mut quoted = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && (depth > 0 || quoted) {
            chars.next(); // an escaped character inside a comment or a quoted string
            continue;
        }
        if depth > 0 {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                out.push(' ');
            }
            continue;
        }
        if quoted {
            if c == '"' {
                quoted = false;
                out.push(' ');
            }
            continue;
        }
        match c {
            '(' => depth = 1,
            '"' => quoted = true,
            c => out.push(c),
        }
    }
    out
}

/// The `method=result` pairs of one header value, lower case. Microsoft writes no authserv-id, others write one in front: a token without
/// an `=` is not a pair and is skipped either way.
fn results(value: &str) -> Vec<(String, String)> {
    strip_comments_and_quotes(value)
        .split(|c: char| c.is_whitespace() || c == ';')
        .filter_map(|tok| {
            let (k, v) = tok.split_once('=')?;
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
            (!k.is_empty() && !v.is_empty()).then_some((k, v))
        })
        .collect()
}

/// The verdict of the results of one header (pure; the table of the tests below).
///
/// * Fail: `dmarc=fail`, or `compauth=fail` (Microsoft's composite), or no DMARC result and `spf=fail` and no `dkim=pass`.
/// * Pass: `dmarc=pass`, or no DMARC result and (`dkim=pass` or `spf=pass`).
/// * Otherwise Unknown. A "DMARC result" is `pass` or `fail`; `none`, `temperror`, `permerror` and `bestguesspass` are not one.
///   `softfail` and `neutral` of SPF are not failures.
pub fn verdict_of(value: &str) -> Auth {
    let r = results(value);
    let any = |m: &str, v: &str| r.iter().any(|(k, x)| k == m && x == v);
    let dmarc_result = any("dmarc", "pass") || any("dmarc", "fail");
    if any("dmarc", "fail") || any("compauth", "fail") || (!dmarc_result && any("spf", "fail") && !any("dkim", "pass")) {
        return Auth::Fail;
    }
    if any("dmarc", "pass") || (!dmarc_result && (any("dkim", "pass") || any("spf", "pass"))) {
        return Auth::Pass;
    }
    Auth::Unknown
}

/// The verdict of a raw message: its first (topmost) `Authentication-Results` header; none = Unknown.
pub fn verdict(raw: &[u8]) -> Auth {
    let (headers, _) = crate::pgpmail::parse_headers(raw);
    headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("Authentication-Results")).map(|(_, v)| verdict_of(v)).unwrap_or(Auth::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(headers: &[&str]) -> Vec<u8> {
        format!("{}\r\nFrom: a@example.org\r\nSubject: s\r\n\r\nbody\r\n", headers.join("\r\n")).into_bytes()
    }

    /// AC-7.3.8: header samples as the big receivers write them.
    #[test]
    fn the_verdict_table_for_real_looking_headers() {
        let cases: &[(&str, &str, Auth)] = &[
            // Gmail
            ("gmail pass", "mx.google.com; dkim=pass header.i=@example.org header.s=sel header.b=AbCd; spf=pass (google.com: domain of a@example.org designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@example.org; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.org", Auth::Pass),
            ("gmail fail", "mx.google.com; dkim=fail header.i=@example.org; spf=fail (google.com: domain of a@example.org does not designate 9.9.9.9 as permitted sender) smtp.mailfrom=a@example.org; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=example.org", Auth::Fail),
            // Microsoft 365: no authserv-id, compauth
            ("m365 pass", "spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.org; dkim=pass (signature was verified) header.d=example.org; dmarc=pass action=none header.from=example.org; compauth=pass reason=100", Auth::Pass),
            ("m365 dmarc fail", "spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.org; dkim=none (message not signed) header.d=none; dmarc=fail action=none header.from=example.org; compauth=fail reason=000", Auth::Fail),
            ("m365 compauth only", "spf=softfail (sender IP is 1.2.3.4) smtp.mailfrom=example.org; dkim=none; dmarc=none action=none header.from=example.org; compauth=fail reason=001", Auth::Fail),
            // Fastmail
            ("fastmail pass", "mx2.messagingengine.com; x-csa=none; x-me-sender=none; x-ptr=pass smtp.helo=mail.example.org policy.ptr=mail.example.org; bimi=skipped (DMARC Policy is not at enforcement); arc=none (no signatures found); dkim=pass (2048-bit rsa key sha256) header.d=example.org header.i=@example.org header.b=xyz; dmarc=pass policy.published-domain-policy=none policy.applied-disposition=none policy.evaluated-disposition=none (p=none,d=none,d.eval=none) policy.policy-from=p header.from=example.org; iprev=pass smtp.remote-ip=1.2.3.4; spf=pass smtp.mailfrom=a@example.org smtp.helo=mail.example.org", Auth::Pass),
            // Postfix + OpenDMARC / OpenDKIM
            ("opendmarc pass", "mail.example.net; dkim=pass (1024-bit key; unprotected) header.d=example.org header.i=@example.org header.b=q1; dmarc=pass (p=none dis=none) header.from=example.org", Auth::Pass),
            ("opendmarc fail", "mail.example.net; dkim=fail reason=\"signature verification failed\" header.d=example.org; dmarc=fail (p=reject dis=none) header.from=example.org", Auth::Fail),
            // no DMARC, SPF decides
            ("spf fail alone", "mx.example; spf=fail smtp.mailfrom=a@example.org", Auth::Fail),
            ("spf fail but dkim pass", "mx.example; spf=fail smtp.mailfrom=a@example.org; dkim=pass header.d=example.org", Auth::Pass),
            ("spf softfail", "mx.example; spf=softfail smtp.mailfrom=a@example.org", Auth::Unknown),
            ("spf neutral", "mx.example; spf=neutral smtp.mailfrom=a@example.org", Auth::Unknown),
            ("spf pass alone", "mx.example; spf=pass smtp.mailfrom=a@example.org", Auth::Pass),
            ("dkim pass alone", "mx.example; dkim=pass header.d=example.org", Auth::Pass),
            ("dmarc pass wins over spf fail", "mx.example; spf=fail smtp.mailfrom=a@example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org", Auth::Pass),
            ("dmarc none: SPF decides", "mx.example; spf=fail smtp.mailfrom=a@example.org; dkim=none; dmarc=none header.from=example.org", Auth::Fail),
            ("dmarc none with spf pass", "mx.example; spf=pass smtp.mailfrom=a@example.org; dmarc=none header.from=example.org", Auth::Pass),
            ("temperror and permerror", "mx.example; spf=temperror; dkim=permerror; dmarc=temperror", Auth::Unknown),
            ("none", "mx.example; none", Auth::Unknown),
            ("empty", "", Auth::Unknown),
            // spelling: upper case, comments that contain result words, quoted reasons
            ("upper case", "MX.EXAMPLE; DMARC=FAIL HEADER.FROM=EXAMPLE.ORG", Auth::Fail),
            ("a comment that says pass", "mx.example; dmarc=fail (dmarc=pass would be nice) header.from=example.org", Auth::Fail),
            ("a nested comment", "mx.example; spf=softfail (domain (a.example.org) does not designate (dmarc=pass) ip) smtp.mailfrom=a@example.org", Auth::Unknown),
            ("a quoted reason that says fail", "mx.example; dkim=pass reason=\"spf=fail dmarc=fail\" header.d=example.org", Auth::Pass),
            ("one dkim fails, another passes", "mx.example; dkim=fail header.d=a.example; dkim=pass header.d=example.org; spf=fail", Auth::Pass),
        ];
        for (name, value, want) in cases {
            assert_eq!(verdict_of(value), *want, "{name}: {value}");
            let raw = msg(&[&format!("Authentication-Results: {value}")]);
            assert_eq!(verdict(&raw), *want, "{name} as a message");
        }
    }

    /// Only the topmost header counts; ARC is another header; a folded header is read whole.
    #[test]
    fn only_the_topmost_header_counts() {
        let top_pass = msg(&["Authentication-Results: mx.example; dmarc=pass header.from=example.org", "Authentication-Results: mx.evil; dmarc=fail header.from=example.org"]);
        assert_eq!(verdict(&top_pass), Auth::Pass, "a forged fail below the receiving server's pass changes nothing");
        let top_fail = msg(&["Authentication-Results: mx.example; dmarc=fail header.from=example.org", "Authentication-Results: mx.evil; dmarc=pass header.from=example.org"]);
        assert_eq!(verdict(&top_fail), Auth::Fail, "a forged pass below the receiving server's fail changes nothing");
        // other headers do not count, whatever they say, and neither does a header called almost the same
        let arc = msg(&["ARC-Authentication-Results: i=1; mx.example; dmarc=fail header.from=example.org", "X-Authentication-Results: dmarc=fail"]);
        assert_eq!(verdict(&arc), Auth::Unknown);
        let arc_then_real = msg(&["ARC-Authentication-Results: i=1; mx.example; dmarc=pass", "Authentication-Results: mx.example; dmarc=fail header.from=example.org"]);
        assert_eq!(verdict(&arc_then_real), Auth::Fail);
        // the header name in any case, a value folded over several lines
        let folded = msg(&["authentication-results: mx.example;\r\n spf=pass smtp.mailfrom=a@example.org;\r\n\tdmarc=fail header.from=example.org"]);
        assert_eq!(verdict(&folded), Auth::Fail);
        // a header that is only in the body is not a header
        let body = b"From: a@example.org\r\nSubject: s\r\n\r\nAuthentication-Results: mx; dmarc=fail\r\n".to_vec();
        assert_eq!(verdict(&body), Auth::Unknown);
        assert_eq!(verdict(b"From: a@example.org\r\n\r\nhi"), Auth::Unknown);
    }

    #[test]
    fn the_verdict_is_stored_as_text_and_null_means_unknown() {
        assert_eq!((Auth::Pass.to_db(), Auth::Fail.to_db(), Auth::Unknown.to_db()), (Some("pass"), Some("fail"), None));
        assert_eq!((Auth::from_db(Some("pass")), Auth::from_db(Some("fail")), Auth::from_db(None), Auth::from_db(Some("junk"))), (Auth::Pass, Auth::Fail, Auth::Unknown, Auth::Unknown));
    }
}
