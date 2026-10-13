//! The one-line preview ("snippet") of a message in the list: readable words only.
//!
//! Visible text is taken from the text/plain part when the message has a real one, otherwise from the HTML. The HTML is read
//! by a small scanner that never lets markup text through: `<style>`, `<script>`, `<head>`, `<title>`, `<template>`, `<xml>`,
//! comments (conditional comments for Outlook included) and doctype / CDATA are skipped whole. Hidden preheader text is kept
//! (it is what mail apps show), but the invisible padding after it (`&zwnj;&nbsp;` runs, figure spaces, soft hyphens, zero-width
//! characters) is removed and white space is collapsed. The result is cut at a word boundary.

use rusqlite::{params, Connection};

/// Longest snippet, in characters.
pub const SNIPPET_MAX: usize = 200;
/// Stop reading a big HTML body once this many bytes of text are collected (the snippet needs a few hundred characters).
const SCAN_CAP: usize = 4096;
/// Settings key that marks the one-time clean-up of stored snippets as done.
const FIXED_KEY: &str = "snippet_fix_v1";

/// Elements whose content is never visible text.
const SKIP: &[&[u8]] = &[b"style", b"script", b"title", b"template", b"xml"];
/// Elements that do not separate words (everything else puts a space between its neighbours).
const INLINE: &[&[u8]] = &[b"a", b"b", b"i", b"u", b"s", b"em", b"strong", b"span", b"font", b"small", b"big", b"sup", b"sub", b"abbr", b"code", b"mark", b"label", b"wbr"];

fn find_ci(h: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from >= h.len() || h.len() - from < needle.len() {
        return None;
    }
    let first = needle[0].to_ascii_lowercase();
    let last_start = h.len() - needle.len();
    let mut i = from;
    while i <= last_start {
        if h[i].to_ascii_lowercase() == first && h[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_bytes(h: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= h.len() || h.len() - from < needle.len() {
        return None;
    }
    h[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// The `>` that ends the tag whose name ends at `from`, skipping quoted attribute values.
fn tag_end(b: &[u8], from: usize) -> Option<usize> {
    let mut k = from;
    while k < b.len() {
        match b[k] {
            b'>' => return Some(k),
            q @ (b'"' | b'\'') => {
                let after_eq = b[..k].iter().rev().find(|c| !c.is_ascii_whitespace()).map(|c| *c == b'=').unwrap_or(false);
                match after_eq.then(|| b[k + 1..].iter().position(|c| *c == q)).flatten() {
                    Some(p) => k += p + 2,
                    None => k += 1,
                }
            }
            _ => k += 1,
        }
    }
    None
}

fn named_entity(n: &str) -> Option<&'static str> {
    Some(match n {
        "nbsp" | "ensp" | "emsp" | "thinsp" | "numsp" | "puncsp" | "hairsp" | "MediumSpace" | "NewLine" | "Tab" => " ",
        "zwnj" | "zwj" | "shy" | "lrm" | "rlm" | "ZeroWidthSpace" | "NoBreak" => "",
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "hellip" => "\u{2026}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201C}",
        "rdquo" => "\u{201D}",
        "bull" => "\u{2022}",
        "middot" => "\u{00B7}",
        "laquo" => "\u{00AB}",
        "raquo" => "\u{00BB}",
        "copy" => "\u{00A9}",
        "reg" => "\u{00AE}",
        "trade" => "\u{2122}",
        "euro" => "\u{20AC}",
        "pound" => "\u{00A3}",
        "yen" => "\u{00A5}",
        "cent" => "\u{00A2}",
        "deg" => "\u{00B0}",
        "times" => "\u{00D7}",
        "rarr" => "\u{2192}",
        "larr" => "\u{2190}",
        _ => return None,
    })
}

/// `&name;`, `&#123;` or `&#x1F;` at the start of `s` (which begins with `&`): the text it stands for and its length in bytes.
fn entity(s: &str) -> Option<(String, usize)> {
    let semi = s.bytes().take(12).position(|c| c == b';')?;
    let body = &s[1..semi];
    let text = if let Some(num) = body.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => num.parse::<u32>().ok()?,
        };
        char::from_u32(code).map(String::from).unwrap_or_default()
    } else {
        named_entity(body)?.to_string()
    };
    Some((text, semi + 1))
}

/// Visible text of an HTML document, entities decoded, not yet collapsed.
fn html_raw_text(h: &str) -> String {
    let b = h.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() && out.len() < SCAN_CAP {
        match b[i] {
            b'<' => {
                let rest = &b[i..];
                if rest.starts_with(b"<!-->") {
                    i += 5;
                } else if rest.starts_with(b"<!--->") {
                    i += 6;
                } else if rest.starts_with(b"<!--") {
                    // comments, conditional comments (<!--[if mso]> ... <![endif]-->) included
                    i = find_bytes(b, i + 4, b"-->").map(|p| p + 3).unwrap_or(b.len());
                } else if rest.starts_with(b"<!") || rest.starts_with(b"<?") {
                    // doctype, <![endif]>, <![CDATA[ ... ]]>, processing instructions
                    i = b[i..].iter().position(|c| *c == b'>').map(|p| i + p + 1).unwrap_or(b.len());
                } else {
                    let mut j = i + 1;
                    let closing = b.get(j) == Some(&b'/');
                    if closing {
                        j += 1;
                    }
                    if !b.get(j).map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
                        out.push('<'); // a lone "<" in text ("a < b")
                        i += 1;
                        continue;
                    }
                    let ns = j;
                    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b':' || b[j] == b'-') {
                        j += 1;
                    }
                    let name = b[ns..j].to_ascii_lowercase();
                    let Some(end) = tag_end(b, j) else { break };
                    let self_closing = b[end - 1] == b'/';
                    i = end + 1;
                    if closing || self_closing {
                        if !INLINE.contains(&name.as_slice()) {
                            out.push(' ');
                        }
                        continue;
                    }
                    if SKIP.contains(&name.as_slice()) {
                        let close = [b"</".as_slice(), name.as_slice()].concat();
                        i = match find_ci(b, i, &close) {
                            Some(p) => b[p..].iter().position(|c| *c == b'>').map(|q| p + q + 1).unwrap_or(b.len()),
                            None => b.len(),
                        };
                    } else if name == b"head" {
                        // the head is not text; a head that is never closed ends where the body starts
                        if let Some(p) = find_ci(b, i, b"</head") {
                            i = b[p..].iter().position(|c| *c == b'>').map(|q| p + q + 1).unwrap_or(b.len());
                        } else if let Some(p) = find_ci(b, i, b"<body") {
                            i = p;
                        }
                    } else if !INLINE.contains(&name.as_slice()) {
                        out.push(' ');
                    }
                }
            }
            b'&' => match entity(&h[i..]) {
                Some((t, n)) => {
                    out.push_str(&t);
                    i += n;
                }
                None => {
                    out.push('&');
                    i += 1;
                }
            },
            _ => {
                let n = b[i..].iter().position(|c| *c == b'<' || *c == b'&').unwrap_or(b.len() - i);
                out.push_str(&h[i..i + n]);
                i += n;
            }
        }
    }
    out
}

/// Characters that take no room (zero-width, joiners, soft hyphen, bidi marks, filler letters used as padding).
fn invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}' | '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{180B}'..='\u{180E}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}'
        | '\u{FE00}'..='\u{FE0F}')
}

/// Drop invisible characters, turn every kind of space and control character into one space, collapse runs, trim.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(SCAN_CAP + 64));
    let mut space = false;
    for c in s.chars() {
        if invisible(c) {
            continue;
        }
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    out
}

/// Visible text of an HTML document as one clean line.
pub fn html_text(h: &str) -> String {
    clean_text(&html_raw_text(h))
}

/// At most `SNIPPET_MAX` characters, ending at a word boundary when the text had to be cut.
pub fn truncate_words(s: &str) -> String {
    let Some((cut, _)) = s.char_indices().nth(SNIPPET_MAX) else { return s.to_string() };
    let head = &s[..cut];
    if s[cut..].starts_with(' ') {
        return head.trim_end().to_string();
    }
    match head.rfind(' ') {
        Some(p) if p >= SNIPPET_MAX / 2 => head[..p].trim_end().to_string(),
        _ => head.to_string(), // one very long word: cut it
    }
}

/// The snippet of a message. `real_text` is the text/plain part when the message has one (not text made from the HTML).
pub fn make(real_text: Option<&str>, html: Option<&str>) -> String {
    if let Some(c) = real_text.map(clean_text).filter(|c| !c.is_empty()) {
        return truncate_words(&c);
    }
    if let Some(c) = html.map(html_text).filter(|c| !c.is_empty()) {
        return truncate_words(&c);
    }
    String::new()
}

/// A stored snippet that looks like style sheet text or markup instead of words.
pub fn looks_like_junk(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with(['#', '.', '@', '<']) || (t.contains('{') && t.contains(';'))
}

/// One-time clean-up of snippets stored before the scanner above existed: rows whose snippet looks like CSS or markup get a
/// new one from their stored `body_html` (or `body_text`). Safe on a big database: it walks `rowid` in batches of 200, one
/// short transaction each, never touches a row without a body, never writes an empty snippet, and can be run again (it only
/// changes rows whose new snippet differs). Returns the number of rows changed.
pub fn fix_stored(conn: &Connection) -> Result<usize, String> {
    let done: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [FIXED_KEY], |r| r.get(0)).ok();
    if done.is_some() {
        return Ok(0);
    }
    let e = |x: rusqlite::Error| x.to_string();
    let mut changed = 0usize;
    // one mail file at a time: the `messages` view has no rowid
    for schema in crate::shard::message_schemas(conn) {
        let table = format!("{schema}.messages");
        let mut last = 0i64;
        loop {
            let batch: Vec<(i64, String)> = {
                let mut st = conn
                    .prepare(&format!(
                        "SELECT rowid, snippet FROM {table} WHERE rowid>?1
                           AND (body_html IS NOT NULL OR body_text IS NOT NULL)
                           AND (snippet LIKE '#%' OR snippet LIKE '.%' OR snippet LIKE '@%' OR snippet LIKE '<%'
                                OR (instr(snippet,'{{')>0 AND instr(snippet,';')>0))
                         ORDER BY rowid LIMIT 200"
                    ))
                    .map_err(e)?;
                let rows = st.query_map([last], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
                rows
            };
            let Some(&(max, _)) = batch.last() else { break };
            let tx = conn.unchecked_transaction().map_err(e)?;
            for (rid, old) in &batch {
                if !looks_like_junk(old) {
                    continue;
                }
                let (html, text): (Option<String>, Option<String>) =
                    tx.query_row(&format!("SELECT body_html, body_text FROM {table} WHERE rowid=?1"), [rid], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
                let new = {
                    let from_html = make(None, html.as_deref());
                    if from_html.is_empty() { make(text.as_deref(), None) } else { from_html }
                };
                if !new.is_empty() && new != *old {
                    tx.execute(&format!("UPDATE {table} SET snippet=?1 WHERE rowid=?2"), params![new, rid]).map_err(e)?;
                    changed += 1;
                }
            }
            tx.commit().map_err(e)?;
            last = max;
        }
    }
    conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')", [FIXED_KEY]).map_err(e)?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEWSLETTER: &str = r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml"><head><meta charset="utf-8"><title>IP2Location Newsletter</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>table,td{border-collapse:collapse;}</style><![endif]-->
<style type="text/css">#outlook a { padding: 0; } body { margin:0; } @media only screen and (max-width:600px){ .col{width:100%!important;} }</style>
<script>var x = "<div>fake</div>"; if (a < b) { go(); }</script></head>
<body><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Big savings &amp; new data &zwnj;&nbsp;&zwnj;&nbsp;&#8199;&#847; &zwnj;&nbsp;&shy;&#x200B;</div>
<!--[if !mso]><!--><div>Hello <b>Nam</b>,</div><!--<![endif]--><!--[if mso]><table><tr><td>Outlook only</td></tr></table><![endif]-->
<table><tr><td>Row&nbsp;one</td><td>Row two</td></tr></table><p>a &lt; b &amp; c</p><img alt="logo" src="data:image/png;base64,AAAA>BBB"></body></html>"#;

    #[test]
    fn newsletter_snippet_has_words_only() {
        let s = html_text(NEWSLETTER);
        assert_eq!(s, "Big savings & new data Hello Nam, Row one Row two a < b & c");
        for bad in ["{", "outlook a", "padding", "@media", "mso", "OfficeDocument", "fake", "IP2Location", "Outlook only", "&zwnj", "&nbsp"] {
            assert!(!s.contains(bad), "{bad:?} in {s:?}");
        }
        assert_eq!(make(None, Some(NEWSLETTER)), s);
    }

    #[test]
    fn real_text_part_wins_and_blank_text_falls_back_to_the_html() {
        assert_eq!(make(Some("  Hello\r\n\r\n  there\u{200B}\u{00A0} \u{2007}friend  "), Some("<p>html</p>")), "Hello there friend");
        assert_eq!(make(Some(" \u{200B}\u{00A0}\r\n"), Some("<style>p{x:y}</style><p>html</p>")), "html");
        assert_eq!(make(None, None), "");
        assert_eq!(make(None, Some("<style>a{b:c}</style>")), "");
    }

    #[test]
    fn markup_edge_cases() {
        // an unclosed head ends where the body starts; unclosed style swallows the rest (nothing readable follows it)
        assert_eq!(html_text("<html><head><meta x><title>t</title><body>Hi there</body>"), "Hi there");
        assert_eq!(html_text("Intro<style>p{color:red}"), "Intro");
        // ">" inside a quoted attribute, quotes with an odd apostrophe, uppercase tags
        assert_eq!(html_text(r#"<A HREF="x>y" title='a'>Link</A> <STYLE>b{c:d}</STYLE>after"#), "Link after");
        assert_eq!(html_text("<p title=it's>text</p>"), "text");
        // comments, CDATA, processing instructions
        assert_eq!(html_text("a<!-- <b>x</b> -->b<![CDATA[ z ]]>c<?php echo 1 ?>d"), "abcd");
        assert_eq!(html_text("one<!-->two"), "onetwo");
        // entities
        assert_eq!(html_text("&lt;b&gt; &#65;&#x42; &copy; &unknown; &amp"), "<b> AB \u{a9} &unknown; &amp");
        // inline tags do not split words, block tags do
        assert_eq!(html_text("<b>Bo</b>ld<br>next<div>line</div>"), "Bold next line");
        // multi-byte text survives the byte scanner
        assert_eq!(html_text("<p>Xin chào, Nguyễn Văn Ánh &mdash; 日本語</p>"), "Xin chào, Nguyễn Văn Ánh \u{2014} 日本語");
    }

    #[test]
    fn long_text_is_cut_at_a_word() {
        let words: Vec<String> = (0..80).map(|i| format!("word{i}")).collect();
        let s = clean_text(&words.join("   "));
        let t = truncate_words(&s);
        assert!(t.chars().count() <= SNIPPET_MAX && t.chars().count() > SNIPPET_MAX - 12, "{}", t.chars().count());
        assert!(s.starts_with(&t) && s[t.len()..].starts_with(' '), "cut on a space: {t:?}");
        assert!(!t.ends_with(' '));
        // short text is untouched; one huge word is cut hard
        assert_eq!(truncate_words("short one"), "short one");
        assert_eq!(truncate_words(&"x".repeat(500)).chars().count(), SNIPPET_MAX);
        // exactly at the limit with a space next
        let exact = format!("{} tail", "y".repeat(SNIPPET_MAX));
        assert_eq!(truncate_words(&exact), "y".repeat(SNIPPET_MAX));
        // multi-byte characters are counted as characters
        assert_eq!(truncate_words(&"é".repeat(300)).chars().count(), SNIPPET_MAX);
    }

    #[test]
    fn junk_detection() {
        for j in ["#outlook a { padding: 0; }", ".ExternalClass { width:100%; }", "@media only screen { }", "<div>x</div>", "Hello body { margin:0; } done"] {
            assert!(looks_like_junk(j), "{j}");
        }
        for ok in ["Hello there", "Your order {12} shipped", "Meeting at 10: bring notes; thanks"] {
            assert!(!looks_like_junk(ok), "{ok}");
        }
    }

    fn db() -> Connection {
        crate::db::test_conn(&["a"])
    }

    fn put(c: &Connection, id: &str, snippet: &str, html: Option<&str>, text: Option<&str>) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,body_html,body_text) VALUES(?1,'a','inbox',(SELECT COUNT(*)+1 FROM messages),'t','s','n','x@y.z','','',0,?2,?3,?4)",
            params![id, snippet, html, text],
        )
        .unwrap();
    }

    fn snippet_of(c: &Connection, id: &str) -> String {
        c.query_row("SELECT snippet FROM messages WHERE id=?1", [id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn stored_junk_snippets_are_recomputed_once_and_only_when_a_body_exists() {
        let c = db();
        let junk = "#outlook a { padding: 0; } body { margin:0; }";
        put(&c, "html", junk, Some(NEWSLETTER), Some("#outlook a { padding: 0; }"));
        put(&c, "textonly", ".x { color: red; }", None, Some("Plain words here"));
        put(&c, "nobody", junk, None, None);
        put(&c, "emptybody", junk, Some("<style>p{a:b}</style>"), Some(""));
        put(&c, "fine", "Hello there", Some("<p>Different</p>"), Some("Different"));
        put(&c, "hash", "#1 rated plugin for everything", Some("<p>#1 rated plugin for everything</p>"), None);
        // more rows than one batch
        for i in 0..450 {
            put(&c, &format!("bulk{i}"), "@media print { a { b: c; } }", Some(&format!("<style>a{{b:c}}</style><p>Bulk number {i}</p>")), None);
        }
        c.execute("DELETE FROM settings WHERE key=?1", [FIXED_KEY]).unwrap();
        let n = fix_stored(&c).unwrap();
        assert_eq!(n, 2 + 450, "html row, text-only row and the bulk rows");
        assert_eq!(snippet_of(&c, "html"), "Big savings & new data Hello Nam, Row one Row two a < b & c");
        assert_eq!(snippet_of(&c, "textonly"), "Plain words here");
        assert_eq!(snippet_of(&c, "nobody"), junk, "no body: untouched");
        assert_eq!(snippet_of(&c, "emptybody"), junk, "nothing readable: untouched");
        assert_eq!(snippet_of(&c, "fine"), "Hello there", "a normal snippet is never replaced");
        assert_eq!(snippet_of(&c, "hash"), "#1 rated plugin for everything");
        assert_eq!(snippet_of(&c, "bulk449"), "Bulk number 449");
        // done once: the flag stops a second run, and without the flag nothing changes either
        assert_eq!(fix_stored(&c).unwrap(), 0);
        c.execute("DELETE FROM settings WHERE key=?1", [FIXED_KEY]).unwrap();
        assert_eq!(fix_stored(&c).unwrap(), 0, "idempotent");
        assert_eq!(snippet_of(&c, "html"), "Big savings & new data Hello Nam, Row one Row two a < b & c");
    }
}
