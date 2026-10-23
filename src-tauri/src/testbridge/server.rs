//! The server and the routes. The web views are behind the [`Driver`] trait, so everything here is tested with a fake one.

use super::http::{self, Head, Response};
use super::js;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Connections served at the same time; more are told to come back.
const MAX_CONNECTIONS: usize = 16;
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a request waits for the window to finish the one before it.
const BUSY_WAIT: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WindowInfo {
    pub label: String,
    pub title: String,
    pub visible: bool,
    pub focused: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// the same frame in logical (CSS-like) pixels: physical / scale (a 960 x 560 window on a Retina Mac is 1920 x 1120 physical)
    #[serde(rename = "logicalX")]
    pub logical_x: f64,
    #[serde(rename = "logicalY")]
    pub logical_y: f64,
    #[serde(rename = "logicalWidth")]
    pub logical_width: f64,
    #[serde(rename = "logicalHeight")]
    pub logical_height: f64,
    pub scale: f64,
    /// `main`, `compose`, `reader` or `other`
    pub kind: String,
}

#[derive(Debug, PartialEq)]
pub enum ExecError {
    NoWindow,
    Failed(String),
    Timeout,
}

#[derive(Debug, PartialEq)]
pub enum SnapshotError {
    NoWindow,
    /// the platform cannot do it (answered 501 with the reason); only Linux and the fake of the tests say so
    #[allow(dead_code)]
    Unsupported(String),
    Failed(String),
}

/// What the bridge needs from the app. The real one is in `native.rs`.
pub trait Driver: Send + Sync + 'static {
    fn windows(&self) -> Vec<WindowInfo>;
    /// Runs `script` (which returns a string) in the page of the window and gives that string back.
    fn exec(&self, label: &str, script: &str, timeout: Duration) -> Result<String, ExecError>;
    /// The web content of the window as a PNG.
    fn snapshot(&self, label: &str, timeout: Duration) -> Result<Vec<u8>, SnapshotError>;
    /// The app process itself (W4.1, REQ-4.1.5): `{ pid, rssBytes, footprintBytes, privateBytes, nsapp: { total, visible, titled } | null, webviewWindows }`; what a system cannot say is null.
    fn native(&self) -> Value;
}

enum RunError {
    NoWindow,
    Busy,
    Timeout(u64),
    Failed(String),
}

pub struct Bridge<D: Driver> {
    driver: Arc<D>,
    port: u16,
    token: String,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    next_id: AtomicU64,
    active: AtomicUsize,
}

impl<D: Driver> Bridge<D> {
    pub fn new(driver: Arc<D>, port: u16, token: String) -> Bridge<D> {
        Bridge { driver, port, token, locks: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), active: AtomicUsize::new(0) }
    }

    /// One request at a time per window: the guard is held while the request runs.
    fn with_window<T>(&self, label: &str, wait: Duration, f: impl FnOnce() -> T) -> Result<T, RunError> {
        let lock = {
            let mut m = self.locks.lock().unwrap_or_else(|p| p.into_inner());
            m.entry(label.to_string()).or_default().clone()
        };
        let until = Instant::now() + wait;
        loop {
            match lock.try_lock() {
                Ok(_g) => return Ok(f()),
                Err(std::sync::TryLockError::Poisoned(p)) => {
                    let _g = p.into_inner();
                    return Ok(f());
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if Instant::now() >= until {
                        return Err(RunError::Busy);
                    }
                    std::thread::sleep(Duration::from_millis(15));
                }
            }
        }
    }

    /// Runs the body of a function in the window and waits for its answer. Returns the value (JSON) or the error text of the page.
    fn run(&self, label: &str, body: &str, timeout_ms: u64, await_promise: bool) -> Result<Result<Value, String>, RunError> {
        let wait = BUSY_WAIT + Duration::from_millis(timeout_ms);
        self.with_window(label, wait, || self.run_locked(label, body, timeout_ms, await_promise))?
    }

    fn run_locked(&self, label: &str, body: &str, timeout_ms: u64, await_promise: bool) -> Result<Result<Value, String>, RunError> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let left = |d: Instant| d.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
        let first = match self.driver.exec(label, &js::start_script(&id, body, await_promise), left(deadline)) {
            Ok(s) => s,
            Err(ExecError::NoWindow) => return Err(RunError::NoWindow),
            Err(ExecError::Timeout) => return Err(RunError::Timeout(timeout_ms)),
            Err(ExecError::Failed(e)) => return Ok(Err(e)),
        };
        let mut answer = first;
        let mut pause = Duration::from_millis(15);
        loop {
            let v: Value = serde_json::from_str(&answer).map_err(|_| RunError::Failed(format!("the page answered something else: {}", cut(&answer, 200))))?;
            if v.get("done").and_then(Value::as_bool) != Some(true) {
                if v.get("done").is_none() {
                    return Err(RunError::Failed(format!("the page answered something else: {}", cut(&answer, 200))));
                }
                if Instant::now() >= deadline {
                    return Err(RunError::Timeout(timeout_ms));
                }
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(100));
                answer = match self.driver.exec(label, &js::poll_script(&id), left(deadline)) {
                    Ok(s) => s,
                    Err(ExecError::NoWindow) => return Err(RunError::NoWindow),
                    Err(ExecError::Timeout) => return Err(RunError::Timeout(timeout_ms)),
                    Err(ExecError::Failed(e)) => return Ok(Err(e)),
                };
                continue;
            }
            return Ok(if v.get("ok").and_then(Value::as_bool) == Some(true) { Ok(v.get("value").cloned().unwrap_or(Value::Null)) } else { Err(v.get("error").and_then(Value::as_str).unwrap_or("error").to_string()) });
        }
    }

    fn run_response(&self, label: &str, body: &str, timeout_ms: u64, await_promise: bool, shape: impl FnOnce(Value) -> Value) -> Response {
        match self.run(label, body, timeout_ms, await_promise) {
            Ok(Ok(v)) => Response::json(200, &shape(v)),
            Ok(Err(e)) => Response::json(200, &json!({ "ok": false, "error": e })),
            Err(RunError::NoWindow) => no_window(label),
            Err(RunError::Busy) => Response::error(409, "the window is busy with another request"),
            Err(RunError::Timeout(ms)) => Response::json(200, &json!({ "ok": false, "error": format!("timeout: the script did not finish in {ms} ms") })),
            Err(RunError::Failed(e)) => Response::error(500, &e),
        }
    }

    /// Routes one request that passed the guards.
    pub fn route(&self, head: &Head, body: &[u8]) -> Response {
        let known = ["/windows", "/native", "/badge", "/eval", "/click", "/type", "/key", "/console", "/snapshot"];
        let want_post = matches!(head.path.as_str(), "/eval" | "/click" | "/type" | "/key");
        if !known.contains(&head.path.as_str()) {
            return Response::error(404, "unknown endpoint");
        }
        if head.method != if want_post { "POST" } else { "GET" } {
            return Response::error(405, if want_post { "use POST" } else { "use GET" });
        }
        if head.path == "/windows" {
            return Response::json(200, &serde_json::to_value(self.driver.windows()).unwrap_or(Value::Null));
        }
        if head.path == "/native" {
            return Response::json(200, &self.driver.native());
        }
        // the last Dock badge the app set (macOS; D-056): what was asked for, the Result of the call, what the Dock tile reported back
        if head.path == "/badge" {
            let mut v = serde_json::to_value(crate::dockbadge::last()).unwrap_or(Value::Null);
            if let Some(o) = v.as_object_mut() {
                o.insert("platform".into(), json!(std::env::consts::OS));
            }
            return Response::json(200, &v);
        }
        // the parameters: the JSON body of a POST, the query of a GET
        let args: Value = if want_post {
            match serde_json::from_slice::<Value>(if body.is_empty() { b"{}" } else { body }) {
                Ok(v) if v.is_object() => v,
                _ => return Response::error(400, "the body must be a JSON object"),
            }
        } else {
            Value::Object(head.query.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
        };
        let label = match args.get("window") {
            None | Some(Value::Null) => "main".to_string(),
            Some(Value::String(s)) if valid_label(s) => s.clone(),
            _ => return Response::error(400, "window must be a window label like main, reader-1 or compose-2"),
        };
        match head.path.as_str() {
            "/eval" => self.eval(&label, &args),
            "/click" => self.click(&label, &args),
            "/type" => self.type_text(&label, &args),
            "/key" => self.key(&label, &args),
            "/console" => {
                let since = args.get("since").and_then(|s| s.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| s.as_u64())).unwrap_or(0);
                self.run_response(&label, &format!("return window.__hlb.console({since});"), DEFAULT_TIMEOUT_MS, false, |v| json!({ "ok": true, "last": v["last"], "entries": v["entries"] }))
            }
            "/snapshot" => self.snapshot(&label),
            _ => Response::error(404, "unknown endpoint"),
        }
    }

    fn eval(&self, label: &str, args: &Value) -> Response {
        let Some(code) = args.get("js").and_then(Value::as_str) else { return Response::error(400, "js (a string) is required") };
        let timeout_ms = match args.get("timeoutMs") {
            None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
            Some(v) => match v.as_u64() {
                Some(n) => n.clamp(100, MAX_TIMEOUT_MS),
                None => return Response::error(400, "timeoutMs must be a number of milliseconds"),
            },
        };
        let await_promise = match args.get("awaitPromise") {
            None | Some(Value::Null) => true,
            Some(Value::Bool(b)) => *b,
            _ => return Response::error(400, "awaitPromise must be true or false"),
        };
        self.run_response(label, &js::eval_body(code), timeout_ms, await_promise, |v| json!({ "ok": true, "value": v }))
    }

    fn click(&self, label: &str, args: &Value) -> Response {
        let mut o = serde_json::Map::new();
        if let Err(e) = copy_field(&mut o, args, "selector", Kind::Str).and(copy_field(&mut o, args, "index", Kind::Num)).and(copy_field(&mut o, args, "x", Kind::Num)).and(copy_field(&mut o, args, "y", Kind::Num)).and(copy_field(&mut o, args, "double", Kind::Bool)) {
            return Response::error(400, e);
        }
        match args.get("button") {
            None | Some(Value::Null) => {}
            Some(Value::String(b)) if ["left", "right", "middle"].contains(&b.as_str()) => {
                o.insert("button".into(), json!(b));
            }
            _ => return Response::error(400, "button must be left, right or middle"),
        }
        if !o.contains_key("selector") && !(o.contains_key("x") && o.contains_key("y")) {
            return Response::error(400, "give a selector, or x and y");
        }
        self.run_response(label, &format!("return window.__hlb.click({});", Value::Object(o)), DEFAULT_TIMEOUT_MS, false, |v| {
            let mut out = json!({ "ok": true });
            if let (Some(o), Some(v)) = (out.as_object_mut(), v.as_object()) {
                o.extend(v.clone());
            }
            out
        })
    }

    fn type_text(&self, label: &str, args: &Value) -> Response {
        let Some(text) = args.get("text").and_then(Value::as_str) else { return Response::error(400, "text (a string) is required") };
        let mut o = serde_json::Map::new();
        o.insert("text".into(), json!(text));
        if let Err(e) = copy_field(&mut o, args, "selector", Kind::Str).and(copy_field(&mut o, args, "clear", Kind::Bool)) {
            return Response::error(400, e);
        }
        self.run_response(label, &format!("return window.__hlb.type({});", Value::Object(o)), DEFAULT_TIMEOUT_MS, false, merge_ok)
    }

    fn key(&self, label: &str, args: &Value) -> Response {
        let Some(key) = args.get("key").and_then(Value::as_str).filter(|k| !k.is_empty() && k.chars().count() <= 32) else { return Response::error(400, "key (a name like Enter, Tab, Escape, ArrowDown, or one character) is required") };
        let mut o = serde_json::Map::new();
        o.insert("key".into(), json!(key));
        for m in ["ctrl", "shift", "alt", "meta"] {
            if let Err(e) = copy_field(&mut o, args, m, Kind::Bool) {
                return Response::error(400, e);
            }
        }
        self.run_response(label, &format!("return window.__hlb.key({});", Value::Object(o)), DEFAULT_TIMEOUT_MS, false, merge_ok)
    }

    fn snapshot(&self, label: &str) -> Response {
        match self.with_window(label, BUSY_WAIT + SNAPSHOT_TIMEOUT, || self.driver.snapshot(label, SNAPSHOT_TIMEOUT)) {
            Ok(Ok(png)) => Response::png(png),
            Ok(Err(SnapshotError::NoWindow)) | Err(RunError::NoWindow) => no_window(label),
            Ok(Err(SnapshotError::Unsupported(why))) => Response::error(501, &why),
            Ok(Err(SnapshotError::Failed(e))) => Response::error(500, &e),
            Err(RunError::Busy) => Response::error(409, "the window is busy with another request"),
            Err(_) => Response::error(500, "snapshot failed"),
        }
    }

    /// Serves one connection: guards first (the body of a refused request is never read), then the route.
    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let (head, rest) = match http::read_head(&mut stream) {
            Ok(x) => x,
            Err(e) => return http::write_response(&mut stream, &Response::error(e.status, e.message)),
        };
        if let Err(e) = http::authorize(&head, self.port, &self.token) {
            return http::write_response(&mut stream, &Response::error(e.status, e.message));
        }
        let body = match http::read_body(&mut stream, &head, rest) {
            Ok(b) => b,
            Err(e) => return http::write_response(&mut stream, &Response::error(e.status, e.message)),
        };
        let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.route(&head, &body))).unwrap_or_else(|_| Response::error(500, "internal error"));
        http::write_response(&mut stream, &response);
        let _ = stream.flush();
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

/// The answer of `GET /native` (REQ-4.1.5): one shape on every system, `null` where the system has no such number.
pub fn native_json(pid: u32, rss: Option<u64>, footprint: Option<u64>, private: Option<u64>, nsapp: Option<(usize, usize, usize)>, webview_windows: usize) -> Value {
    json!({
        "pid": pid,
        "rssBytes": rss,
        "footprintBytes": footprint,
        "privateBytes": private,
        "nsapp": nsapp.map(|(total, visible, titled)| json!({ "total": total, "visible": visible, "titled": titled })),
        "webviewWindows": webview_windows,
    })
}

fn no_window(label: &str) -> Response {
    Response::error(404, &format!("no window '{label}' (GET /windows lists them)"))
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn merge_ok(v: Value) -> Value {
    let mut out = json!({ "ok": true });
    if let (Some(o), Some(v)) = (out.as_object_mut(), v.as_object()) {
        o.extend(v.clone());
    }
    out
}

/// A label like `main`, `reader-1`, `compose-12`.
fn valid_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Copy)]
enum Kind {
    Str,
    Num,
    Bool,
}

/// Copies `name` from the request when present (null counts as absent), refusing a value of another type.
fn copy_field(out: &mut serde_json::Map<String, Value>, args: &Value, name: &str, kind: Kind) -> Result<(), &'static str> {
    match (args.get(name), kind) {
        (None | Some(Value::Null), _) => Ok(()),
        (Some(v @ Value::String(_)), Kind::Str) | (Some(v @ Value::Bool(_)), Kind::Bool) => {
            out.insert(name.into(), v.clone());
            Ok(())
        }
        (Some(v @ Value::Number(n)), Kind::Num) if n.as_f64().is_some_and(f64::is_finite) => {
            out.insert(name.into(), v.clone());
            Ok(())
        }
        _ => Err(match kind {
            Kind::Str => "a field that should be a string is not",
            Kind::Num => "a field that should be a number is not",
            Kind::Bool => "a field that should be true or false is not",
        }),
    }
}

/// A running server (tests stop it, the app never does).
pub struct Running {
    pub port: u16,
    #[cfg_attr(not(test), allow(dead_code))]
    stop: Arc<AtomicBool>,
}

impl Running {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // wakes the accept loop
        let _ = TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.port), Duration::from_millis(500));
    }
}

/// Binds 127.0.0.1 (port 0 = a free one) and serves in the background. Never binds another address.
pub fn start<D: Driver>(driver: Arc<D>, port: u16, token: String) -> std::io::Result<Running> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))?;
    let bound = listener.local_addr()?.port();
    let bridge = Arc::new(Bridge::new(driver, bound, token));
    let stop = Arc::new(AtomicBool::new(false));
    let stop_loop = stop.clone();
    std::thread::Builder::new().name("test-bridge".into()).spawn(move || {
        for conn in listener.incoming() {
            if stop_loop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = conn else { continue };
            // belt and braces: the socket is bound to the loopback address, a peer from elsewhere cannot exist
            if !stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
                continue;
            }
            if bridge.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                bridge.active.fetch_sub(1, Ordering::SeqCst);
                let mut s = stream;
                http::write_response(&mut s, &Response::error(503, "too many connections"));
                continue;
            }
            let b = bridge.clone();
            let spawned = std::thread::Builder::new().name("test-bridge-conn".into()).spawn(move || {
                b.serve(stream);
                b.active.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                bridge.active.fetch_sub(1, Ordering::SeqCst);
            }
        }
    })?;
    Ok(Running { port: bound, stop })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::{Read, Write};

    pub const TOKEN: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

    /// A fake web view layer: scripts are looked up by what they contain; `__hlb.take` answers after `slow` polls.
    pub struct Fake {
        pub windows: Vec<WindowInfo>,
        pub log: Mutex<Vec<(String, String)>>,
        /// the envelope the fake page answers to the next start script
        pub answer: Mutex<String>,
        pub pending_polls: AtomicUsize,
        pub delay: Mutex<Duration>,
        pub snapshot: Mutex<Result<Vec<u8>, SnapshotError>>,
        pub in_flight: AtomicUsize,
        pub max_in_flight: AtomicUsize,
    }

    impl Fake {
        pub fn new() -> Arc<Fake> {
            let w = |label: &str, kind: &str| WindowInfo { label: label.into(), title: "Hey Look!".into(), visible: true, focused: label == "main", x: 10, y: 20, width: 800, height: 600, logical_x: 10.0 / 1.5, logical_y: 20.0 / 1.5, logical_width: 800.0 / 1.5, logical_height: 600.0 / 1.5, scale: 1.5, kind: kind.into() };
            Arc::new(Fake {
                windows: vec![w("main", "main"), w("reader-1", "reader")],
                log: Mutex::new(vec![]),
                answer: Mutex::new(r#"{"done":true,"ok":true,"value":"Hey Look!"}"#.into()),
                pending_polls: AtomicUsize::new(0),
                delay: Mutex::new(Duration::ZERO),
                snapshot: Mutex::new(Ok(b"\x89PNG\r\n\x1a\nfake".to_vec())),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
            })
        }
    }

    impl Driver for Fake {
        fn windows(&self) -> Vec<WindowInfo> {
            self.windows.clone()
        }
        fn exec(&self, label: &str, script: &str, _timeout: Duration) -> Result<String, ExecError> {
            if !self.windows.iter().any(|w| w.label == label) {
                return Err(ExecError::NoWindow);
            }
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(*self.delay.lock().unwrap());
            self.log.lock().unwrap().push((label.to_string(), script.to_string()));
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if self.pending_polls.load(Ordering::SeqCst) > 0 {
                self.pending_polls.fetch_sub(1, Ordering::SeqCst);
                return Ok(r#"{"done":false}"#.into());
            }
            Ok(self.answer.lock().unwrap().clone())
        }
        fn native(&self) -> Value {
            native_json(4242, Some(100_000_000), None, None, None, self.windows.len())
        }
        fn snapshot(&self, label: &str, _timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
            if !self.windows.iter().any(|w| w.label == label) {
                return Err(SnapshotError::NoWindow);
            }
            match &*self.snapshot.lock().unwrap() {
                Ok(b) => Ok(b.clone()),
                Err(SnapshotError::Unsupported(s)) => Err(SnapshotError::Unsupported(s.clone())),
                Err(SnapshotError::Failed(s)) => Err(SnapshotError::Failed(s.clone())),
                Err(SnapshotError::NoWindow) => Err(SnapshotError::NoWindow),
            }
        }
    }

    /// One raw request over a real socket; returns (status, body bytes).
    pub fn raw(port: u16, request: &str) -> (u16, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        let text_end = out.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(out.len());
        let head = String::from_utf8_lossy(&out[..text_end]).into_owned();
        let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        (status, out[text_end..].to_vec())
    }

    pub fn call(port: u16, method: &str, path: &str, body: Option<&str>) -> (u16, Value) {
        let b = body.unwrap_or("");
        let req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{b}", b.len());
        let (st, body) = raw(port, &req);
        (st, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    fn started(f: &Arc<Fake>) -> Running {
        start(f.clone(), 0, TOKEN.to_string()).unwrap()
    }

    #[test]
    fn lists_windows_and_refuses_the_unauthorised() {
        let f = Fake::new();
        let s = started(&f);
        let (st, v) = call(s.port, "GET", "/windows", None);
        assert_eq!(st, 200);
        assert_eq!(v[0]["label"], "main");
        assert_eq!(v[1]["kind"], "reader");
        assert_eq!(v[0]["scale"], 1.5);
        assert_eq!(v[0]["width"], 800);
        // the logical frame: physical / scale
        assert!((v[0]["logicalWidth"].as_f64().unwrap() - 800.0 / 1.5).abs() < 1e-9 && (v[0]["logicalHeight"].as_f64().unwrap() - 400.0).abs() < 1e-9);
        assert!(v[0]["logicalX"].is_number() && v[0]["logicalY"].is_number());
        // no token
        let (st, _) = raw(s.port, &format!("GET /windows HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", s.port));
        assert_eq!(st, 401);
        // wrong token
        let (st, _) = raw(s.port, &format!("GET /windows HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Bridge-Token: {}\r\n\r\n", s.port, TOKEN.replace('a', "b")));
        assert_eq!(st, 401);
        // wrong Host (a page on another name reaching this port)
        let (st, _) = raw(s.port, &format!("GET /windows HTTP/1.1\r\nHost: evil.example:{}\r\nX-Bridge-Token: {TOKEN}\r\n\r\n", s.port));
        assert_eq!(st, 403);
        // an Origin of a web page
        let (st, body) = raw(s.port, &format!("GET /windows HTTP/1.1\r\nHost: localhost:{}\r\nOrigin: https://evil.example\r\nX-Bridge-Token: {TOKEN}\r\n\r\n", s.port));
        assert_eq!(st, 403);
        assert!(!String::from_utf8_lossy(&body).contains("main"));
        // a preflight gets nothing it could use
        let (st, _) = raw(s.port, &format!("OPTIONS /eval HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://evil.example\r\nAccess-Control-Request-Headers: authorization\r\n\r\n", s.port));
        assert_eq!(st, 403);
        // nothing was run for any of them
        assert!(f.log.lock().unwrap().is_empty());
        s.stop();
    }

    #[test]
    fn a_large_body_is_refused_before_it_is_read() {
        let f = Fake::new();
        let s = started(&f);
        let req = format!("POST /eval HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Bridge-Token: {TOKEN}\r\nContent-Length: {}\r\n\r\n", s.port, 2 * 1024 * 1024);
        assert_eq!(raw(s.port, &req).0, 413);
        s.stop();
    }

    #[test]
    fn binds_only_the_loopback_address() {
        let f = Fake::new();
        let s = started(&f);
        // reachable on 127.0.0.1, and the listener is not on 0.0.0.0: a connection to the machine's other address fails
        assert!(TcpStream::connect(("127.0.0.1", s.port)).is_ok());
        let src = include_str!("server.rs");
        assert!(src.contains("IpAddr::V4(Ipv4Addr::LOCALHOST), port"));
        let forbidden = ["0.0.0.0", "Ipv4Addr::UNSPECIFIED", "Ipv6Addr", "\"::\""];
        let code = src.split("#[cfg(test)]").next().unwrap();
        for f in forbidden {
            assert!(!code.contains(f), "server.rs mentions {f}");
        }
        s.stop();
    }

    #[test]
    fn eval_returns_the_value_and_pastes_the_script() {
        let f = Fake::new();
        let s = started(&f);
        *f.answer.lock().unwrap() = r#"{"done":true,"ok":true,"value":{"a":[1,2]}}"#.into();
        let (st, v) = call(s.port, "POST", "/eval", Some(r#"{"window":"main","js":"document.title"}"#));
        assert_eq!((st, v["ok"].clone(), v["value"]["a"][1].clone()), (200, json!(true), json!(2)));
        let log = f.log.lock().unwrap();
        assert!(log[0].1.contains("(async function () {\nreturn (document.title);\n})()"), "{}", log[0].1);
        drop(log);
        // an error of the page
        *f.answer.lock().unwrap() = r#"{"done":true,"ok":false,"error":"ReferenceError: x is not defined"}"#.into();
        let (st, v) = call(s.port, "POST", "/eval", Some(r#"{"js":"return x"}"#));
        assert_eq!((st, v["ok"].clone(), v["error"].clone()), (200, json!(false), json!("ReferenceError: x is not defined")));
        s.stop();
    }

    #[test]
    fn eval_waits_for_a_late_answer_and_times_out() {
        let f = Fake::new();
        let s = started(&f);
        // the start script and the first two polls say "not done", the next poll finds the value
        f.pending_polls.store(3, Ordering::SeqCst);
        *f.answer.lock().unwrap() = r#"{"done":true,"ok":true,"value":7}"#.into();
        let (_, v) = call(s.port, "POST", "/eval", Some(r#"{"js":"return 7","timeoutMs":3000}"#));
        assert_eq!(v["value"], 7);
        assert_eq!(f.log.lock().unwrap().len(), 4, "one start and three polls");
        assert!(f.log.lock().unwrap()[1].1.contains("take(\"r"));
        // never done
        *f.answer.lock().unwrap() = r#"{"done":false}"#.into();
        let t = Instant::now();
        let (st, v) = call(s.port, "POST", "/eval", Some(r#"{"js":"return new Promise(()=>{})","timeoutMs":300}"#));
        assert_eq!(st, 200);
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().starts_with("timeout"), "{v}");
        assert!(t.elapsed() < Duration::from_secs(5));
        s.stop();
    }

    #[test]
    fn bad_requests() {
        let f = Fake::new();
        let s = started(&f);
        for (m, p, b, want) in [
            ("POST", "/eval", Some("{}"), 400),
            ("POST", "/eval", Some("[1]"), 400),
            ("POST", "/eval", Some("not json"), 400),
            ("POST", "/eval", Some(r#"{"js":"1","window":"../x"}"#), 400),
            ("POST", "/eval", Some(r#"{"js":"1","timeoutMs":"soon"}"#), 400),
            ("POST", "/eval", Some(r#"{"js":"1","window":"nope-9"}"#), 404),
            ("GET", "/eval", None, 405),
            ("POST", "/windows", Some("{}"), 405),
            ("GET", "/nothing", None, 404),
            ("POST", "/click", Some("{}"), 400),
            ("POST", "/click", Some(r#"{"selector":5}"#), 400),
            ("POST", "/click", Some(r#"{"selector":"a","button":"hammer"}"#), 400),
            ("POST", "/type", Some("{}"), 400),
            ("POST", "/key", Some("{}"), 400),
            ("GET", "/snapshot?window=nope-9", None, 404),
            ("GET", "/console?window=nope-9", None, 404),
        ] {
            let (st, _) = call(s.port, m, p, b);
            assert_eq!(st, want, "{m} {p} {b:?}");
        }
        s.stop();
    }

    #[test]
    fn click_type_key_and_console_call_the_page_side() {
        let f = Fake::new();
        let s = started(&f);
        *f.answer.lock().unwrap() = r#"{"done":true,"ok":true,"value":{"target":{"tag":"button","id":"send","class":"btn","text":"Send"},"x":10,"y":20}}"#.into();
        let (st, v) = call(s.port, "POST", "/click", Some(r##"{"window":"reader-1","selector":"#send","double":true,"button":"right"}"##));
        assert_eq!((st, v["ok"].clone(), v["target"]["tag"].clone()), (200, json!(true), json!("button")));
        let last = f.log.lock().unwrap().iter().filter(|(l, s)| l == "reader-1" && s.contains("__hlb.click(")).count();
        assert_eq!(last, 1);
        assert!(f.log.lock().unwrap()[0].1.contains(r##"__hlb.click({"button":"right","double":true,"selector":"#send"})"##), "{}", f.log.lock().unwrap()[0].1);
        let (_, v) = call(s.port, "POST", "/type", Some(r#"{"text":"hi \"there\"\n","selector":null}"#));
        assert_eq!(v["ok"], true);
        assert!(f.log.lock().unwrap().iter().any(|(_, s)| s.contains(r#"__hlb.type({"text":"hi \"there\"\n"})"#)));
        let (_, v) = call(s.port, "POST", "/key", Some(r#"{"key":"Enter","ctrl":true}"#));
        assert_eq!(v["ok"], true);
        assert!(f.log.lock().unwrap().iter().any(|(_, s)| s.contains(r#"__hlb.key({"ctrl":true,"key":"Enter"})"#)));
        *f.answer.lock().unwrap() = r#"{"done":true,"ok":true,"value":{"last":3,"entries":[{"n":3,"t":1,"level":"log","text":"x"}]}}"#.into();
        let (_, v) = call(s.port, "GET", "/console?window=main&since=2", None);
        assert_eq!((v["ok"].clone(), v["last"].clone(), v["entries"][0]["text"].clone()), (json!(true), json!(3), json!("x")));
        assert!(f.log.lock().unwrap().iter().any(|(_, s)| s.contains("__hlb.console(2)")));
        s.stop();
    }

    #[test]
    fn badge_reports_the_last_dock_badge_request_and_needs_get() {
        let f = Fake::new();
        let s = started(&f);
        let (st, v) = call(s.port, "GET", "/badge", None);
        assert_eq!(st, 200);
        for k in ["attempts", "requested", "outcome", "tile", "mainThread", "platform"] {
            assert!(v.get(k).is_some(), "{k} missing in {v}");
        }
        assert_eq!(call(s.port, "POST", "/badge", Some("{}")).0, 405);
        s.stop();
    }

    #[test]
    fn native_reports_the_process_with_nulls_where_a_system_has_no_number_and_needs_get() {
        let f = Fake::new();
        let s = started(&f);
        let (st, v) = call(s.port, "GET", "/native", None);
        assert_eq!(st, 200);
        for k in ["pid", "rssBytes", "footprintBytes", "privateBytes", "nsapp", "webviewWindows"] {
            assert!(v.get(k).is_some(), "{k} missing in {v}");
        }
        assert!(v["footprintBytes"].is_null() && v["privateBytes"].is_null() && v["nsapp"].is_null());
        assert_eq!(v["webviewWindows"], 2);
        let m = native_json(1, Some(2), Some(3), None, Some((5, 4, 2)), 2);
        assert_eq!(m["nsapp"], json!({ "total": 5, "visible": 4, "titled": 2 }));
        assert_eq!(m["footprintBytes"], 3);
        assert_eq!(call(s.port, "POST", "/native", Some("{}")).0, 405);
        s.stop();
    }

    #[test]
    fn snapshot_png_and_unsupported() {
        let f = Fake::new();
        let s = started(&f);
        let req = format!("GET /snapshot?window=main HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Bridge-Token: {TOKEN}\r\n\r\n", s.port);
        let (st, body) = raw(s.port, &req);
        assert_eq!(st, 200);
        assert!(body.starts_with(b"\x89PNG"));
        *f.snapshot.lock().unwrap() = Err(SnapshotError::Unsupported("not on this system".into()));
        let (st, body) = raw(s.port, &req);
        assert_eq!(st, 501);
        assert!(String::from_utf8_lossy(&body).contains("not on this system"));
        s.stop();
    }

    #[test]
    fn one_request_at_a_time_per_window() {
        let f = Fake::new();
        *f.delay.lock().unwrap() = Duration::from_millis(120);
        let s = started(&f);
        let port = s.port;
        let hs: Vec<_> = (0..4).map(|_| std::thread::spawn(move || call(port, "POST", "/eval", Some(r#"{"js":"1"}"#)).0)).collect();
        for h in hs {
            assert_eq!(h.join().unwrap(), 200);
        }
        assert_eq!(f.max_in_flight.load(Ordering::SeqCst), 1, "two requests ran in the same window at once");
        s.stop();
    }
}
