//! The smallest HTTP/1.1 the test bridge needs: parse one request, guard it, write one response, close. Pure functions over bytes, so
//! every guard has a unit test. No CORS headers are ever written: a web page cannot read an answer, and a preflight finds no permission.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// Largest request body (1 MB).
pub const MAX_BODY: usize = 1024 * 1024;
/// Largest head (request line and headers).
pub const MAX_HEAD: usize = 16 * 1024;
/// How long one request may take to arrive completely.
pub const READ_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq)]
pub struct HttpError {
    pub status: u16,
    pub message: &'static str,
}

fn err<T>(status: u16, message: &'static str) -> Result<T, HttpError> {
    Err(HttpError { status, message })
}

#[derive(Debug, PartialEq)]
pub struct Head {
    pub method: String,
    /// the path without the query
    pub path: String,
    pub query: Vec<(String, String)>,
    /// (lower-case name, value); every header is kept, duplicates included
    pub headers: Vec<(String, String)>,
    pub content_length: usize,
}

impl Head {
    /// The value of a header that must not be repeated; None = absent, Err = sent twice.
    fn single(&self, name: &str) -> Result<Option<&str>, HttpError> {
        let mut found = None;
        for (k, v) in &self.headers {
            if k == name {
                if found.is_some() {
                    return err(400, "a header is repeated");
                }
                found = Some(v.as_str());
            }
        }
        Ok(found)
    }

    #[cfg(test)]
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses the head (everything before the empty line, without it).
pub fn parse_head(raw: &[u8]) -> Result<Head, HttpError> {
    let text = std::str::from_utf8(raw).or_else(|_| err(400, "the head is not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) if !m.is_empty() && !t.is_empty() => (m, t, v),
        _ => return err(400, "bad request line"),
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return err(400, "only HTTP/1.x");
    }
    if !target.starts_with('/') || target.starts_with("//") {
        return err(400, "the target must be a path");
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let query = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(p), String::new()),
        })
        .collect();
    let mut headers = Vec::new();
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { return err(400, "bad header") };
        if k.is_empty() || k.bytes().any(|c| c <= b' ' || c == 0x7f) {
            return err(400, "bad header name");
        }
        headers.push((k.to_ascii_lowercase(), v.trim().to_string()));
    }
    let mut head = Head { method: method.to_string(), path: percent_decode(path), query, headers, content_length: 0 };
    if head.single("transfer-encoding")?.is_some() {
        return err(501, "chunked bodies are not supported, send a Content-Length");
    }
    if let Some(cl) = head.single("content-length")? {
        if cl.is_empty() || cl.len() > 9 || !cl.bytes().all(|b| b.is_ascii_digit()) {
            return err(400, "bad Content-Length");
        }
        head.content_length = cl.parse().unwrap_or(usize::MAX);
        if head.content_length > MAX_BODY {
            return err(413, "the body is larger than 1 MB");
        }
    }
    Ok(head)
}

/// Constant-time comparison (the length of the secret is not a secret, its content is).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u32;
    for i in 0..a.len().max(b.len()) {
        diff |= (*a.get(i).unwrap_or(&0) ^ *b.get(i).unwrap_or(&0)) as u32;
    }
    diff == 0
}

/// Whether the Host header names this server: `127.0.0.1:<port>` or `localhost:<port>`. A page of another site reaches the port with
/// its own host name (DNS rebinding) and fails here.
pub fn host_ok(host: &str, port: u16) -> bool {
    host.eq_ignore_ascii_case(&format!("127.0.0.1:{port}")) || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

/// The guards of every request, in this order: Host (403), Origin (403), token (401). `token` is the secret of this run.
pub fn authorize(head: &Head, port: u16, token: &str) -> Result<(), HttpError> {
    match head.single("host")? {
        Some(h) if host_ok(h, port) => {}
        _ => return err(403, "the Host header must be 127.0.0.1:<port> or localhost:<port>"),
    }
    // a browser page always sends its origin on a cross-site request; the bridge's clients (curl, node, python) send none
    match head.single("origin")? {
        None => {}
        Some(o) if o == "null" => {}
        Some(_) => return err(403, "requests from web pages are refused"),
    }
    let mut given: Option<String> = None;
    if let Some(a) = head.single("authorization")? {
        if let Some(t) = a.strip_prefix("Bearer ") {
            given = Some(t.trim().to_string());
        }
    }
    if given.is_none() {
        given = head.single("x-bridge-token")?.map(|t| t.to_string());
    }
    match given {
        Some(t) if ct_eq(t.as_bytes(), token.as_bytes()) => Ok(()),
        _ => err(401, "missing or wrong token"),
    }
}

/// Reads one request: the head (guards are the caller's job) and then the body. Gives up after [`READ_DEADLINE`].
pub fn read_head<R: Read>(r: &mut R) -> Result<(Head, Vec<u8>), HttpError> {
    let start = Instant::now();
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        if buf.len() > MAX_HEAD {
            return err(431, "the head is too large");
        }
        if start.elapsed() > READ_DEADLINE {
            return err(408, "the request took too long");
        }
        match r.read(&mut chunk) {
            Ok(0) => return err(400, "the connection closed inside the head"),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return err(408, "the request took too long"),
            Err(_) => return err(400, "could not read the request"),
        }
    };
    let head = parse_head(&buf[..end])?;
    Ok((head, buf[end + 4..].to_vec()))
}

/// Reads the rest of the body (`already` came with the head).
pub fn read_body<R: Read>(r: &mut R, head: &Head, mut already: Vec<u8>) -> Result<Vec<u8>, HttpError> {
    let start = Instant::now();
    if already.len() > head.content_length {
        already.truncate(head.content_length);
    }
    let mut chunk = [0u8; 8192];
    while already.len() < head.content_length {
        if start.elapsed() > READ_DEADLINE {
            return err(408, "the body took too long");
        }
        let want = (head.content_length - already.len()).min(chunk.len());
        match r.read(&mut chunk[..want]) {
            Ok(0) => return err(400, "the connection closed inside the body"),
            Ok(n) => already.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return err(408, "the body took too long"),
            Err(_) => return err(400, "could not read the body"),
        }
    }
    Ok(already)
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, v: &serde_json::Value) -> Response {
        Response { status, content_type: "application/json", body: v.to_string().into_bytes() }
    }
    pub fn error(status: u16, message: &str) -> Response {
        Response::json(status, &serde_json::json!({ "ok": false, "error": message }))
    }
    pub fn png(body: Vec<u8>) -> Response {
        Response { status: 200, content_type: "image/png", body }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// The bytes of a response. There is deliberately no `Access-Control-*` header.
pub fn response_bytes(r: &Response) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        r.status,
        reason(r.status),
        r.content_type,
        r.body.len()
    )
    .into_bytes();
    out.extend_from_slice(&r.body);
    out
}

pub fn write_response<W: Write>(w: &mut W, r: &Response) {
    let _ = w.write_all(&response_bytes(r));
    let _ = w.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> Result<Head, HttpError> {
        parse_head(raw.as_bytes())
    }

    #[test]
    fn parses_a_request() {
        let h = head("POST /eval?window=main&x=a%20b HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Length: 12\r\nX-Bridge-Token: t").unwrap();
        assert_eq!((h.method.as_str(), h.path.as_str(), h.content_length), ("POST", "/eval", 12));
        assert_eq!(h.query_param("window"), Some("main"));
        assert_eq!(h.query_param("x"), Some("a b"));
        assert_eq!(h.query_param("nope"), None);
    }

    #[test]
    fn rejects_malformed_heads() {
        for bad in ["", "GET", "GET / ", "GET / HTTP/2", "GET  / HTTP/1.1", "GET http://x/ HTTP/1.1", "GET //x HTTP/1.1", "GET / HTTP/1.1\r\nno colon", "GET / HTTP/1.1\r\n: v", "GET / HTTP/1.1\r\nbad name: v"] {
            assert_eq!(head(bad).unwrap_err().status, 400, "{bad:?}");
        }
        assert_eq!(parse_head(b"GET / HTTP/1.1\r\nHost: \xff\xfe").unwrap_err().status, 400);
    }

    #[test]
    fn body_limits_and_encodings() {
        assert_eq!(head(&format!("POST / HTTP/1.1\r\nContent-Length: {}", MAX_BODY + 1)).unwrap_err().status, 413);
        assert!(head(&format!("POST / HTTP/1.1\r\nContent-Length: {MAX_BODY}")).is_ok());
        assert_eq!(head("POST / HTTP/1.1\r\nContent-Length: -1").unwrap_err().status, 400);
        assert_eq!(head("POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1").unwrap_err().status, 400);
        assert_eq!(head("POST / HTTP/1.1\r\nContent-Length: 99999999999999999999").unwrap_err().status, 400);
        assert_eq!(head("POST / HTTP/1.1\r\nTransfer-Encoding: chunked").unwrap_err().status, 501);
    }

    #[test]
    fn constant_time_compare() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn req(extra: &str) -> Head {
        head(&format!("GET /windows HTTP/1.1{extra}")).unwrap()
    }

    #[test]
    fn host_guard_stops_dns_rebinding() {
        let ok = format!("\r\nHost: 127.0.0.1:4000\r\nAuthorization: Bearer {TOKEN}");
        assert_eq!(authorize(&req(&ok), 4000, TOKEN), Ok(()));
        assert_eq!(authorize(&req(&format!("\r\nHost: localhost:4000\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN), Ok(()));
        assert_eq!(authorize(&req(&format!("\r\nHost: LocalHost:4000\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN), Ok(()));
        for host in ["127.0.0.1:4001", "127.0.0.1", "evil.example:4000", "127.0.0.1.evil.example:4000", "[::1]:4000", "0.0.0.0:4000", "localhost.evil.example:4000", ""] {
            let r = authorize(&req(&format!("\r\nHost: {host}\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN);
            assert_eq!(r.unwrap_err().status, 403, "Host {host:?}");
        }
        // no Host header at all
        assert_eq!(authorize(&req(&format!("\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN).unwrap_err().status, 403);
        // two Host headers
        assert_eq!(authorize(&req(&format!("\r\nHost: 127.0.0.1:4000\r\nHost: evil:4000\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN).unwrap_err().status, 400);
    }

    #[test]
    fn origin_guard_refuses_web_pages() {
        let base = |o: &str| req(&format!("\r\nHost: 127.0.0.1:4000\r\nX-Bridge-Token: {TOKEN}{o}"));
        assert_eq!(authorize(&base(""), 4000, TOKEN), Ok(()));
        assert_eq!(authorize(&base("\r\nOrigin: null"), 4000, TOKEN), Ok(()));
        for o in ["https://evil.example", "http://127.0.0.1:4000", "http://localhost:4000", "", "NULL", "tauri://localhost"] {
            assert_eq!(authorize(&base(&format!("\r\nOrigin: {o}")), 4000, TOKEN).unwrap_err().status, 403, "Origin {o:?}");
        }
    }

    #[test]
    fn token_guard() {
        let with = |h: &str| req(&format!("\r\nHost: 127.0.0.1:4000{h}"));
        assert_eq!(authorize(&with(&format!("\r\nAuthorization: Bearer {TOKEN}")), 4000, TOKEN), Ok(()));
        assert_eq!(authorize(&with(&format!("\r\nX-Bridge-Token: {TOKEN}")), 4000, TOKEN), Ok(()));
        let wrong = TOKEN.replace('0', "1");
        for h in [
            String::new(),
            format!("\r\nAuthorization: Bearer {wrong}"),
            format!("\r\nX-Bridge-Token: {wrong}"),
            format!("\r\nAuthorization: Basic {TOKEN}"),
            format!("\r\nAuthorization: {TOKEN}"),
            "\r\nAuthorization: Bearer ".to_string(),
            format!("\r\nX-Bridge-Token: {}", &TOKEN[..63]),
            format!("\r\nX-Bridge-Token: {TOKEN}0"),
            "\r\nX-Bridge-Token: ".to_string(),
        ] {
            assert_eq!(authorize(&with(&h), 4000, TOKEN).unwrap_err().status, 401, "{h:?}");
        }
        // the order: a wrong Host is refused before the token is looked at
        assert_eq!(authorize(&req("\r\nHost: evil:1"), 4000, TOKEN).unwrap_err().status, 403);
    }

    #[test]
    fn reads_a_request_from_a_stream() {
        let raw = b"POST /eval HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello".to_vec();
        let mut r = std::io::Cursor::new(raw);
        let (h, rest) = read_head(&mut r).unwrap();
        assert_eq!(read_body(&mut r, &h, rest).unwrap(), b"hello");
        // a head that never ends
        let mut r = std::io::Cursor::new(vec![b'a'; MAX_HEAD + 5000]);
        assert_eq!(read_head(&mut r).unwrap_err().status, 431);
        // closed inside the body
        let mut r = std::io::Cursor::new(b"POST / HTTP/1.1\r\nContent-Length: 9\r\n\r\nabc".to_vec());
        let (h, rest) = read_head(&mut r).unwrap();
        assert_eq!(read_body(&mut r, &h, rest).unwrap_err().status, 400);
    }

    #[test]
    fn responses_carry_no_cors_headers() {
        let bytes = String::from_utf8(response_bytes(&Response::error(401, "no"))).unwrap();
        assert!(bytes.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(bytes.contains("Content-Length: ") && bytes.contains("Connection: close"));
        assert!(!bytes.to_ascii_lowercase().contains("access-control"), "{bytes}");
    }
}
