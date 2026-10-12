//! The page the browser shows after the OAuth redirect (served from the loopback listener in `oauth.rs`).
//! Self-contained: no external requests (logo, check icon and styles are inline), light / dark through `prefers-color-scheme`,
//! every dynamic value HTML-escaped, and a strict Content-Security-Policy (the one inline script is allowed by its hash).
use base64::Engine;
use sha2::{Digest, Sha256};

/// What the page tells the user.
pub enum Outcome<'a> {
    /// Signed in. `email` is the account address when it is known.
    Success { provider: &'a str, email: Option<&'a str> },
    /// Not signed in: a headline, the reason (shown as received, escaped) and what to do next.
    Error { title: &'a str, reason: &'a str, next: &'a str },
}

/// HTML-escape text for element content and quoted attribute values.
pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            '\0' => {}
            c => o.push(c),
        }
    }
    o
}

/// The app mark (an envelope with eyes) on a blue tile.
const LOGO: &str = r##"<svg class="logo" viewBox="0 0 96 96" width="64" height="64" role="img" aria-label="Hey Look!" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a8be0"/><stop offset="1" stop-color="#0c5ca8"/></linearGradient></defs><rect width="96" height="96" rx="22" fill="url(#g)"/><g transform="translate(10 12) scale(.082)"><circle cx="370" cy="400" r="120" fill="#f5f9ff"/><circle cx="630" cy="400" r="120" fill="#f5f9ff"/><rect x="162" y="430" width="678" height="372" rx="62" fill="#f5f9ff"/><circle cx="415" cy="383" r="54" fill="#0f6cbd"/><circle cx="435" cy="361" r="18" fill="#fff"/><circle cx="675" cy="383" r="54" fill="#0f6cbd"/><circle cx="695" cy="361" r="18" fill="#fff"/><path d="M196 466 L478 628 Q497 639 516 628 L808 462" fill="none" stroke="#0f6cbd" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/><circle cx="805" cy="275" r="58" fill="#ffbf47"/></g></svg>"##;

const CHECK: &str = r##"<svg class="status ok" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##;

const CROSS: &str = r##"<svg class="status bad" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>"##;

const STYLE: &str = r#"
:root{color-scheme:light dark;--bg:#f3f5f9;--card:#fff;--fg:#1f2328;--muted:#5b6470;--border:#e3e6eb;--accent:#0f6cbd;--accent-h:#0c5ca8;--accent-fg:#fff;--ok:#1a7f4b;--bad:#b42318;--soft:#f6f7f9;--shadow:0 12px 32px rgba(16,24,40,.12),0 2px 6px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--card:#232429;--fg:#f1f2f4;--muted:#a2a8b3;--border:#34363e;--accent:#4f9fe0;--accent-h:#6cb1ea;--accent-fg:#07121f;--ok:#4cc38a;--bad:#ff8a80;--soft:#2d2f36;--shadow:0 12px 32px rgba(0,0,0,.45)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI Variable Text","Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:36px 32px 28px;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 26px}
.brand .name{font-size:17px;font-weight:600;letter-spacing:.1px}
.logo{display:block;width:44px;height:44px}
.status{display:block;margin:0 auto 14px}
.status.ok{color:var(--ok)}
.status.bad{color:var(--bad)}
h1{font-size:22px;line-height:1.25;font-weight:600;margin:0 0 8px}
p{margin:0 0 6px;color:var(--muted)}
.account{display:inline-block;max-width:100%;margin:12px 0 4px;padding:6px 12px;border-radius:999px;background:var(--soft);border:1px solid var(--border);color:var(--fg);font-weight:600;overflow-wrap:anywhere}
.reason{margin:16px 0 4px;padding:10px 12px;border-radius:8px;background:var(--soft);border:1px solid var(--border);color:var(--fg);font-size:13.5px;text-align:left;overflow-wrap:anywhere}
.actions{margin-top:22px}
button{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-fg);border:0;border-radius:8px;padding:9px 22px;min-width:120px;cursor:pointer}
button:hover{background:var(--accent-h)}
button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
button[hidden]{display:none}
.hint{margin-top:10px;font-size:13px;color:var(--muted)}
.hint[hidden]{display:none}
@media (max-width:480px){main{padding:28px 20px 22px}}
@media (prefers-reduced-motion:no-preference){main{animation:in .25s ease-out}@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}
"#;

/// Reveals the Close button (without JavaScript the page is just text), removes the one-time code from the address bar and
/// closes the tab; a browser that refuses to close a tab it did not open gets a plain instruction.
const SCRIPT: &str = r#"(function(){try{history.replaceState(null,"",location.pathname)}catch(e){}
var b=document.getElementById("close"),h=document.getElementById("closehint");if(!b)return;b.hidden=false;
b.addEventListener("click",function(){window.close();setTimeout(function(){if(h)h.hidden=false},250)})})();"#;

/// Value for the `Content-Security-Policy` header of the page: nothing is allowed except inline styles, `data:` images and the one script.
pub fn csp() -> String {
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SCRIPT.as_bytes()));
    format!("default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-{hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
}

/// The full HTML document for an outcome.
pub fn render(o: &Outcome) -> String {
    let (title, main) = match o {
        Outcome::Success { provider, email } => {
            let provider = escape(provider);
            let who = match email {
                Some(e) if !e.trim().is_empty() => format!(r#"<div class="account">{}</div>"#, escape(e.trim())),
                _ => String::new(),
            };
            (
                "Signed in to Hey Look!".to_string(),
                format!(
                    r#"{CHECK}<h1>You're signed in</h1><p>{provider} is connected to Hey Look!</p>{who}
<p class="lead">You can close this tab and return to Hey Look!</p>
<div class="actions"><button id="close" type="button" hidden>Close this tab</button><p id="closehint" class="hint" hidden>Your browser kept this tab open. Close it yourself, for example with Ctrl+W.</p></div>"#
                ),
            )
        }
        Outcome::Error { title, reason, next } => (
            format!("{} - Hey Look!", title),
            format!(
                r#"{CROSS}<h1>{}</h1><div class="reason" role="alert">{}</div><p style="margin-top:14px">{}</p>
<div class="actions"><button id="close" type="button" hidden>Close this tab</button><p id="closehint" class="hint" hidden>Your browser kept this tab open. Close it yourself, for example with Ctrl+W.</p></div>"#,
                escape(title),
                escape(reason),
                escape(next)
            ),
        ),
    };
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>{}</title><style>{STYLE}</style></head>
<body><main><div class="brand">{LOGO}<span class="name">Hey Look!</span></div>
{main}
</main><script>{SCRIPT}</script></body></html>
"#,
        escape(&title)
    )
}

/// A complete HTTP/1.1 response (status line, security headers, body).
pub fn response(status: u16, o: &Outcome) -> Vec<u8> {
    let body = render(o);
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nContent-Security-Policy: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len(),
        csp()
    );
    let mut v = head.into_bytes();
    v.extend_from_slice(body.as_bytes());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(email: Option<&str>) -> String {
        render(&Outcome::Success { provider: "Google", email })
    }
    fn bad() -> String {
        render(&Outcome::Error { title: "Sign-in was cancelled", reason: "access_denied", next: "Return to Hey Look! and try again." })
    }

    #[test]
    fn escapes_everything_dynamic() {
        assert_eq!(escape(r#"<a href="x">'&"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
        let evil = r#""><script>alert(1)</script><img src=x onerror=alert(2)>"#;
        for html in [
            ok(Some(evil)),
            render(&Outcome::Success { provider: evil, email: None }),
            render(&Outcome::Error { title: evil, reason: evil, next: evil }),
        ] {
            assert!(!html.contains("<script>alert"), "{html}");
            assert!(!html.contains("<img src=x"), "{html}");
            assert_eq!(html.matches("<script>").count(), 1, "only our own script");
            assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        }
    }

    #[test]
    fn success_page_shows_the_address_and_a_close_button() {
        let h = ok(Some("nam@example.com"));
        assert!(h.contains("You're signed in"));
        assert!(h.contains(r#"<div class="account">nam@example.com</div>"#));
        assert!(h.contains("You can close this tab and return to Hey Look!"));
        assert!(h.contains(r#"id="close""#) && h.contains("window.close()"));
        assert!(h.contains(r#"id="closehint""#), "fallback text when the tab cannot be closed");
        assert!(h.contains("<svg") && h.contains("prefers-color-scheme:dark") && h.contains("charset=\"utf-8\""));
        // no address: no account chip
        assert!(!ok(None).contains(r#"class="account""#));
        assert!(!ok(Some("  ")).contains(r#"class="account""#));
    }

    #[test]
    fn error_page_shows_reason_and_next_step() {
        let h = bad();
        assert!(h.contains("Sign-in was cancelled"));
        assert!(h.contains(r#"role="alert">access_denied<"#));
        assert!(h.contains("Return to Hey Look! and try again."));
        assert!(h.contains("status bad") && !h.contains("status ok"));
        assert!(!h.contains("You're signed in"));
    }

    #[test]
    fn pages_are_self_contained() {
        for h in [ok(Some("a@b.c")), bad()] {
            // the only URL-like text allowed is the SVG namespace
            let stripped = h.replace("http://www.w3.org/2000/svg", "");
            assert!(!stripped.contains("http://") && !stripped.contains("https://") && !stripped.contains("//cdn"), "external reference");
            for attr in ["src=\"http", "href=", "@import", "url(http", "<link", "<iframe", "<form"] {
                assert!(!h.contains(attr), "{attr}");
            }
            assert!(!h.contains("src="), "no images loaded by URL");
        }
    }

    #[test]
    fn response_has_security_headers_and_correct_length() {
        let raw = response(200, &Outcome::Success { provider: "Google", email: Some("é@example.com") });
        let text = String::from_utf8(raw.clone()).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK"));
        assert!(head.contains("Content-Type: text/html; charset=utf-8"));
        assert!(head.contains("Cache-Control: no-store"));
        assert!(head.contains("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:;"));
        assert!(head.contains("X-Content-Type-Options: nosniff"));
        // Content-Length counts bytes, not characters (the address has a multi-byte letter)
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
        assert!(response(400, &Outcome::Error { title: "t", reason: "r", next: "n" }).starts_with(b"HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn csp_hash_matches_the_inline_script() {
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(SCRIPT.as_bytes()));
        assert!(csp().contains(&format!("script-src 'sha256-{hash}'")));
        // the script in the page is byte-identical to the hashed one
        assert!(ok(None).contains(&format!("<script>{SCRIPT}</script>")));
        let c = csp();
        assert!(!c.contains("unsafe-eval") && !c.contains("script-src 'unsafe-inline'"));
    }

    /// Writes both pages (and light / dark variants are chosen by the browser) for screenshots: OAUTH_PAGE_DUMP=<dir> cargo test dump_pages
    #[test]
    fn dump_pages() {
        if let Ok(dir) = std::env::var("OAUTH_PAGE_DUMP") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/success.html"), ok(Some("nam.hoang@example.com"))).unwrap();
            std::fs::write(format!("{dir}/error.html"), render(&Outcome::Error {
                title: "Sign-in didn't finish",
                reason: "invalid_client: The OAuth client was not found.",
                next: "Go back to Hey Look!, check the client ID in Settings > Add account, and try again.",
            })).unwrap();
        }
    }
}
