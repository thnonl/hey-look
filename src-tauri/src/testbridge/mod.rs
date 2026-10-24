//! Test bridge: a remote control of the windows for QA, in DEBUG builds only (`#[cfg(debug_assertions)] mod testbridge;` in lib.rs; a release
//! build has none of this code, none of its strings, and no command, capability or setting that mentions it).
//!
//! Why: WKWebView (macOS) has no remote debugging port, so a macOS tester could only click by screen coordinates and could not read the DOM.
//! The bridge gives the same things the Windows tests get from CDP: run a script in a window, click / type / press keys by selector, read
//! the console, list windows, take a picture of a window.
//!
//! * OFF unless the environment variable [`ENV_VAR`] is a port number (`0` = pick a free one). Anything else is off, and an off bridge
//!   writes nothing to the log.
//! * When on, ONE line goes to startup.log: `test bridge: listening on 127.0.0.1:<port>, token <64 hex>`. The token is random per run. The line is pinned:
//!   when startup.log reaches its size cap and starts over, it is written again at the top (a long session lost it once). The same facts are in
//!   `test-bridge.json` in the data folder (`{port, token, pid, started}`, mode 0600 on macOS / Linux, on Windows an access list with one entry, the current
//!   user, and no inherited entries), written at start and removed when the app ends cleanly (`RunEvent::Exit`, and `quit_final` before the exit watchdog can end
//!   the process); a process that is killed leaves it, and the next start rewrites it with the same protection. A script reads that file first.
//! * 127.0.0.1 only. Every request needs the token (`Authorization: Bearer` or `X-Bridge-Token`), a Host of `127.0.0.1:<port>` or
//!   `localhost:<port>` and no Origin of a web page; no CORS headers; bodies up to 1 MB; one request at a time per window (see `http.rs`).
//! * No command is registered for the page to call: scripts go in through the web view's own script call and the answers come back
//!   through its completion handler (`native.rs`). The page cannot reach the bridge, and nothing here reads files or runs programs.
//! * A QA build also has its own identifier and data folder, and the person's installed release app has no bridge at all.

#[cfg(windows)]
mod acl;
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

/// The file in the data folder that tells a script where the bridge is (it is also in startup.log).
pub const INFO_FILE: &str = "test-bridge.json";

/// What `INFO_FILE` holds. `started` is RFC 3339 (UTC).
pub fn info_json(port: u16, token: &str, pid: u32, started: &str) -> String {
    serde_json::json!({ "port": port, "token": token, "pid": pid, "started": started }).to_string()
}

/// Writes `INFO_FILE` into the data folder (only the owner can read it: mode 0600 on macOS / Linux, one access-list entry for the user on Windows: it holds the token).
fn write_info(port: u16, token: &str) {
    let Some(dir) = crate::startup::log_dir() else { return };
    let text = info_json(port, token, std::process::id(), &chrono::Utc::now().to_rfc3339());
    if let Err(e) = write_protected(&dir.join(INFO_FILE), &text) {
        crate::startup::line("bridge", &format!("test bridge: could not write {INFO_FILE}: {e}"));
    }
}

/// Writes `text` to `path` so that nobody but the owner can ever read it: the file is created (or, when a killed run left one, opened) EMPTY, its protection is
/// set, and only then the token goes in. On Windows the protection is an access list with one entry (the current user) and no inherited entries; if it cannot be
/// set, nothing is written.
fn write_protected(path: &std::path::Path, text: &str) -> Result<(), String> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path).map_err(|e| e.to_string())?;
    // (a file that already existed keeps its old mode: set it again)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    acl::owner_only(path)?;
    f.set_len(0).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())
}

/// Removes `INFO_FILE` (the app ends cleanly: the file would point at a bridge that is gone). Also called by `quit_final`, before the exit watchdog
/// can end the process with `std::process::exit` (that way out skips `RunEvent::Exit`).
pub(crate) fn remove_info() {
    if let Some(dir) = crate::startup::log_dir() {
        let _ = std::fs::remove_file(dir.join(INFO_FILE));
    }
}

/// The page side, as an initialization script of every window (console ring buffer, safe JSON, input helpers); and the removal of `INFO_FILE` when the app ends.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("testbridge")
        .js_init_script(js::BRIDGE_JS.to_string())
        .on_event(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                remove_info();
            }
        })
        .build()
}

/// Starts the server when the environment asks for it (the data folder, and with it the log, is known by now).
pub fn start(app: &tauri::AppHandle) {
    let Some(port) = requested() else { return };
    let token = match new_token() {
        Ok(t) => t,
        Err(e) => return crate::startup::line("bridge", &format!("test bridge: not started: {e}")),
    };
    match server::start(std::sync::Arc::new(native::TauriDriver { app: app.clone() }), port, token.clone()) {
        Ok(running) => {
            crate::startup::line_pinned("bridge", &format!("test bridge: listening on 127.0.0.1:{}, token {token}", running.port));
            write_info(running.port, &token);
        }
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
    fn the_info_file_has_port_token_pid_and_start() {
        let v: serde_json::Value = serde_json::from_str(&info_json(53211, &"ab".repeat(32), 4242, "2026-10-18T10:00:00+00:00")).unwrap();
        assert_eq!(v["port"], 53211);
        assert_eq!(v["token"], "ab".repeat(32));
        assert_eq!(v["pid"], 4242);
        assert_eq!(v["started"], "2026-10-18T10:00:00+00:00");
        assert_eq!(v.as_object().unwrap().len(), 4);
        // written at start with the log line, removed with the app's end, 0600 where there are modes
        let src = include_str!("mod.rs");
        assert!(src.contains("write_info(running.port, &token);") && src.contains("remove_info();") && src.contains("o.mode(0o600)"));
    }

    /// W9.4: the file is created empty, protected, and only then filled; a file that a killed run left behind is protected before it is rewritten.
    #[test]
    fn the_info_file_is_protected_before_the_token_goes_in_and_a_left_over_one_is_rewritten() {
        let src = include_str!("mod.rs");
        let w = &src[src.find("fn write_protected").unwrap()..];
        let w = &w[..w.find("\n}\n").unwrap()];
        assert!(w.find("acl::owner_only(path)?;").unwrap() < w.find("f.set_len(0)").unwrap(), "{w}");
        assert!(w.find("f.set_len(0)").unwrap() < w.find("write_all").unwrap(), "{w}");
        assert!(!w.contains("truncate(true)"), "opening must not empty a file before it is protected: {w}");
        let dir = std::env::temp_dir().join(format!("hey-look-bridge-info-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(INFO_FILE);
        std::fs::write(&p, "old token that a killed run left behind, longer than the new text").unwrap();
        write_protected(&p, "{\"new\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"new\":1}");
        #[cfg(windows)]
        assert_eq!(acl::describe(&p).unwrap(), (1, true, true));
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn the_log_line_has_the_documented_shape() {
        let src = include_str!("mod.rs");
        assert!(src.contains("test bridge: listening on 127.0.0.1:{}, token {token}"));
        // the only place that logs is `start`, and it returns before that when the bridge is off
        assert!(src.contains("let Some(port) = requested() else { return };"));
    }
}
