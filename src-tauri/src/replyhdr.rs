//! What an answer to a message needs from the message's own headers: where the sender wants answers to go (Reply-To), the
//! Message-ID to answer, and the References chain of the answer (RFC 5322 section 3.6.4).
//! The stored message only keeps From / To / Cc as bare addresses and one merged list of reference ids (for threading), so this
//! reads the headers of the message itself, as the server holds it (also the display names of From / To / Cc: Reply all keeps them).

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
    /// From / To / Cc as the headers write them, each as `"Name" <address>` / `address` (a name that only repeats the address is dropped)
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
}

/// The mailboxes of an address header with their display names (quoted names such as `"Doe, John"` stay whole).
fn mailboxes(a: Option<&mail_parser::Address>) -> Vec<String> {
    a.map(|a| {
        a.iter()
            .filter_map(|x| {
                let email = x.address.as_deref()?.trim();
                if !email.contains('@') {
                    return None;
                }
                let name = x.name.as_deref().filter(|n| !n.trim().eq_ignore_ascii_case(email));
                Some(crate::smtp::format_mailbox(name, email))
            })
            .collect()
    })
    .unwrap_or_default()
}

/// The line for startup.log: where the headers came from (`body`: the message was downloaded already, `fetch`: asked from the server), how many
/// Reply-To addresses it has and how many of them are the person's own accounts (the page does not answer to those).
pub fn log_text(h: &ReplyHeaders, source: &str, own_emails: &[String]) -> String {
    let own = h.reply_to.iter().filter(|r| own_emails.iter().any(|e| e.trim().eq_ignore_ascii_case(crate::smtp::split_mailbox(r).1.trim()))).count();
    format!("reply headers: source={source}, reply-to={} address(es), own removed={own}", h.reply_to.len())
}

/// At most this many ids in the References of an answer, and this many characters (RFC 5322 line limit is 998; 986 leaves room for
/// the field name).
const MAX_REFS: usize = 20;
const MAX_REFS_CHARS: usize = 986;

pub fn ids_in(raw: &str) -> Vec<String> {
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
    ReplyHeaders { references: chain(&refs, &irt, message_id.as_deref()), message_id, reply_to, from: mailboxes(m.from()).into_iter().next(), to: mailboxes(m.to()), cc: mailboxes(m.cc()) }
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

        // QA 19A R19A-1: the names of From / To / Cc stay (the stored message keeps the addresses only)
        let h = from_raw(
            b"From: \"Lee, Ann\" <ann@example.org>\r\nTo: \"Doe, John\" <john@x.test>, plain@x.test, bob@x.test <bob@x.test>, =?utf-8?B?SMO8bGxlciwgw5xtaXQ=?= <u@x.test>\r\nCc: Team <team@x.test>\r\nMessage-ID: <m@example.org>\r\n\r\nx",
        );
        assert_eq!(h.from.as_deref(), Some("\"Lee, Ann\" <ann@example.org>"));
        assert_eq!(
            h.to,
            vec!["\"Doe, John\" <john@x.test>".to_string(), "plain@x.test".to_string(), "bob@x.test".to_string(), "\"H\u{fc}ller, \u{dc}mit\" <u@x.test>".to_string()],
            "{:?}",
            h.to
        );
        assert_eq!(h.cc, vec!["\"Team\" <team@x.test>".to_string()]);
        // a message without From / To / Cc
        let h = from_raw(b"Message-ID: <m@example.org>\r\n\r\nx");
        assert!(h.from.is_none() && h.to.is_empty() && h.cc.is_empty());

        // a message without a Message-ID (old mail sent by a client that left it to the server)
        let h = from_raw(b"From: a@example.org\r\n\r\nx");
        assert_eq!(h.message_id, None);
        assert!(h.references.is_empty());
    }

    // ---- QA 20 (Mac, GreenMail): where Reply-To comes from and what the reply path does with it

    /// A message as a small mail server stores it: Return-Path / Received in front, `eol` as line ending, a Reply-To with several addresses folded
    /// over two lines.
    fn stored_message(eol: &str) -> Vec<u8> {
        [
            "Return-Path: <sender@test.local>",
            "Received: from localhost (localhost [127.0.0.1]) by test.local; Sat, 17 Oct 2026 10:00:00 +0000",
            "From: RC Sender <sender@test.local>",
            "Reply-To: RC ReplyTo <qa2@test.local>,",
            "\t\"Third, Person\" <qa3@test.local>",
            "To: qa1@test.local",
            "Subject: RC106 reply-to probe",
            "Message-ID: <1.2@test.local>",
            "",
            "body",
            "",
        ]
        .join(eol)
        .into_bytes()
    }

    #[test]
    fn a_folded_reply_to_with_several_addresses_is_read_whole_with_either_line_ending() {
        for eol in ["\r\n", "\n"] {
            let h = from_raw(&stored_message(eol));
            assert_eq!(h.reply_to, vec!["\"RC ReplyTo\" <qa2@test.local>".to_string(), "\"Third, Person\" <qa3@test.local>".to_string()], "eol {eol:?}: {:?}", h.reply_to);
            assert_eq!(h.from.as_deref(), Some("\"RC Sender\" <sender@test.local>"));
        }
    }

    #[test]
    fn the_log_line_says_how_many_reply_to_addresses_are_the_persons_own() {
        let h = from_raw(&stored_message("\r\n"));
        let own = vec!["qa1@test.local".to_string(), "QA2@test.local".to_string()];
        assert_eq!(log_text(&h, "body", &own), "reply headers: source=body, reply-to=2 address(es), own removed=1");
        assert_eq!(log_text(&h, "fetch", &[]), "reply headers: source=fetch, reply-to=2 address(es), own removed=0");
        assert_eq!(log_text(&from_raw(b"From: a@x.test\r\n\r\nx"), "fetch", &own), "reply headers: source=fetch, reply-to=0 address(es), own removed=0");
    }

    /// A tiny IMAP server that answers `UID FETCH` with `fetch` (the untagged part, written by the test) and everything else the way a session needs.
    fn serve_fetch(fetch: Vec<u8>) -> u16 {
        use std::io::{BufRead, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let fetch = fetch.clone();
                std::thread::spawn(move || {
                    let mut w = c.try_clone().unwrap();
                    let mut r = std::io::BufReader::new(c);
                    w.write_all(b"* OK GreenMail-like ready\r\n").unwrap();
                    let mut line = String::new();
                    loop {
                        line.clear();
                        if r.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let (tag, cmd) = line.trim_end().split_once(' ').unwrap_or(("*", ""));
                        let up = cmd.to_uppercase();
                        if up.starts_with("SELECT") {
                            w.write_all(format!("* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n{tag} OK [READ-WRITE] done\r\n").as_bytes()).unwrap();
                        } else if up.starts_with("UID FETCH") {
                            w.write_all(&fetch).unwrap();
                            w.write_all(format!("{tag} OK FETCH completed\r\n").as_bytes()).unwrap();
                        } else if up.starts_with("LOGOUT") {
                            w.write_all(format!("* BYE bye\r\n{tag} OK done\r\n").as_bytes()).unwrap();
                            return;
                        } else {
                            w.write_all(format!("{tag} OK {cmd} done\r\n").as_bytes()).unwrap();
                        }
                    }
                });
            }
        });
        port
    }

    fn untagged(n: u32, items: &str, section: &str, raw: &[u8]) -> Vec<u8> {
        let mut out = format!("* {n} FETCH ({items}{section} {{{}}}\r\n", raw.len()).into_bytes();
        out.extend_from_slice(raw);
        out.extend_from_slice(b")\r\n");
        out
    }

    fn session(port: u16) -> imap::Session<std::net::TcpStream> {
        let mut c = imap::Client::new(std::net::TcpStream::connect(("127.0.0.1", port)).unwrap());
        c.read_greeting().unwrap();
        c.login("u", "p").map_err(|e| e.0).unwrap()
    }

    /// What the app reads when a message is downloaded (`UID FETCH n BODY.PEEK[]`), for servers that word the answer differently: the Reply-To
    /// must come out of every one of them, and from the right message.
    #[test]
    fn reply_to_survives_the_ways_servers_answer_a_fetch() {
        let raw = stored_message("\r\n");
        let other = b"From: someone@else.test\r\nTo: qa1@test.local\r\nMessage-ID: <other@test.local>\r\n\r\nnot this one\r\n".to_vec();
        let lf = stored_message("\n");
        let variants: Vec<(&str, Vec<u8>)> = vec![
            ("standard", untagged(1, "UID 5 ", "BODY[]", &raw)),
            ("flags before the UID", untagged(1, "FLAGS (\\Seen) UID 5 INTERNALDATE \"17-Oct-2026 10:00:00 +0000\" ", "BODY[]", &raw)),
            ("UID after the body", {
                let mut v = format!("* 1 FETCH (BODY[] {{{}}}\r\n", raw.len()).into_bytes();
                v.extend_from_slice(&raw);
                v.extend_from_slice(b" UID 5)\r\n");
                v
            }),
            ("lower case item names", untagged(1, "uid 5 ", "body[]", &raw)),
            ("another message's item first", [untagged(2, "UID 9 ", "BODY[]", &other), untagged(1, "UID 5 ", "BODY[]", &raw)].concat()),
            ("a message stored with LF only", untagged(1, "UID 5 ", "BODY[]", &lf)),
            ("an unrelated untagged line before", [b"* 3 EXISTS\r\n* FLAGS (\\Seen)\r\n".to_vec(), untagged(1, "UID 5 ", "BODY[]", &raw)].concat()),
        ];
        for (name, answer) in variants {
            let mut s = session(serve_fetch(answer));
            let got = crate::mail::fetch_raw(&mut s, "INBOX", 5).unwrap_or_else(|e| panic!("{name}: {e}"));
            let h = from_raw(&got);
            assert_eq!(h.reply_to.len(), 2, "{name}: {:?}", h.reply_to);
            assert_eq!(h.reply_to[0], "\"RC ReplyTo\" <qa2@test.local>", "{name}: in order");
            assert_eq!(h.message_id.as_deref(), Some("<1.2@test.local>"), "{name}: the right message");
        }
        // a server that has no body for the message (NIL): an error the caller explains, never a wrong message
        let mut s = session(serve_fetch(b"* 1 FETCH (UID 5 BODY[] NIL)\r\n".to_vec()));
        assert!(crate::mail::fetch_raw(&mut s, "INBOX", 5).is_err());
    }
}
