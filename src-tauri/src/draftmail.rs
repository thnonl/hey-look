//! What a saved draft says about its recipients (QA round 17 BUG-01 / BUG-10).
//!
//! The synced copy of a message keeps only bare To / Cc addresses (and nothing for Bcc), which is right for mail that was received but loses
//! the display names and the Bcc recipients of a draft when it is opened again. A draft is read back from the headers of the message that
//! was saved to the Drafts folder instead: To, Cc and Bcc as the person had them in the chips, names included.

use serde::Serialize;

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct DraftRecipients {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
}

/// Split a header value at the commas that separate recipients: not inside a quoted string, an angle-bracket address or a comment.
fn split_list(v: &str) -> Vec<String> {
    let (mut out, mut cur) = (vec![], String::new());
    let (mut quoted, mut angle, mut comment, mut esc) = (false, false, 0u32, false);
    for c in v.chars() {
        if esc {
            cur.push(c);
            esc = false;
            continue;
        }
        match c {
            '\\' if quoted || comment > 0 => {
                cur.push(c);
                esc = true;
                continue;
            }
            '"' if comment == 0 => quoted = !quoted,
            '<' if !quoted && comment == 0 => angle = true,
            '>' if !quoted && comment == 0 => angle = false,
            '(' if !quoted => comment += 1,
            ')' if !quoted && comment > 0 => comment -= 1,
            ',' | ';' if !quoted && !angle && comment == 0 => {
                if c == ';' && cur.contains(':') && !cur.trim_end().ends_with(':') {
                    // the end of a group (`undisclosed-recipients:;`, `Team: a@x, b@x;`) is not a separator
                    cur.push(c);
                    continue;
                }
                out.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur);
    out.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// A display name that needs no quotes in the chip (letters of any script, digits, spaces and a few marks); anything else is quoted.
fn plain_name(n: &str) -> bool {
    n.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '\'' | '-' | '_'))
}

/// `Name <address>` the way a chip shows it, quoted only when the name needs it; just the address without a name.
fn chip(name: Option<&str>, address: &str) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty() && *n != address) {
        Some(n) if plain_name(n) => format!("{n} <{address}>"),
        Some(n) => crate::smtp::format_mailbox(Some(n), address),
        None => address.to_string(),
    }
}

/// One recipient as written in the header. Parsed on its own (so encoded names are decoded and the address is split off); text that is
/// not an address (`ann bob`, `ann@`: a half-typed draft keeps what was typed) is kept as it is.
fn one(piece: &str) -> String {
    let fake = format!("To: {piece}\r\n\r\n");
    let parsed = mail_parser::MessageParser::default().parse(fake.as_bytes());
    let addrs: Vec<(Option<String>, String)> = parsed
        .as_ref()
        .and_then(|m| m.to())
        .map(|a| a.iter().filter_map(|x| x.address.as_ref().map(|ad| (x.name.as_ref().map(|n| n.to_string()), ad.to_string()))).collect())
        .unwrap_or_default();
    match addrs.as_slice() {
        [(name, address)] if address.contains('@') => chip(name.as_deref(), address),
        _ => piece.to_string(),
    }
}

fn list(h: &crate::pgpmail::Headers, name: &str) -> Vec<String> {
    crate::pgpmail::header(h, name).map(|v| split_list(v).iter().map(|p| one(p)).collect()).unwrap_or_default()
}

/// To, Cc and Bcc of a raw draft, as chips.
pub fn recipients(raw: &[u8]) -> DraftRecipients {
    let (h, _) = crate::pgpmail::parse_headers(raw);
    DraftRecipients { to: list(&h, "To"), cc: list(&h, "Cc"), bcc: list(&h, "Bcc") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(h: &str) -> Vec<u8> {
        format!("From: me@example.com\r\n{h}Subject: x\r\n\r\nbody\r\n").into_bytes()
    }

    #[test]
    fn names_and_bcc_come_back_from_the_headers() {
        let r = recipients(&raw(
            "To: =?utf-8?b?Tmd1eeG7hW4gVsSDbiBCw6k=?= <nguyen@example.test>, bob@example.test\r\nCc: cc@example.test\r\nBcc: \"Hidden, Person\" <bcc@example.test>\r\n",
        ));
        assert_eq!(r.to, vec!["Nguyễn Văn Bé <nguyen@example.test>", "bob@example.test"]);
        assert_eq!(r.cc, vec!["cc@example.test"]);
        assert_eq!(r.bcc, vec!["\"Hidden, Person\" <bcc@example.test>"], "a name with a comma stays one recipient, quoted");
    }

    #[test]
    fn a_folded_list_and_a_name_with_special_characters() {
        let r = recipients(&raw("To: \"Smith, John (Sales)\" <john@example.test>,\r\n \"O'Neil\" <on@example.test>,\r\n Ann <ann@example.test>\r\n"));
        assert_eq!(r.to, vec!["\"Smith, John (Sales)\" <john@example.test>", "O'Neil <on@example.test>", "Ann <ann@example.test>"]);
    }

    #[test]
    fn half_typed_recipients_are_kept_as_typed() {
        let r = recipients(&raw("To: ann@, Carl <carl@example.test>, ann bob\r\n"));
        assert_eq!(r.to, vec!["ann@", "Carl <carl@example.test>", "ann bob"]);
    }

    #[test]
    fn no_header_no_recipients() {
        assert_eq!(recipients(&raw("")), DraftRecipients::default());
    }

    #[test]
    fn the_draft_the_backend_writes_is_read_back_whole() {
        // the real writer: smtp::build_draft (names, a quoted comma, Bcc, an invalid entry kept as typed)
        let mut d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
        d.to = vec!["Nguyễn Văn Bé <nguyen@example.test>".into(), "bob@example.test".into()];
        d.cc = vec!["\"Doe, Jane\" <jane@example.test>".into()];
        d.bcc = vec!["Quiet <quiet@example.test>".into(), "silent@example.test".into()];
        let bytes = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        let r = recipients(&bytes);
        assert_eq!(r.to, d.to);
        assert_eq!(r.cc, d.cc);
        assert_eq!(r.bcc, d.bcc);
        // and with a half-typed entry in the list, the others are not lost
        d.bcc = vec!["silent@".into(), "Quiet <quiet@example.test>".into()];
        let bytes = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        assert_eq!(recipients(&bytes).bcc, d.bcc);
    }
}
