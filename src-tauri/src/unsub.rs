//! The One-Click POST of Unsubscribe (RFC 8058) and the lines it leaves in `startup.log` (1.0.7 fix18, D-065, DEC-021).
//!
//! Until 1.0.6 the POST used `reqwest::Client::new()`: no timeout at all, so an unreachable host kept the person waiting for the system's connect
//! timeout (about 75 s on macOS) with nothing on screen, and nothing said why a failed POST ended in a browser tab. Now the request gives up
//! after 5 s (connect) / 10 s (total), every outcome is one line (`[unsub] ...`, the host only: never a path, a query or a token, which hold the
//! reader's identity) and the caller falls back to opening the page whatever went wrong.

use std::time::Duration;

/// The connect part of the POST gives up after this long.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The whole POST (connect, request, answer, redirects) gives up after this long.
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);

/// What came of the POST.
#[derive(Debug, PartialEq, Eq)]
pub enum Post {
    /// The server answered 2xx.
    Ok(u16),
    /// Any other end; the reason is one word for the log: `http <status>`, `tls`, `timeout`, `dns`, `connect`, `redirect`, `error`.
    Failed(String),
}

/// The client of the POST: the app's own user agent, no cookies, redirects followed as reqwest does by default.
pub fn client(connect: Duration, total: Duration) -> reqwest::Result<reqwest::Client> {
    builder(connect, total).build()
}

fn builder(connect: Duration, total: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder().connect_timeout(connect).timeout(total).user_agent(concat!("HeyLook/", env!("CARGO_PKG_VERSION")))
}

/// The POST of RFC 8058: `List-Unsubscribe=One-Click` as a form body.
pub async fn post(client: &reqwest::Client, url: &str) -> Post {
    match client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Post::Ok(r.status().as_u16()),
        Ok(r) => Post::Failed(format!("http {}", r.status().as_u16())),
        Err(e) => Post::Failed(reason(&e)),
    }
}

/// The POST the command makes: the app's client (5 s / 10 s), the outcome logged as one line (host only), returned for the caller.
pub async fn run(url: &str) -> Post {
    run_with(client(CONNECT_TIMEOUT, TOTAL_TIMEOUT), url).await
}

async fn run_with(client: reqwest::Result<reqwest::Client>, url: &str) -> Post {
    let outcome = match client {
        Ok(c) => post(&c, url).await,
        Err(_) => Post::Failed("error".into()),
    };
    log(&post_line(&host_of(url), &outcome));
    outcome
}

/// One word for the log. Text of the error chain is only looked at to tell the kinds apart; it is never logged (it names the URL).
fn reason(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "timeout".into();
    }
    let mut chain = String::new();
    let mut cur: Option<&dyn std::error::Error> = Some(e);
    while let Some(c) = cur {
        chain.push_str(&c.to_string().to_ascii_lowercase());
        chain.push(' ');
        cur = c.source();
    }
    let has = |w: &[&str]| w.iter().any(|x| chain.contains(x));
    if has(&["certificate", "unknownissuer", "invalid peer", "handshake", "tls", "ssl"]) {
        "tls".into()
    } else if has(&["dns error", "failed to lookup", "no such host", "name or service not known", "nodename nor servname"]) {
        "dns".into()
    } else if e.is_redirect() {
        "redirect".into()
    } else if e.is_connect() {
        "connect".into()
    } else {
        "error".into()
    }
}

/// The host of a link, for the log: no scheme, user info, port, path, query or fragment. A mail address (`mailto:`) gives its domain.
pub fn host_of(link: &str) -> String {
    let s = link.trim();
    let rest = s.split_once("://").map(|(_, r)| r).or_else(|| s.strip_prefix("mailto:")).unwrap_or(s);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let auth = &rest[..end];
    let auth = auth.rsplit('@').next().unwrap_or(auth);
    // an IPv6 literal keeps its brackets, any other host loses the port
    let host = if auth.starts_with('[') { auth.split_once(']').map(|(h, _)| format!("{h}]")).unwrap_or_else(|| auth.to_string()) } else { auth.split(':').next().unwrap_or(auth).to_string() };
    let host: String = host.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':')).take(120).collect();
    if host.is_empty() { "?".into() } else { host.to_ascii_lowercase() }
}

/// One line of `startup.log`, tag `unsub`.
pub fn log(what: &str) {
    crate::startup::line("unsub", what);
}

/// The line for a POST.
pub fn post_line(host: &str, p: &Post) -> String {
    match p {
        Post::Ok(status) => format!("post {host}: ok {status}"),
        Post::Failed(why) => format!("post {host}: failed {why}"),
    }
}

/// The line for the browser having been asked to open the page (written when the page reports it): `ok`, or `failed` with a short, URL-free reason.
pub fn open_line(host: &str, error: Option<&str>) -> String {
    match error {
        None => format!("open {host}: ok"),
        Some(e) => {
            // the opener's message may quote the link: keep the kind of words only
            let short: String = e.split_whitespace().filter(|w| !w.contains("://") && !w.contains('@')).collect::<Vec<_>>().join(" ").chars().take(80).collect();
            format!("open {host}: failed {}", if short.is_empty() { "error".to_string() } else { short })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, OnceLock};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn host_of_keeps_the_host_only() {
        assert_eq!(host_of("https://Click.Example.com/u/abc123?token=secret#x"), "click.example.com");
        assert_eq!(host_of("https://user:pw@example.com:8443/path"), "example.com");
        assert_eq!(host_of("http://127.0.0.1:8080/x"), "127.0.0.1");
        assert_eq!(host_of("mailto:unsub-token@lists.example.org?subject=unsubscribe%20token"), "lists.example.org");
        assert_eq!(host_of("https://[::1]:9/x"), "[::1]");
        assert_eq!(host_of(""), "?");
        assert!(!host_of("https://example.com/secret-token?x=1").contains("secret"));
    }

    #[test]
    fn lines_have_no_url_in_them() {
        assert_eq!(post_line("a.example", &Post::Ok(200)), "post a.example: ok 200");
        assert_eq!(post_line("a.example", &Post::Failed("tls".into())), "post a.example: failed tls");
        assert_eq!(open_line("a.example", None), "open a.example: ok");
        let l = open_line("a.example", Some("could not open https://a.example/u/secret for user@x.com: no browser"));
        assert!(l.starts_with("open a.example: failed") && !l.contains("secret") && !l.contains("user@x.com"), "{l}");
    }

    /// A TLS server with a self-signed certificate for 127.0.0.1 (made when the test runs, in memory); answers every request with `status`.
    fn tls_server(status: u16) -> (u16, Vec<u8>, Arc<std::sync::atomic::AtomicUsize>) {
        static CONFIG: OnceLock<(Arc<rustls::ServerConfig>, Vec<u8>)> = OnceLock::new();
        let (config, cert) = CONFIG.get_or_init(|| {
            let made = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap();
            let key = rustls::pki_types::PrivateKeyDer::try_from(made.signing_key.serialize_der()).unwrap();
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let cfg = rustls::ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![made.cert.der().clone()], key)
                .unwrap();
            (Arc::new(cfg), made.cert.der().to_vec())
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (config, h) = (config.clone(), hits.clone());
        std::thread::spawn(move || {
            for s in listener.incoming().flatten() {
                let (config, h) = (config.clone(), h.clone());
                std::thread::spawn(move || {
                    let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), s);
                    let mut buf = [0u8; 2048];
                    let n = tls.read(&mut buf).unwrap_or(0);
                    if n > 0 {
                        h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = write!(tls, "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = tls.flush();
                    }
                });
            }
        });
        (port, cert.clone(), hits)
    }

    #[test]
    fn a_trusted_certificate_and_200_is_ok() {
        let (port, cert, hits) = tls_server(200);
        let c = builder(CONNECT_TIMEOUT, TOTAL_TIMEOUT).add_root_certificate(reqwest::Certificate::from_der(&cert).unwrap()).build().unwrap();
        assert_eq!(rt().block_on(run_with(Ok(c), &format!("https://127.0.0.1:{port}/u/abc"))), Post::Ok(200));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn a_server_error_is_a_failure_with_its_status() {
        let (port, cert, _) = tls_server(500);
        let c = builder(CONNECT_TIMEOUT, TOTAL_TIMEOUT).add_root_certificate(reqwest::Certificate::from_der(&cert).unwrap()).build().unwrap();
        assert_eq!(rt().block_on(run_with(Ok(c), &format!("https://127.0.0.1:{port}/u/abc"))), Post::Failed("http 500".into()));
    }

    #[test]
    fn a_self_signed_certificate_fails_as_tls() {
        let (port, _cert, _) = tls_server(200);
        let c = client(CONNECT_TIMEOUT, TOTAL_TIMEOUT).unwrap(); // (the app's client: it does not know this certificate)
        assert_eq!(rt().block_on(run_with(Ok(c), &format!("https://127.0.0.1:{port}/u/abc?token=secret"))), Post::Failed("tls".into()));
    }

    #[test]
    fn a_closed_port_fails_as_connect() {
        let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }; // (free again once the listener is dropped)
        let c = client(CONNECT_TIMEOUT, TOTAL_TIMEOUT).unwrap();
        assert_eq!(rt().block_on(run_with(Ok(c), &format!("https://127.0.0.1:{port}/u/abc"))), Post::Failed("connect".into()));
    }

    #[test]
    fn a_server_that_never_answers_gives_up_at_the_total_timeout() {
        // accepts the connection and then says nothing at all
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let keep: Arc<std::sync::Mutex<Vec<TcpStream>>> = Arc::default();
        let k = keep.clone();
        std::thread::spawn(move || {
            for s in listener.incoming().flatten() {
                k.lock().unwrap().push(s);
            }
        });
        let c = client(Duration::from_secs(5), Duration::from_millis(700)).unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(rt().block_on(run_with(Ok(c), &format!("https://127.0.0.1:{port}/u/abc"))), Post::Failed("timeout".into()));
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    }

    #[test]
    fn the_limits_are_the_agreed_ones() {
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(5));
        assert_eq!(TOTAL_TIMEOUT, Duration::from_secs(10));
    }
}
