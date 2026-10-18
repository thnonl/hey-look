//! Header folding (RFC 5322 section 2.2.3): a header line is kept to 78 characters where there is a place to break it, so a message with
//! a hundred recipients has no header line of two thousand octets (a server may refuse more than 998, and many filters score it).
//! lettre folds the words it encodes (a non-ASCII subject or display name) and the RFC 2231 file names, but writes `To:` / `Cc:` lists
//! and `References:` on one line, wraps a quoted display name by its own rule (a few characters over 78) and leaves a long media type
//! on one line. The finished message gets folded here, once, before it is sent or stored: the header block of the message and the header
//! block of every part (attachments, pictures, the parts inside a signed or encrypted entity). A fold only ever replaces a space by CRLF + that
//! space (or adds CRLF before it), so unfolding gives back the original header; the body of a part is never touched. A signature covers the
//! entity as it is written, so an entity is folded BEFORE it is signed or encrypted: `fold` is the same function for a whole message and for an
//! entity, and folding is idempotent, so the signed bytes are the ones the finished message carries.

/// Where a line should be cut when it can be.
const SOFT_LIMIT: usize = 78;

/// Headers whose values are address lists: a space inside a quoted display name is a last resort for a fold, never the first choice.
fn is_address_header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "from" | "to" | "cc" | "bcc" | "reply-to" | "sender" | "resent-from" | "resent-to" | "resent-cc" | "resent-bcc")
}

/// `line` (one logical header line, without its CRLF) cut into physical lines of at most `SOFT_LIMIT` bytes where a space allows.
/// Order of preference for a cut: after a comma, at another space outside a quoted string, at a space inside a quoted string (RFC 5322 3.2.4
/// allows folding white space there; unfolding gives the name back), directly after the field name (so a token longer than the limit stands
/// alone). Never inside an address or an encoded word (neither holds a space).
fn fold_line(line: &[u8], quotes_matter: bool) -> Vec<Vec<u8>> {
    if line.len() <= SOFT_LIMIT {
        return vec![line.to_vec()];
    }
    // the places a line may be cut: a space that is not inside a quoted string, and not the one that already starts the line
    let mut safe = vec![false; line.len()];
    let mut quoted = vec![false; line.len()];
    let (mut in_quotes, mut escaped) = (false, false);
    for (i, &c) in line.iter().enumerate() {
        if quotes_matter && in_quotes {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_quotes = false;
            } else if c == b' ' && i > 0 && line[i - 1] != b' ' {
                quoted[i] = true;
            }
            continue;
        }
        if quotes_matter && c == b'"' {
            in_quotes = true;
        } else if c == b' ' && i > 0 && line[i - 1] != b' ' && line[i - 1] != b':' {
            safe[i] = true;
        }
    }
    // the space right after the field name (only a line that starts a field has one)
    let after_name = (!starts_with_white_space(line))
        .then(|| line.iter().position(|&c| c == b':'))
        .flatten()
        .filter(|&p| line.get(p + 1) == Some(&b' ') && line[..p].iter().all(|c| !c.is_ascii_whitespace()))
        .map(|p| p + 1);
    let mut out = vec![];
    let mut start = 0;
    while line.len() - start > SOFT_LIMIT {
        let window_end = start + SOFT_LIMIT; // a piece may be 78 bytes: its last byte is at window_end - 1, the cut space at window_end
        let top = window_end.min(line.len() - 1);
        let usable = |i: &usize| *i > start + 1;
        let cut = (start..=top)
            .rev()
            .filter(usable)
            // after a comma first (an address list breaks between addresses), else at the last space that fits
            .find(|&i| safe[i] && line[i - 1] == b',')
            .or_else(|| (start..=top).rev().filter(usable).find(|&i| safe[i]))
            .or_else(|| (start..=top).rev().filter(usable).find(|&i| quoted[i]))
            .or_else(|| after_name.filter(|&i| start == 0 && i <= top))
            // nothing fits: the first place after the limit (a very long word stays whole)
            .or_else(|| (window_end + 1..line.len()).find(|&i| safe[i] || quoted[i]));
        let Some(cut) = cut else { break };
        out.push(line[start..cut].to_vec());
        start = cut; // the space stays: it starts the next physical line as the folding white space
    }
    out.push(line[start..].to_vec());
    out
}

fn starts_with_white_space(line: &[u8]) -> bool {
    matches!(line.first(), Some(b' ' | b'\t'))
}

/// The physical lines of one header block, folded. A field is its first line and the lines that continue it.
fn fold_block(lines: &[&[u8]]) -> Vec<Vec<u8>> {
    let mut out = vec![];
    let mut i = 0;
    while i < lines.len() {
        let mut j = i + 1;
        while j < lines.len() && starts_with_white_space(lines[j]) {
            j += 1;
        }
        let field = &lines[i..j];
        let name = String::from_utf8_lossy(field[0].split(|&c| c == b':').next().unwrap_or(b"")).into_owned();
        if is_address_header(&name) {
            // an address list is folded as a whole: the quote state of a name does not carry over a fold that was made elsewhere (lettre wraps
            // inside a quoted name), so the field is unfolded first when any of its lines is too long
            if field.iter().any(|l| l.len() > SOFT_LIMIT) {
                out.extend(fold_line(&field.concat(), true));
            } else {
                out.extend(field.iter().map(|l| l.to_vec()));
            }
        } else {
            for l in field {
                out.extend(fold_line(l, false));
            }
        }
        i = j;
    }
    out
}

/// `boundary` of a `Content-Type: multipart/...` field of the block, if it has one.
fn boundary_of(lines: &[&[u8]]) -> Option<Vec<u8>> {
    let mut fields: Vec<Vec<u8>> = vec![];
    for l in lines {
        match fields.last_mut() {
            Some(last) if starts_with_white_space(l) => last.extend_from_slice(l),
            _ => fields.push(l.to_vec()),
        }
    }
    let field = fields.iter().find(|f| f.len() > 13 && f[..13].eq_ignore_ascii_case(b"content-type:"))?;
    let text = String::from_utf8_lossy(&field[13..]).into_owned();
    if !text.trim_start().to_ascii_lowercase().starts_with("multipart/") {
        return None;
    }
    let at = text.to_ascii_lowercase().find("boundary=")? + "boundary=".len();
    let rest = text[at..].trim_start();
    let value = match rest.strip_prefix('"') {
        Some(q) => q.split('"').next().unwrap_or("").to_string(),
        None => rest.split([';', ' ', '\t']).next().unwrap_or("").to_string(),
    };
    Some(value.into_bytes()).filter(|b| !b.is_empty())
}

/// The message (or one entity: a header block, a blank line and a body) with the lines of its header block and of the header block of every
/// part folded (CRLF line ends, as `lettre::Message::formatted` writes them). Bodies are copied as they are: a part is only recognised by the
/// boundary its parent announced, so a body line that starts with `--` (a signature delimiter) is never taken for a header.
pub fn fold(raw: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 256);
    let mut boundaries: Vec<Vec<u8>> = vec![]; // the open multiparts, outermost first
    let mut block: Vec<&[u8]> = vec![]; // the header lines being read
    let mut in_head = true;
    let mut pos = 0;
    let mut last_crlf = true;
    while pos < raw.len() {
        let (end, next, crlf) = match raw[pos..].windows(2).position(|w| w == b"\r\n") {
            Some(k) => (pos + k, pos + k + 2, true),
            None => (raw.len(), raw.len(), false),
        };
        let line = &raw[pos..end];
        last_crlf = crlf;
        pos = next;
        if in_head {
            if line.is_empty() && crlf {
                for l in fold_block(&block) {
                    out.extend_from_slice(&l);
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(b"\r\n");
                if let Some(b) = boundary_of(&block) {
                    boundaries.push(b);
                }
                block.clear();
                in_head = false;
            } else {
                block.push(line);
            }
            continue;
        }
        // a body line: it is a boundary line only when it is the delimiter of a multipart that is open
        if line.starts_with(b"--") {
            let text = line.trim_ascii_end();
            let marker = boundaries.iter().enumerate().rev().find_map(|(k, b)| {
                let body = &text[2..];
                if body == &b[..] {
                    Some((k, false))
                } else if body.len() == b.len() + 2 && body.starts_with(b) && body.ends_with(b"--") {
                    Some((k, true))
                } else {
                    None
                }
            });
            match marker {
                Some((k, false)) => {
                    boundaries.truncate(k + 1);
                    in_head = true;
                }
                Some((k, true)) => boundaries.truncate(k),
                None => {}
            }
        }
        out.extend_from_slice(line);
        if crlf {
            out.extend_from_slice(b"\r\n");
        }
    }
    if !block.is_empty() {
        // the data ended inside a header block: fold what is there, with the line end it had
        let lines = fold_block(&block);
        let n = lines.len();
        for (i, l) in lines.into_iter().enumerate() {
            out.extend_from_slice(&l);
            if i + 1 < n || last_crlf {
                out.extend_from_slice(b"\r\n");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unfold(s: &str) -> String {
        s.replace("\r\n ", " ").replace("\r\n\t", "\t")
    }

    fn header_lines(raw: &[u8]) -> Vec<String> {
        let text = String::from_utf8_lossy(raw).into_owned();
        text.split("\r\n\r\n").next().unwrap().split("\r\n").map(String::from).collect()
    }

    #[test]
    fn a_hundred_recipients_are_folded_between_addresses() {
        let to: Vec<String> = (0..100).map(|i| format!("r13-{i:03}@example.test")).collect();
        let raw = format!("From: me@example.com\r\nTo: {}\r\nSubject: s\r\n\r\nbody", to.join(", ")).into_bytes();
        let folded = fold(raw.clone());
        for l in header_lines(&folded) {
            assert!(l.len() <= SOFT_LIMIT, "{} bytes: {l}", l.len());
        }
        // unfolding gives back the same header, nothing lost or reordered, the body untouched
        assert_eq!(unfold(&String::from_utf8(folded.clone()).unwrap()), String::from_utf8(raw).unwrap());
        // every continuation line starts with a space and every line but the first of a field ends after a comma
        let lines = header_lines(&folded);
        assert!(lines[1].starts_with("To: r13-000@example.test,") && lines[1].ends_with(','), "{}", lines[1]);
        assert!(lines[2].starts_with(" r13-"), "{}", lines[2]);
        assert!(folded.ends_with(b"\r\n\r\nbody"));
    }

    #[test]
    fn references_fold_at_spaces_and_short_headers_stay_as_they_are() {
        let refs: Vec<String> = (0..12).map(|i| format!("<message-number-{i:02}@mail.example.org>")).collect();
        let raw = format!("Subject: short\r\nReferences: {}\r\nMessage-ID: <a@b.c>\r\n\r\n", refs.join(" ")).into_bytes();
        let folded = fold(raw.clone());
        let lines = header_lines(&folded);
        assert!(lines.iter().all(|l| l.len() <= SOFT_LIMIT), "{lines:?}");
        assert_eq!(lines[0], "Subject: short");
        assert_eq!(*lines.last().unwrap(), "Message-ID: <a@b.c>");
        assert_eq!(unfold(&String::from_utf8(folded).unwrap()), String::from_utf8(raw).unwrap());
        // a message whose headers are short is returned byte for byte
        let small = b"From: a@b.c\r\nTo: d@e.f\r\nSubject: hi\r\n\r\nbody\r\n".to_vec();
        assert_eq!(fold(small.clone()), small);
    }

    #[test]
    fn a_quoted_name_is_not_cut_and_encoded_words_stay_whole() {
        let name = "A quoted display name that goes on and on, with a comma";
        let raw = format!("To: \"{name}\" <a@example.org>, \"{name}\" <b@example.org>, =?utf-8?b?4pyTIOW+heiuoeS6uuWQjQ==?= <c@example.org>\r\nSubject: =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?=\r\n\r\n").into_bytes();
        let folded = fold(raw.clone());
        let text = String::from_utf8(folded.clone()).unwrap();
        // no fold inside the quotes: each name is still whole on one physical line
        assert!(text.lines().filter(|l| l.contains(&format!("\"{name}\""))).count() >= 2, "{text}");
        assert!(text.contains("=?utf-8?b?4pyTIOW+heiuoeS6uuWQjQ==?="), "an encoded word is never cut");
        assert_eq!(unfold(&text), String::from_utf8(raw).unwrap());
        // a header with one word longer than the limit: the word stands alone on the line after the field name (nothing to cut inside it)
        let word = format!("X-Long: {}\r\n\r\n", "x".repeat(200));
        assert_eq!(fold(word.clone().into_bytes()), format!("X-Long:\r\n {}\r\n\r\n", "x".repeat(200)).into_bytes());
        assert_eq!(unfold(&String::from_utf8(fold(word.clone().into_bytes())).unwrap()), word);
    }

    /// W2.8: a quoted name with no space outside its quotes that fits is cut at a space inside the quotes; the name is the same after unfolding.
    #[test]
    fn a_long_quoted_name_is_cut_inside_its_quotes_as_a_last_resort() {
        let name = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec";
        let raw = format!("To: first@example.test, \"{name}\" <second@example.test>\r\nSubject: s\r\n\r\nbody").into_bytes();
        let folded = fold(raw.clone());
        let text = String::from_utf8(folded.clone()).unwrap();
        for l in header_lines(&folded) {
            assert!(l.len() <= SOFT_LIMIT, "{} bytes: {l}", l.len());
        }
        assert_eq!(unfold(&text), String::from_utf8(raw).unwrap(), "unfolding gives back the header");
        // lettre's own wrapping inside a quoted name (a physical line of 79) is refolded as a whole
        let wrapped = format!("To: \"{}\r\n {}\" <a@example.test>, \"b b\" <b@example.test>\r\n\r\n", &name[..62], &name[62..]).into_bytes();
        let refolded = fold(wrapped.clone());
        assert!(header_lines(&refolded).iter().all(|l| l.len() <= SOFT_LIMIT), "{:?}", header_lines(&refolded));
        assert_eq!(unfold(&String::from_utf8(refolded).unwrap()), unfold(&String::from_utf8(wrapped).unwrap()));
    }

    /// W2.8: an address longer than the limit stands alone on its line, and so does a media type that does not fit after its field name.
    #[test]
    fn an_unbreakable_token_stands_alone_on_its_line() {
        let addr = format!("<{}@{}.example.test>", "x".repeat(40), "h".repeat(34));
        let raw = format!("To: {addr}, b@example.test\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n").into_bytes();
        let folded = fold(raw.clone());
        let lines = header_lines(&folded);
        assert_eq!(lines[0], "To:");
        assert_eq!(lines[1], format!(" {addr},"));
        assert_eq!(lines[2], " b@example.test");
        assert_eq!(lines[3], "Content-Type:");
        assert!(lines[4].starts_with(" application/vnd.openxml"));
        assert_eq!(unfold(&String::from_utf8(folded).unwrap()), String::from_utf8(raw).unwrap());
    }

    /// W2.9: the header block of every part is folded, a body is never touched (not even a line that starts with `--`), folding twice changes nothing.
    #[test]
    fn part_headers_are_folded_and_bodies_are_left_alone() {
        let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        let long_body_line = format!("-- {}", "word ".repeat(40));
        let trap = format!("Content-Type: {docx} looks like a header but is a body line {docx}");
        let raw = format!(
            "From: a@example.test\r\nContent-Type: multipart/mixed;\r\n boundary=\"outer\"\r\n\r\npreamble\r\n--outer\r\nContent-Type: multipart/alternative;\r\n boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{long_body_line}\r\n{trap}\r\n--inner--\r\n--outer\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Type: {docx}\r\n\r\nQUJD\r\n--outer--\r\nepilogue {docx} {docx}\r\n",
            "n".repeat(70)
        )
        .into_bytes();
        let folded = fold(raw.clone());
        let text = String::from_utf8(folded.clone()).unwrap();
        // the long part headers are folded: the media type alone after its field name; the file name line (a quoted value) is 86 bytes with no space to cut at
        assert!(text.contains(&format!("Content-Type:\r\n {docx}\r\n\r\nQUJD")), "{text}");
        // the bodies, the preamble and the epilogue are byte for byte what they were
        for kept in [format!("\r\n\r\n{long_body_line}\r\n{trap}\r\n--inner--\r\n"), "\r\n\r\npreamble\r\n--outer\r\n".to_string(), format!("--outer--\r\nepilogue {docx} {docx}\r\n")] {
            assert!(text.contains(&kept), "{kept}");
        }
        assert_eq!(unfold(&text), unfold(&String::from_utf8(raw).unwrap()));
        // idempotent: what is folded is not folded again
        assert_eq!(fold(folded.clone()), folded);
    }

    #[test]
    fn non_ascii_bytes_and_folded_lines_survive() {
        let raw = "To: \"Nguyễn Văn Bé\" <b@example.org>, Đỗ Văn Ánh <a@example.org>, Another Person <person@example.org>, x@example.org\r\nSubject: =?utf-8?b?QsOhbyBjw6Fv?= Q4\r\n =?utf-8?b?4oCTIOadseS6rCDwn5qAINCf?=\r\n\r\nx".as_bytes().to_vec();
        let folded = fold(raw.clone());
        assert!(String::from_utf8(folded.clone()).is_ok(), "no multi-byte sequence is cut");
        assert_eq!(unfold(&String::from_utf8(folded).unwrap()), unfold(&String::from_utf8(raw).unwrap()));
    }
}
