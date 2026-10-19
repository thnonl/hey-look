//! The `text/html` flavour of the clipboard as GTK hands it over (Linux): bytes that are UTF-8, or UTF-16 with or without a byte order mark (Chromium and
//! Firefox put UTF-16 on the X11 clipboard). The editors paste "as plain text" from it when the clipboard has no plain text part (`read_clipboard_text`, W2.23).
//! Pure, so the decoding is tested on every system (the GTK read itself is Linux only).

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// The HTML text of the clipboard bytes: a byte order mark decides; without one, a NUL next to an ASCII byte at the start says UTF-16 (the first character of HTML is `<`);
/// else UTF-8. Invalid sequences become U+FFFD; trailing NULs (a padded buffer) are cut.
pub fn html_from_clipboard_bytes(bytes: &[u8]) -> String {
    let utf16 = |b: &[u8], big: bool| -> String {
        let units: Vec<u16> = b.chunks_exact(2).map(|p| if big { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) }).collect();
        String::from_utf16_lossy(&units)
    };
    let text = match bytes {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, false),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, true),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        [a, 0, ..] if *a != 0 => utf16(bytes, false),
        [0, b, ..] if *b != 0 => utf16(bytes, true),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    };
    text.trim_end_matches('\0').to_string()
}

#[cfg(test)]
mod tests {
    use super::html_from_clipboard_bytes as dec;

    fn le(s: &str, bom: bool) -> Vec<u8> {
        let mut v = if bom { vec![0xFF, 0xFE] } else { vec![] };
        v.extend(s.encode_utf16().flat_map(|u| u.to_le_bytes()));
        v
    }
    fn be(s: &str, bom: bool) -> Vec<u8> {
        let mut v = if bom { vec![0xFE, 0xFF] } else { vec![] };
        v.extend(s.encode_utf16().flat_map(|u| u.to_be_bytes()));
        v
    }

    #[test]
    fn the_html_flavour_is_decoded_from_utf8_and_utf16() {
        let html = "<ol><li>một</li><li>日本語 \u{1F600}</li></ol>";
        assert_eq!(dec(html.as_bytes()), html, "UTF-8");
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend(html.as_bytes());
        assert_eq!(dec(&bom), html, "UTF-8 with a byte order mark");
        assert_eq!(dec(&le(html, true)), html, "UTF-16 little endian with a mark");
        assert_eq!(dec(&be(html, true)), html, "UTF-16 big endian with a mark");
        assert_eq!(dec(&le(html, false)), html, "UTF-16 little endian without a mark");
        assert_eq!(dec(&be(html, false)), html, "UTF-16 big endian without a mark");
        assert_eq!(dec(b"<p>x</p>\0\0\0"), "<p>x</p>", "a padded buffer");
        assert_eq!(dec(b""), "");
        assert_eq!(dec(&[0xFF, 0xFE]), "", "a mark and nothing else");
        assert_eq!(dec(&[b'<', b'p', b'>', 0xFF, b'<', b'/', b'p', b'>']), "<p>\u{FFFD}</p>", "an invalid byte is replaced, the rest is kept");
        assert_eq!(dec(&le("<p>x", false)[..5]), "<p", "an odd trailing byte of UTF-16 is dropped, not a panic");
    }
}
