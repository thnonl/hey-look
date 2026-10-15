//! A tiny HTTP server for the contract tests of the providers: it listens on `127.0.0.1:0`, records every request and answers with
//! what the test's handler returns. No crate beyond std; the connection is closed after every answer.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    /// path with the query string, as sent
    pub target: String,
    /// lower-case header names
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Req {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    /// One query parameter, decoded.
    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        q.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == key).then(|| urlencoding::decode(&v.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_default())
        })
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Resp {
    pub fn json(status: u16, v: serde_json::Value) -> Resp {
        Resp { status, headers: vec![("Content-Type".into(), "application/json".into())], body: v.to_string() }
    }

    pub fn empty(status: u16) -> Resp {
        Resp { status, headers: vec![], body: String::new() }
    }

    pub fn with(mut self, name: &str, value: &str) -> Resp {
        self.headers.push((name.into(), value.into()));
        self
    }
}

pub struct FakeServer {
    pub base: String,
    log: Arc<Mutex<Vec<Req>>>,
}

impl FakeServer {
    /// Start a server whose answers come from `handler` (called once per request, in order of arrival).
    pub fn start(handler: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(vec![]));
        let (l2, handler) = (log.clone(), Arc::new(handler));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let (l3, h) = (l2.clone(), handler.clone());
                std::thread::spawn(move || {
                    let Some(req) = read_request(&mut s) else { return };
                    l3.lock().unwrap().push(req.clone());
                    let r = h(&req);
                    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", r.status, r.body.len());
                    for (k, v) in &r.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    out.push_str(&r.body);
                    let _ = s.write_all(out.as_bytes());
                    let _ = s.flush();
                });
            }
        });
        FakeServer { base, log }
    }

    pub fn requests(&self) -> Vec<Req> {
        self.log.lock().unwrap().clone()
    }

    pub fn count(&self) -> usize {
        self.log.lock().unwrap().len()
    }
}

fn read_request(s: &mut std::net::TcpStream) -> Option<Req> {
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf: Vec<u8> = vec![];
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + want {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
    Some(Req { method, target, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_records_and_answers() {
        let srv = FakeServer::start(|r| if r.path() == "/a" { Resp::json(200, serde_json::json!({"q": r.query("x")})) } else { Resp::empty(404).with("Retry-After", "5") });
        let c = reqwest::blocking::Client::new();
        let r = c.get(format!("{}/a?x=1%2B2", srv.base)).header("If-Match", "\"e\"").send().unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<serde_json::Value>().unwrap()["q"], "1+2");
        let r = c.post(format!("{}/b", srv.base)).body("hello").send().unwrap();
        assert_eq!((r.status().as_u16(), r.headers()["retry-after"].to_str().unwrap()), (404, "5"));
        let got = srv.requests();
        assert_eq!((got.len(), got[0].headers["if-match"].as_str(), got[1].body.as_str(), got[1].method.as_str()), (2, "\"e\"", "hello", "POST"));
    }
}
