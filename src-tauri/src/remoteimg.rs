//! Which picture type a downloaded remote picture is (`fetch_remote_images` in lib.rs).
//!
//! Many mail senders keep their pictures on storage that does not name the type: Amazon S3 behind
//! CloudFront answers `binary/octet-stream` (Grab newsletters), others `application/octet-stream` or
//! no Content-Type at all. Browsers show such pictures because they look at the first bytes, so we do
//! the same: when the server does not say `image/...`, the bytes decide. Only raster formats a webview
//! shows from a `data:` URI are taken; anything else (HTML, JSON, an error page) is still refused.

use std::collections::HashSet;
use std::sync::Mutex;

/// The picture type of the first bytes, or None when they are not a picture we show.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let b = bytes;
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if b.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else if b.starts_with(b"BM") && b.len() >= 14 {
        Some("image/bmp")
    } else if b.starts_with(b"\x00\x00\x01\x00") {
        Some("image/x-icon")
    } else if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        Some("image/avif")
    } else {
        None
    }
}

/// The type the `data:` URI gets. A server that says `image/...` is believed, as before. A server that
/// says something else (octet-stream, text/plain, nothing) is believed only when the bytes are a picture.
pub fn picture_type(header: Option<&str>, bytes: &[u8]) -> Option<String> {
    let ct = header.and_then(|h| h.split(';').next()).map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
    if ct.starts_with("image/") {
        return Some(ct);
    }
    sniff(bytes).map(str::to_string)
}

/// One `startup.log` line per distinct reason a picture was not taken (host and reason, never the
/// full address), so a broken sender is visible without a line per picture or per retry.
pub fn log_refused(url: &str, why: &str) {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let host = url.split("://").nth(1).and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("").to_string();
    let key = format!("{host}: {why}");
    let mut g = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if set.len() < 200 && set.insert(key.clone()) {
        crate::startup::line("remote-image", &format!("not shown {key}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn octet_stream_png_is_a_picture() {
        // the Grab newsletter case: CloudFront answers binary/octet-stream for a PNG
        assert_eq!(picture_type(Some("binary/octet-stream"), PNG).as_deref(), Some("image/png"));
        assert_eq!(picture_type(Some("application/octet-stream"), b"\xff\xd8\xff\xe0JFIF").as_deref(), Some("image/jpeg"));
        assert_eq!(picture_type(None, b"GIF89a\x01\x00").as_deref(), Some("image/gif"));
        assert_eq!(picture_type(Some(""), b"RIFF\0\0\0\0WEBPVP8 ").as_deref(), Some("image/webp"));
    }

    #[test]
    fn image_header_is_believed() {
        assert_eq!(picture_type(Some("image/svg+xml; charset=utf-8"), b"<svg/>").as_deref(), Some("image/svg+xml"));
        assert_eq!(picture_type(Some("IMAGE/PNG"), PNG).as_deref(), Some("image/png"));
    }

    /// A local server that answers every path with `body` and this Content-Type (None = no header).
    fn serve(ctype: Option<&'static str>, body: &'static [u8]) -> String {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut s = s;
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let ct = ctype.map(|c| format!("Content-Type: {c}\r\n")).unwrap_or_default();
                let _ = s.write_all(format!("HTTP/1.1 200 OK\r\n{ct}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                let _ = s.write_all(body);
            }
        });
        format!("http://127.0.0.1:{port}/push/metric1.png")
    }

    #[test]
    fn fetch_takes_octet_stream_pictures_and_refuses_pages() {
        // the owner's mail: d1rr9ofe14xxx2.cloudfront.net answers its PNG icons as binary/octet-stream
        let grab = serve(Some("binary/octet-stream"), PNG);
        let bare = serve(None, b"\xff\xd8\xff\xe0JFIF");
        let page = serve(Some("text/html"), b"<html>blocked</html>");
        let out = tauri::async_runtime::block_on(crate::fetch_remote_images(vec![grab.clone(), bare.clone(), page.clone()])).unwrap();
        assert!(out[&grab].starts_with("data:image/png;base64,"), "{:?}", out.get(&grab));
        assert!(out[&bare].starts_with("data:image/jpeg;base64,"));
        assert!(!out.contains_key(&page));
    }

    #[test]
    fn non_pictures_are_refused() {
        assert_eq!(picture_type(Some("text/html"), b"<!doctype html><html>"), None);
        assert_eq!(picture_type(Some("binary/octet-stream"), b"<svg onload=alert(1)>"), None);
        assert_eq!(picture_type(Some("application/json"), b"{\"error\":1}"), None);
        assert_eq!(picture_type(None, b""), None);
        assert_eq!(picture_type(None, b"BM"), None);
    }
}
