//! What Compose needs to open a draft: the body with its pictures put back as `data:` URIs (the file name each picture was added with as `data-name`) and the
//! attachments that stay attachments, from ONE read of the message.
//!
//! 1.0.7 D-044: the page used to ask for every part by itself (`attachment_data`, one call per part). Each call parsed the whole message (a ~19 MB encrypted
//! draft with 14 pictures: 14 parses, 14 copies of the decrypted message, 14 base64 encodes) and sent 1.8 MB back, and the page then searched its 25 MB of HTML
//! for each picture to name it. That was 10 of the 14 seconds of the open (QA round 4). The page now makes one call and gets the finished parts. The same
//! steps as before, in the same order: a referenced inline picture goes back into the HTML (the `cid:` reference when it is still there; the pictures up to
//! `mail::INLINE_SYNC_MAX` were embedded when the message was read) and gets its file name; every other part is an attachment.

use crate::mail::{AttMeta, Parts};
use crate::tempstore::Store;
use base64::Engine;
use serde::Serialize;
use std::time::Duration;

/// Data of at least this many characters of base64 (about 190 KB) does not travel with the parts: a marker takes its place and the page asks for it with `draft_data`, one
/// request each (tempstore.rs: one answer of 25 MB holds the app's main thread for 0.3 s, 14 answers of 1.8 MB hold it for 45 ms at a time).
pub const DEFER_MIN: usize = 256 * 1024;
/// What marks the place of deferred data in the HTML of the parts and in an attachment's data; the token follows.
pub const MARK: &str = "hl-deferred-";

static DEFERRED: Store = Store::new(Duration::from_secs(300), 400_000_000);

/// The data kept under `token` (once).
pub fn take_deferred(token: &str) -> Option<String> {
    DEFERRED.take(token)
}

fn defer(data: String, deferred: &mut Vec<String>) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    DEFERRED.put(token.clone(), data);
    let marker = format!("{MARK}{token}");
    deferred.push(token);
    marker
}

/// An attachment as Compose keeps it (`Att` in the page).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorAtt {
    pub filename: String,
    pub mime: String,
    pub data_base64: String,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorParts {
    /// the body for the editor: pictures as `data:` URIs, each with `data-name` (None: the message has no HTML)
    pub html: Option<String>,
    /// the text part, for a draft that has no HTML
    pub text: Option<String>,
    /// the parts that are not pictures of the body
    pub attachments: Vec<EditorAtt>,
    /// the tokens of the data that was left out (`MARK` + token stands in its place; `draft_data` gives it): empty when everything is in
    pub deferred: Vec<String>,
}

/// `html` and `metas` are what `mail::parse` made of the message (or what the database holds for it), `message` the message they come from. With `message` None (it could
/// not be read) the draft still opens: its body as it is and no attachments, as an unreadable part always did (it must not stop the draft from opening).
/// `defer`: the data of a part of `DEFER_MIN` characters or more is left out (see there); false: everything is in the parts.
pub fn editor_parts(html: Option<String>, text: Option<String>, metas: &[AttMeta], message: Option<&Parts>, defer_big: bool) -> EditorParts {
    let mut parts = EditorParts { html, text, attachments: vec![], deferred: vec![] };
    let Some(message) = message else { return parts };
    if metas.is_empty() {
        return parts;
    }
    // the cid: references of the HTML as it is now, looked up once: the pictures are put in with one copy of the HTML below
    let lower = parts.html.as_ref().filter(|_| metas.iter().any(|a| a.inline && a.referenced && a.cid.is_some())).map(|h| h.to_ascii_lowercase());
    let mut uris: Vec<String> = vec![];
    let mut spans: Vec<(usize, usize, usize)> = vec![];
    let mut named: Vec<(String, String)> = vec![]; // (the picture's base64 - or the marker of it -, its file name), in the order of the parts
    let mut deferred: Vec<String> = vec![];
    let b64 = base64::engine::general_purpose::STANDARD;
    message.for_each_attachment(|i, name, bytes| {
        let Some(a) = metas.get(i).filter(|a| a.index == i) else { return };
        if a.inline && a.referenced {
            // a picture of the body (one the HTML does not hold, or has no cid, is not one: it is skipped, as it always was)
            let (Some(_), Some(cid), Some(lower)) = (&parts.html, a.cid.as_deref(), &lower) else { return };
            let mut data = b64.encode(bytes);
            if defer_big && data.len() >= DEFER_MIN {
                data = defer(data, &mut deferred);
            }
            let found = crate::mail::cid_ref_spans_in(lower, cid);
            if !found.is_empty() {
                uris.push(format!("data:{};base64,{data}", a.mime));
                spans.extend(found.into_iter().map(|(x, y)| (x, y, uris.len() - 1)));
            }
            named.push((data, if a.name.is_empty() { name } else { a.name.clone() }));
        } else {
            let mut data = b64.encode(bytes);
            if defer_big && data.len() >= DEFER_MIN {
                data = defer(data, &mut deferred);
            }
            parts.attachments.push(EditorAtt { filename: name, mime: a.mime.clone(), data_base64: data });
        }
    });
    if let Some(h) = parts.html.take() {
        let mut h = if spans.is_empty() {
            h
        } else {
            spans.sort_unstable();
            crate::mail::splice_uris(&h, &spans, &uris)
        };
        if !named.is_empty() {
            h = name_pictures(h, &named);
        }
        parts.html = Some(h);
    }
    parts.deferred = deferred;
    parts
}

/// The editor's own name for a picture is `data-name` on its `<img>` (the message part knows the file name, the HTML does not). Each picture (its base64, in the
/// order of the parts) names the first `<img>` that has no name yet and whose `data:` source holds it, so two equal pictures name two tags (WP5f).
fn name_pictures(html: String, pics: &[(String, String)]) -> String {
    // every `<img ...>` tag: (start, end past the `>`), and whether it is named already
    let mut tags: Vec<(usize, usize, bool)> = vec![];
    let mut at = 0;
    while let Some(i) = html[at..].find('<') {
        let start = at + i;
        let rest = &html[start + 1..];
        let is_img = rest.len() >= 3 && rest.as_bytes()[..3].eq_ignore_ascii_case(b"img") && !rest.as_bytes().get(3).is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
        if !is_img {
            at = start + 1;
            continue;
        }
        let end = html[start..].find('>').map(|e| start + e + 1).unwrap_or(html.len());
        tags.push((start, end, has_name(&html[start..end])));
        at = end;
    }
    let mut insert: Vec<(usize, String)> = vec![];
    for (data, name) in pics {
        if name.is_empty() {
            continue;
        }
        let hit = tags.iter_mut().find(|(s, e, named)| !*named && source_data(&html[*s..*e]) == Some(data.as_str()));
        if let Some((s, _, named)) = hit {
            *named = true;
            insert.push((*s + 4, format!(" data-name=\"{}\"", escape_attr(name))));
        }
    }
    if insert.is_empty() {
        return html;
    }
    insert.sort_unstable();
    let mut out = String::with_capacity(html.len() + insert.iter().map(|(_, t)| t.len()).sum::<usize>());
    let mut last = 0;
    for (pos, text) in insert {
        out.push_str(&html[last..pos]);
        out.push_str(&text);
        last = pos;
    }
    out.push_str(&html[last..]);
    out
}

/// The base64 of the `data:` URI an `<img>` tag shows: what follows `;base64,` up to the quote (or white space, or the end of the tag).
fn source_data(tag: &str) -> Option<&str> {
    let from = tag.find(";base64,")? + ";base64,".len();
    let rest = &tag[from..];
    let len = rest.find(|c: char| c == '"' || c == '\'' || c == '>' || c.is_ascii_whitespace()).unwrap_or(rest.len());
    Some(&rest[..len])
}

/// The tag has a `data-name="..."` (or '...') attribute already (the page's `NAME` expression).
fn has_name(tag: &str) -> bool {
    let b = tag.as_bytes();
    let mut i = 0;
    while let Some(p) = tag[i..].find(|c: char| c.is_ascii_whitespace()) {
        let s = i + p + 1;
        if b.len() >= s + 9 && b[s..s + 9].eq_ignore_ascii_case(b"data-name") {
            let mut j = s + 9;
            while j < b.len() && b[j].is_ascii_whitespace() {
                j += 1;
            }
            if b.get(j) == Some(&b'=') {
                j += 1;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if let Some(q) = b.get(j).filter(|q| **q == b'"' || **q == b'\'') {
                    if b[j + 1..].contains(q) {
                        return true;
                    }
                }
            }
        }
        i = s;
    }
    false
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;

    fn picture(i: usize, size: usize) -> Vec<u8> {
        (0..size).map(|n| ((n * 31 + i * 7 + (n >> 8) * 13) % 251) as u8).collect()
    }

    /// A multipart/related message: an HTML body that refers to `pics` by cid, the pictures as inline parts and `files` as attachments.
    fn message(html: &str, pics: &[(&str, &str, Vec<u8>)], files: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut m = String::from("From: a@x.test\r\nTo: b@x.test\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"MIX\"\r\n\r\n--MIX\r\nContent-Type: multipart/related; boundary=\"REL\"\r\n\r\n--REL\r\nContent-Type: text/html; charset=utf-8\r\n\r\n");
        m.push_str(html);
        for (cid, name, bytes) in pics {
            m.push_str(&format!("\r\n--REL\r\nContent-Type: image/png; name=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <{cid}>\r\nContent-Disposition: inline; filename=\"{name}\"\r\n\r\n{}", B64.encode(bytes)));
        }
        m.push_str("\r\n--REL--\r\n");
        for (name, bytes) in files {
            m.push_str(&format!("--MIX\r\nContent-Type: application/octet-stream; name=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"{name}\"\r\n\r\n{}\r\n", B64.encode(bytes)));
        }
        m.push_str("--MIX--\r\n");
        m.into_bytes()
    }

    fn parts_of(raw: &[u8]) -> EditorParts {
        let msg = crate::mail::open_parts(raw).unwrap();
        let (html, text, metas) = msg.view();
        editor_parts(html, text, &metas, Some(&msg), false)
    }

    #[test]
    fn pictures_go_back_into_the_body_with_their_names_and_files_stay_attachments() {
        let (p1, p2) = (picture(1, 3000), picture(2, 4000));
        let raw = message(
            r#"<p>one</p><img src="cid:a@x" alt="A"><p>two</p><img src="cid:b@x"><p>end</p>"#,
            &[("a@x", "first picture.png", p1.clone()), ("b@x", "second & <third>.png", p2.clone())],
            &[("notes.bin", vec![1, 2, 3, 4, 5])],
        );
        let parts = parts_of(&raw);
        let html = parts.html.unwrap();
        assert!(!html.contains("cid:"), "{html}");
        assert!(html.contains(&format!(r#"<img data-name="first picture.png" src="data:image/png;base64,{}" alt="A">"#, B64.encode(&p1))), "{}", &html[..200.min(html.len())]);
        assert!(html.contains(&format!(r#"<img data-name="second &amp; &lt;third&gt;.png" src="data:image/png;base64,{}">"#, B64.encode(&p2))));
        assert_eq!(parts.attachments, vec![EditorAtt { filename: "notes.bin".into(), mime: "application/octet-stream".into(), data_base64: B64.encode([1, 2, 3, 4, 5]) }]);
    }

    #[test]
    fn two_equal_pictures_name_two_tags_and_a_named_tag_is_left_alone() {
        let p = picture(3, 2000);
        let raw = message(r#"<img src="cid:a@x"><img src="cid:b@x">"#, &[("a@x", "one.png", p.clone()), ("b@x", "two.png", p.clone())], &[]);
        let html = parts_of(&raw).html.unwrap();
        let b64 = B64.encode(&p);
        assert_eq!(html, format!(r#"<img data-name="one.png" src="data:image/png;base64,{b64}"><img data-name="two.png" src="data:image/png;base64,{b64}">"#));
        // a tag that has a name already keeps it, the picture names the next one
        let named = name_pictures(format!(r#"<img data-name="mine.png" src="data:image/png;base64,{b64}"><img src="data:image/png;base64,{b64}">"#), &[(b64.clone(), "x.png".into())]);
        assert_eq!(named, format!(r#"<img data-name="mine.png" src="data:image/png;base64,{b64}"><img data-name="x.png" src="data:image/png;base64,{b64}">"#));
        assert!(has_name(r#"<img src="a" DATA-NAME = 'x'>"#) && !has_name(r#"<img src="a" data-names="x">"#) && !has_name(r#"<img src="data-name='x'">"#));
    }

    #[test]
    fn a_picture_that_was_not_embedded_gets_its_cid_replaced() {
        // (the pictures over mail::INLINE_SYNC_MAX stay `cid:` references until the draft is opened)
        let big = picture(4, crate::mail::INLINE_SYNC_MAX + 1000);
        let small = picture(5, 1500);
        let raw = message(r#"<img src="cid:big@x"><img src='cid:small@x'><img src="cid:big@xy">"#, &[("big@x", "big.png", big.clone()), ("small@x", "small.png", small.clone())], &[]);
        let msg = crate::mail::open_parts(&raw).unwrap();
        let (html0, _, metas) = msg.view();
        assert!(html0.as_deref().unwrap().contains("cid:big@x") && html0.as_deref().unwrap().contains("cid:small@x"), "the view leaves every picture a cid: reference");
        // what the read of the message (mail::parse: what the database holds) embeds: the small one only
        let parsed = crate::mail::parse(0, &raw, true, false, 0).unwrap().html.unwrap();
        assert!(parsed.contains("cid:big@x") && !parsed.contains("cid:small@x"));
        let html = editor_parts(html0, None, &metas, Some(&msg), false).html.unwrap();
        assert!(html.contains(&format!(r#"<img data-name="big.png" src="data:image/png;base64,{}">"#, B64.encode(&big))));
        assert!(html.contains(&format!(r#"data-name="small.png" src='data:image/png;base64,{}'>"#, B64.encode(&small))));
        assert!(html.contains(r#"<img src="cid:big@xy">"#), "a longer id is not this picture");
    }

    #[test]
    fn big_data_is_left_out_with_a_marker_and_comes_back_by_its_token_once() {
        let big = picture(6, 300_000); // 400 000 characters of base64: over DEFER_MIN
        let small = picture(7, 1500);
        let file = picture(8, 280_000);
        let raw = message(r#"<img src="cid:big@x"><img src="cid:small@x">"#, &[("big@x", "big.png", big.clone()), ("small@x", "small.png", small.clone())], &[("doc.bin", file.clone())]);
        let msg = crate::mail::open_parts(&raw).unwrap();
        let (h, t, metas) = msg.view();
        let whole = editor_parts(h.clone(), t.clone(), &metas, Some(&msg), false);
        assert!(whole.deferred.is_empty(), "everything in: nothing left out");
        let lean = editor_parts(h, t, &metas, Some(&msg), true);
        assert_eq!(lean.deferred.len(), 2, "the big picture and the big file are left out");
        let html = lean.html.clone().unwrap();
        assert!(html.len() < 4000 && !html.contains(&B64.encode(&big)), "the big picture is not in the HTML: {} characters", html.len());
        assert!(html.contains(&B64.encode(&small)), "a small picture stays in");
        assert!(html.contains(&format!("{MARK}{}", lean.deferred[0])), "the marker of the first one is where its data was");
        assert!(lean.attachments[0].data_base64 == format!("{MARK}{}", lean.deferred[1]), "the file's data is a marker too");
        // put back, it is what the whole answer holds (the name tags too)
        let mut back = html.clone();
        let picture_data = take_deferred(&lean.deferred[0]).expect("the data of the picture");
        back = back.replace(&format!("{MARK}{}", lean.deferred[0]), &picture_data);
        assert_eq!(back, whole.html.clone().unwrap());
        assert_eq!(take_deferred(&lean.deferred[1]).unwrap(), whole.attachments[0].data_base64);
        // once: a second ask finds nothing
        assert!(take_deferred(&lean.deferred[0]).is_none() && take_deferred("0123456789abcdef0123456789abcdef").is_none());
    }

    #[test]
    fn a_message_that_cannot_be_read_still_opens_with_its_body() {
        let metas = vec![AttMeta { index: 0, name: "a.png".into(), mime: "image/png".into(), size: 3, inline: false, cid: None, referenced: false }];
        let p = editor_parts(Some("<p>hi</p>".into()), Some("hi".into()), &metas, None, false);
        assert_eq!(p, EditorParts { html: Some("<p>hi</p>".into()), text: Some("hi".into()), attachments: vec![], deferred: vec![] });
        let junk = crate::mail::open_parts(b"\x00 not a message").unwrap();
        let p = editor_parts(Some("<p>hi</p>".into()), None, &metas, Some(&junk), false);
        assert_eq!(p.html.as_deref(), Some("<p>hi</p>"));
    }

    /// Not run by `cargo test`: the stages of opening a large encrypted draft, in milliseconds (the 19 MB draft of QA round 4: 14 pictures of 1.36 MB).
    ///   cargo test --release --lib draftopen::tests::stage_times_of_a_large_encrypted_draft -- --ignored --nocapture
    #[test]
    #[ignore]
    fn stage_times_of_a_large_encrypted_draft() {
        use crate::openpgp::{encrypt, generate, unlock_clone, Algo, Recipient};
        use crate::pgpmail::{open, Ctx};
        use std::collections::HashSet;
        use std::time::Instant;
        let ms = |t: Instant| t.elapsed().as_millis();
        let pics: Vec<(String, String, Vec<u8>)> = (0..14).map(|i| (format!("p{i}@x"), format!("r5-{i}.png"), picture(i, 1_359_000))).collect();
        let refs: Vec<(&str, &str, Vec<u8>)> = pics.iter().map(|(c, n, b)| (c.as_str(), n.as_str(), b.clone())).collect();
        let html: String = pics.iter().map(|(c, _, _)| format!(r#"<p><img src="cid:{c}"></p>"#)).collect();
        let inner = message(&format!("<p>body</p>{html}"), &refs, &[]);
        let sk = unlock_clone(&generate(Algo::Cv25519, "Perf <perf@x.test>", None, "pw-12345678").unwrap(), "pw-12345678").unwrap();
        let pk = sk.to_public_key();
        let t = Instant::now();
        let armored = encrypt(&inner, &[Recipient { key: &pk, hidden: false }], None).unwrap();
        println!("encrypt {} MB plain -> {} MB armored: {} ms", inner.len() / 1_000_000, armored.len() / 1_000_000, ms(t));
        let raw = format!(
            "From: a@x.test\r\nTo: b@x.test\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"ENC\"\r\n\r\n--ENC\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--ENC\r\nContent-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\r\n{}\r\n--ENC--\r\n",
            armored.replace('\n', "\r\n")
        )
        .into_bytes();
        let publics = vec![pk];
        let verified = HashSet::new();
        let ctx = Ctx { unlocked: vec![&sk], locked: vec![], publics: &publics, verified: &verified };
        let t = Instant::now();
        let opened = open(&raw, &ctx);
        println!("pgpmail::open (detect + decrypt): {} ms (decryption {})", ms(t), opened.security.decryption);
        let plain = opened.plain.as_deref().unwrap();
        let t = Instant::now();
        let p = crate::mail::parse(0, plain, true, false, 0).unwrap();
        println!("mail::parse of the decrypted message (what get_thread did): {} ms, html {} MB", ms(t), p.html.as_deref().map_or(0, |h| h.len() / 1_000_000));
        let t = Instant::now();
        let msg = crate::mail::open_parts(plain).unwrap();
        let (h, tx, metas) = msg.view();
        println!("mail::open_parts + view (one parse: the body and the part list): {} ms", ms(t));
        let t = Instant::now();
        let parts = editor_parts(h, tx, &metas, Some(&msg), true);
        println!("editor_parts (the pictures back in, the names): {} ms, html {} MB", ms(t), parts.html.as_deref().map_or(0, |h| h.len() / 1_000_000));
        let t = Instant::now();
        let json = serde_json::to_string(&parts).unwrap();
        println!("serde_json of the parts: {} ms, {} MB", ms(t), json.len() / 1_000_000);
        // what the parse did before 1.0.7 D-044 for the pictures: every picture looked in, and copied, the HTML that had grown by the pictures before it
        let t = Instant::now();
        let mut grown = format!("<p>body</p>{html}");
        for (c, _, b) in &pics {
            let uri = format!("data:image/png;base64,{}", B64.encode(b));
            if !crate::mail::cid_ref_spans_in(&grown.to_ascii_lowercase(), c).is_empty() {
                grown = crate::mail::replace_cid_refs(&grown, c, &uri);
            }
        }
        println!("the pictures put in the old way (14 x lower-case + copy of the growing HTML): {} ms", ms(t));
        // what one attachment_data call did, 14 times: a copy of the message, a parse, the part's bytes, base64
        let t = Instant::now();
        let copy = plain.to_vec();
        let _ = crate::mail::parse(0, &copy, true, false, 0);
        let (_, bytes) = crate::mail::attachment_bytes(&copy, 3).unwrap();
        let _ = B64.encode(bytes);
        println!("one old attachment_data call (copy, parse, part, base64): {} ms", ms(t));
    }

    #[test]
    fn the_result_is_what_the_page_did_with_one_call_per_part() {
        // the old page: attachment_bytes for every part, the cid replaced and the name put on the first tag that holds the picture
        let pics: Vec<(String, String, Vec<u8>)> = (0..6).map(|i| (format!("p{i}@x"), format!("pic-{i}.png"), picture(10 + i, 1000 + i * 100))).collect();
        let refs: Vec<(&str, &str, Vec<u8>)> = pics.iter().map(|(c, n, b)| (c.as_str(), n.as_str(), b.clone())).collect();
        let html: String = pics.iter().map(|(c, _, _)| format!(r#"<p><img src="cid:{c}"></p>"#)).collect();
        let raw = message(&html, &refs, &[("a.txt", b"hello".to_vec()), ("b.bin", vec![9; 50])]);
        let msg = crate::mail::open_parts(&raw).unwrap();
        let (h0, t0, metas) = msg.view();
        let new = editor_parts(h0, t0, &metas, Some(&msg), false);
        // the page of before 1.0.7 D-044: the HTML as the read of the message made it (pictures embedded), then attachment_data for every part
        let parsed = crate::mail::parse(0, &raw, true, false, 0).unwrap();
        let (mut old_html, metas) = (parsed.html.unwrap(), parsed.attachments);
        let mut old_atts = vec![];
        for a in &metas {
            let (name, bytes) = crate::mail::attachment_bytes(&raw, a.index).unwrap();
            if a.inline && a.referenced {
                let data = B64.encode(&bytes);
                // (nameInlinePicture)
                let tag_start = old_html.find(&format!("base64,{data}")).map(|p| old_html[..p].rfind("<img").unwrap()).unwrap();
                old_html.insert_str(tag_start + 4, &format!(" data-name=\"{}\"", if a.name.is_empty() { &name } else { &a.name }));
            } else {
                old_atts.push(EditorAtt { filename: name, mime: a.mime.clone(), data_base64: B64.encode(&bytes) });
            }
        }
        assert_eq!(new.html.unwrap(), old_html);
        assert_eq!(new.attachments, old_atts);
        assert_eq!(new.attachments.len(), 2);
    }
}
