//! Header folding (RFC 5322 section 2.2.3): a header line is kept to 78 characters where there is a place to break it, so a message with
//! a hundred recipients has no header line of two thousand octets (a server may refuse more than 998, and many filters score it).
//! lettre folds the words it encodes (a non-ASCII subject or display name) but writes `To:` / `Cc:` lists and `References:` on one
//! line, so the finished message gets folded here, once, before it is sent or stored. Only the header block of the message itself is
//! touched, never the headers of the parts or the body, and a fold only ever replaces a space by CRLF + that space, so unfolding gives
//! back the original header.

/// Where a line should be cut when it can be.
const SOFT_LIMIT: usize = 78;

/// Headers whose values are address lists: a space inside a quoted display name is not a place to fold.
fn is_address_header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "from" | "to" | "cc" | "bcc" | "reply-to" | "sender" | "resent-from" | "resent-to" | "resent-cc" | "resent-bcc")
}

/// `line` (one physical header line, without its CRLF) cut into physical lines of at most `SOFT_LIMIT` bytes where a space allows.
fn fold_line(line: &[u8], quotes_matter: bool) -> Vec<Vec<u8>> {
    if line.len() <= SOFT_LIMIT {
        return vec![line.to_vec()];
    }
    // the places a line may be cut: a space that is not inside a quoted string, and not the one that already starts the line
    let mut safe = vec![false; line.len()];
    let (mut in_quotes, mut escaped) = (false, false);
    for (i, &c) in line.iter().enumerate() {
        if quotes_matter && in_quotes {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_quotes = false;
            }
            continue;
        }
        if quotes_matter && c == b'"' {
            in_quotes = true;
        } else if c == b' ' && i > 0 && line[i - 1] != b' ' && line[i - 1] != b':' {
            safe[i] = true;
        }
    }
    let mut out = vec![];
    let mut start = 0;
    while line.len() - start > SOFT_LIMIT {
        let window_end = start + SOFT_LIMIT; // a piece may be 78 bytes: its last byte is at window_end - 1, the cut space at window_end
        let in_window = |i: &usize| *i > start + 1 && *i <= window_end && safe[*i];
        // after a comma first (an address list breaks between addresses), else at the last space that fits
        let cut = (start..=window_end.min(line.len() - 1))
            .rev()
            .filter(in_window)
            .find(|&i| line[i - 1] == b',')
            .or_else(|| (start..=window_end.min(line.len() - 1)).rev().find(in_window))
            // nothing fits: the first place after the limit (a very long word stays whole)
            .or_else(|| (window_end + 1..line.len()).find(|&i| safe[i]));
        let Some(cut) = cut else { break };
        out.push(line[start..cut].to_vec());
        start = cut; // the space stays: it starts the next physical line as the folding white space
    }
    out.push(line[start..].to_vec());
    out
}

/// The message with the lines of its own header block folded (CRLF line ends, as `lettre::Message::formatted` writes them).
pub fn fold(raw: Vec<u8>) -> Vec<u8> {
    let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { return raw };
    let (head, rest) = raw.split_at(end);
    let mut out = Vec::with_capacity(raw.len() + 64);
    // a field is its first line and the lines that continue it (they start with a space or a tab)
    let mut name = String::new();
    for line in head.split(|&c| c == b'\n').map(|l| l.strip_suffix(b"\r").unwrap_or(l)) {
        if !matches!(line.first(), Some(b' ' | b'\t')) {
            name = String::from_utf8_lossy(line.split(|&c| c == b':').next().unwrap_or(b"")).into_owned();
        }
        // a continuation line may be folded again; the quote state of an address list does not carry over a fold, so only fold
        // continuation lines of address headers when they hold no quote at all
        let quotes_matter = is_address_header(&name);
        let carries_quote = quotes_matter && matches!(line.first(), Some(b' ' | b'\t')) && line.contains(&b'"');
        let pieces = if carries_quote { vec![line.to_vec()] } else { fold_line(line, quotes_matter) };
        for p in pieces {
            out.extend_from_slice(&p);
            out.extend_from_slice(b"\r\n");
        }
    }
    out.truncate(out.len() - 2); // the blank line comes from `rest`
    out.extend_from_slice(rest);
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
        let name = "A very long quoted display name that goes on and on and on, with a comma inside";
        let raw = format!("To: \"{name}\" <a@example.org>, \"{name}\" <b@example.org>, =?utf-8?b?4pyTIOW+heiuoeS6uuWQjQ==?= <c@example.org>\r\nSubject: =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?= =?utf-8?b?SGkgdGhlcmU=?=\r\n\r\n").into_bytes();
        let folded = fold(raw.clone());
        let text = String::from_utf8(folded.clone()).unwrap();
        // no fold inside the quotes: each name is still whole on one physical line
        assert!(text.lines().filter(|l| l.contains(&format!("\"{name}\""))).count() >= 2, "{text}");
        assert!(text.contains("=?utf-8?b?4pyTIOW+heiuoeS6uuWQjQ==?="), "an encoded word is never cut");
        assert_eq!(unfold(&text), String::from_utf8(raw).unwrap());
        // a header with one word longer than the limit stays as it is (nothing to cut at)
        let word = format!("X-Long: {}\r\n\r\n", "x".repeat(200));
        assert_eq!(fold(word.clone().into_bytes()), word.into_bytes());
    }

    #[test]
    fn non_ascii_bytes_and_folded_lines_survive() {
        let raw = "To: \"Nguyễn Văn Bé\" <b@example.org>, Đỗ Văn Ánh <a@example.org>, Another Person <person@example.org>, x@example.org\r\nSubject: =?utf-8?b?QsOhbyBjw6Fv?= Q4\r\n =?utf-8?b?4oCTIOadseS6rCDwn5qAINCf?=\r\n\r\nx".as_bytes().to_vec();
        let folded = fold(raw.clone());
        assert!(String::from_utf8(folded.clone()).is_ok(), "no multi-byte sequence is cut");
        assert_eq!(unfold(&String::from_utf8(folded).unwrap()), unfold(&String::from_utf8(raw).unwrap()));
    }
}
