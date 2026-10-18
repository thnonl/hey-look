//! Test bridge: a remote control of the windows for QA, in DEBUG builds only (`#[cfg(debug_assertions)] mod testbridge;` in lib.rs; a release
//! build has none of this code, none of its strings, and no command, capability or setting that mentions it).
//!
//! Why: WKWebView (macOS) has no remote debugging port, so a macOS tester could only click by screen coordinates and could not read the DOM.
//! The bridge gives the same things the Windows tests get from CDP: run a script in a window, click / type / press keys by selector, read
//! the console, list windows, take a picture of a window.
//!
//! * OFF unless the environment variable [`ENV_VAR`] is a port number (`0` = pick a free one). Anything else is off, and an off bridge
//!   writes nothing to the log.
//! * When on, ONE line goes to startup.log: `test bridge: listening on 127.0.0.1:<port>, token <64 hex>`. The token is random per run.
//! * 127.0.0.1 only. Every request needs the token (`Authorization: Bearer` or `X-Bridge-Token`), a Host of `127.0.0.1:<port>` or
//!   `localhost:<port>` and no Origin of a web page; no CORS headers; bodies up to 1 MB; one request at a time per window (see `http.rs`).
//! * No command is registered for the page to call: scripts go in through the web view's own script call and the answers come back
//!   through its completion handler (`native.rs`). The page cannot reach the bridge, and nothing here reads files or runs programs.
//! * A QA build also has its own identifier and data folder, and the person's installed release app has no bridge at all.

mod http;
mod js;
mod native;
mod server;

/// The environment variable that switches the bridge on.
pub const ENV_VAR: &str = "HEYLOOK_TEST_BRIDGE";

/// The port the value asks for: all ASCII digits, 0 to 65535. `None` (= off) for everything else, an empty value included.
pub fn port_from_value(v: Option<&str>) -> Option<u16> {
    let v = v?;
    if v.is_empty() || v.len() > 5 || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<u16>().ok()
}

/// The port this run was asked to listen on, `None` when the bridge is off.
pub fn requested() -> Option<u16> {
    port_from_value(std::env::var(ENV_VAR).ok().as_deref())
}

/// 32 random bytes from the operating system, as 64 hex characters.
pub fn new_token() -> Result<String, String> {
    use rand::{TryRng, rngs::SysRng};
    let mut bytes = [0u8; 32];
    SysRng.try_fill_bytes(&mut bytes).map_err(|e| format!("no random bytes from the system: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The page side, as an initialization script of every window (console ring buffer, safe JSON, input helpers).
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("testbridge").js_init_script(js::BRIDGE_JS.to_string()).build()
}

/// Starts the server when the environment asks for it (the data folder, and with it the log, is known by now).
pub fn start(app: &tauri::AppHandle) {
    let Some(port) = requested() else { return };
    let token = match new_token() {
        Ok(t) => t,
        Err(e) => return crate::startup::line("bridge", &format!("test bridge: not started: {e}")),
    };
    match server::start(std::sync::Arc::new(native::TauriDriver { app: app.clone() }), port, token.clone()) {
        Ok(running) => crate::startup::line("bridge", &format!("test bridge: listening on 127.0.0.1:{}, token {token}", running.port)),
        Err(e) => crate::startup::line("bridge", &format!("test bridge: not started: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_port_number_switches_it_on() {
        assert_eq!(port_from_value(Some("0")), Some(0));
        assert_eq!(port_from_value(Some("8123")), Some(8123));
        assert_eq!(port_from_value(Some("65535")), Some(65535));
        assert_eq!(port_from_value(Some("1")), Some(1));
        for off in [None, Some(""), Some("true"), Some("on"), Some("yes"), Some("65536"), Some("-1"), Some("+80"), Some(" 80"), Some("80 "), Some("8.0"), Some("0x50"), Some("123456"), Some("\u{ff18}\u{ff10}")] {
            assert_eq!(port_from_value(off), None, "{off:?}");
        }
    }

    #[test]
    fn the_token_is_64_hex_and_new_every_time() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_ne!(a, b);
    }

    #[test]
    fn the_log_line_has_the_documented_shape() {
        let src = include_str!("mod.rs");
        assert!(src.contains("test bridge: listening on 127.0.0.1:{}, token {token}"));
        // the only place that logs is `start`, and it returns before that when the bridge is off
        assert!(src.contains("let Some(port) = requested() else { return };"));
    }
}
