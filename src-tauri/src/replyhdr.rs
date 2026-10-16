//! What an answer to a message needs from the message's own headers: where the sender wants answers to go (Reply-To), the
//! Message-ID to answer, and the References chain of the answer (RFC 5322 section 3.6.4).
//! The stored message only keeps From / To / Cc as bare addresses and one merged list of reference ids (for threading), so this
//! reads the headers of the message itself, as the server holds it.

use serde::Serialize;

/// Where an answer goes and how it is linked to the message it answers.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplyHeaders {
    /// `<id@domain>` of the message itself (None when it has none)
    pub message_id: Option<String>,
    /// the References header of the ANSWER: the message's own References (else its In-Reply-To) plus its Message-ID, cut to a
    /// sensible length (the first id and the newest ones)
    pub references: Vec<String>,
    /// the Reply-To addresses that are real addresses, as `Name <address>` / `address` (empty: answer to From)
    pub reply_to: Vec<String>,
}

/// At most this many ids in the References of an answer, and this many characters (RFC 5322 line limit is 998; 986 leaves room for
/// the field name).
const MAX_REFS: usize = 20;
const MAX_REFS_CHARS: usize = 986;

fn ids_in(raw: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = raw;
    while let Some(a) = rest.find('<') {
        let Some(b) = rest[a..].find('>') else { break };
        let id = rest[a..a + b + 1].trim();
        if id.len() > 2 && id.contains('@') {
            out.push(id.to_string());
        }
        rest = &rest[a + b + 1..];
    }
    out
}

/// The References of an answer to a message with these headers: the message's References, else its In-Reply-To, then its own
/// Message-ID. Each id once (the first place counts). When the chain is too long the first id (the root of the conversation) and the
/// newest ones stay; the ones in the middle go (RFC 5537 section 3.4.4).
pub fn chain(references: &[String], in_reply_to: &[String], message_id: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = vec![];
    let base = if references.is_empty() { in_reply_to } else { references };
    for id in base.iter().map(String::as_str).chain(message_id) {
        if !ids.iter().any(|x| x == id) {
            ids.push(id.to_string());
        }
    }
    let chars = |l: &[String]| l.iter().map(|x| x.len() + 1).sum::<usize>().saturating_sub(1);
    while ids.len() > 2 && (ids.len() > MAX_REFS || chars(&ids) > MAX_REFS_CHARS) {
        ids.remove(1);
    }
    ids
}

/// The headers of `raw` that an answer needs.
pub fn from_raw(raw: &[u8]) -> ReplyHeaders {
    let Some(m) = mail_parser::MessageParser::default().parse(raw) else { return ReplyHeaders::default() };
    let message_id = m.message_id().map(|s| format!("<{}>", s.trim().trim_matches(['<', '>']))).filter(|s| s.len() > 2);
    let refs = m.header_raw("References").map(ids_in).unwrap_or_default();
    let irt = m.header_raw("In-Reply-To").map(ids_in).unwrap_or_default();
    let reply_to = m
        .reply_to()
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let email = x.address.as_deref()?.trim().to_string();
                    // a Reply-To that is not an address is ignored (the answer goes to From)
                    email.parse::<lettre::Address>().ok()?;
                    Some(crate::smtp::format_mailbox(x.name.as_deref(), &email))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ReplyHeaders { references: chain(&refs, &irt, message_id.as_deref()), message_id, reply_to }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_references_of_an_answer_are_the_parents_references_and_its_message_id() {
        assert_eq!(chain(&ids(&["<a@x>", "<b@x>"]), &[], Some("<c@x>")), ids(&["<a@x>", "<b@x>", "<c@x>"]));
        // no References: the In-Reply-To stands in for them (RFC 5322 3.6.4)
        assert_eq!(chain(&[], &ids(&["<a@x>"]), Some("<b@x>")), ids(&["<a@x>", "<b@x>"]));
        // a first message of a conversation
        assert_eq!(chain(&[], &[], Some("<a@x>")), ids(&["<a@x>"]));
        // no Message-ID at all: nothing invented
        assert_eq!(chain(&ids(&["<a@x>"]), &[], None), ids(&["<a@x>"]));
        // an id that is already there is not repeated
        assert_eq!(chain(&ids(&["<a@x>", "<b@x>"]), &[], Some("<b@x>")), ids(&["<a@x>", "<b@x>"]));
    }

    #[test]
    fn a_long_chain_keeps_the_root_and_the_newest_ids() {
        let long: Vec<String> = (0..60).map(|i| format!("<m{i:02}@example.com>")).collect();
        let out = chain(&long, &[], Some("<new@example.com>"));
        assert!(out.len() <= MAX_REFS, "{}", out.len());
        assert_eq!(out.first().map(String::as_str), Some("<m00@example.com>"), "the root of the conversation stays");
        assert_eq!(out.last().map(String::as_str), Some("<new@example.com>"), "the parent is last");
        assert_eq!(out[out.len() - 2], "<m59@example.com>", "the newest ids stay");
        // very long ids: the character limit applies
        let fat: Vec<String> = (0..10).map(|i| format!("<{}{i}@example.com>", "x".repeat(150))).collect();
        let out = chain(&fat, &[], Some("<p@example.com>"));
        assert!(out.join(" ").len() <= MAX_REFS_CHARS, "{}", out.join(" ").len());
        assert_eq!(out.first(), fat.first());
        assert_eq!(out.last().map(String::as_str), Some("<p@example.com>"));
    }

    #[test]
    fn reply_to_message_id_and_references_come_from_the_raw_headers() {
        let raw = b"From: List <list@lists.example.org>\r\nTo: me@example.com\r\nReply-To: Help Desk <help@example.org>, \"Doe, John\" <john@example.org>, not an address\r\nMessage-ID: <third@example.org>\r\nReferences: <first@example.org> <second@example.org>\r\nIn-Reply-To: <second@example.org>\r\nSubject: s\r\n\r\nbody\r\n";
        let h = from_raw(raw);
        assert_eq!(h.message_id.as_deref(), Some("<third@example.org>"));
        assert_eq!(h.references, ids(&["<first@example.org>", "<second@example.org>", "<third@example.org>"]));
        assert_eq!(h.reply_to, vec!["\"Help Desk\" <help@example.org>".to_string(), "\"Doe, John\" <john@example.org>".to_string()], "{:?}", h.reply_to);

        // no Reply-To, no references, a first message
        let h = from_raw(b"From: a@example.org\r\nMessage-ID: <only@example.org>\r\n\r\nx");
        assert!(h.reply_to.is_empty());
        assert_eq!(h.references, ids(&["<only@example.org>"]));

        // a Reply-To without a real address is ignored
        let h = from_raw(b"From: a@example.org\r\nReply-To: nobody\r\nMessage-ID: <m@example.org>\r\n\r\nx");
        assert!(h.reply_to.is_empty(), "{:?}", h.reply_to);

        // a message without a Message-ID (old mail sent by a client that left it to the server)
        let h = from_raw(b"From: a@example.org\r\n\r\nx");
        assert_eq!(h.message_id, None);
        assert!(h.references.is_empty());
    }
}
