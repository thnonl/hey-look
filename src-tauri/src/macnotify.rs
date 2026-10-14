//! macOS notification diagnostic (hidden, debug builds only). Shipped behaviour is unchanged: "Send test" says notifications are
//! not available on macOS, and nothing here runs unless the environment variable `HEYLOOK_MAC_NOTIFY` is set in a debug build.
//!
//! Why: the plugin's backend (notify-rust -> mac-notification-sys) uses the deprecated NSUserNotificationCenter, which shows nothing
//! for an ad-hoc signed app on current macOS (QA BUG-M5), and `osascript` shows a notification as "Script Editor". The Mac QA
//! session sets the variable to see which of the two really appears on a MacBook with the unsigned build, and reads the answer in
//! `startup.log`:
//!   `[notify] macos: shown (native)` / `macos: shown (osascript)` / `macos: failed: native: <error>` / `macos: failed: osascript: <error>`
//!
//! Values: `1` native first, osascript only when the native call reports an error; `native`; `osascript`; `both` (both fire, one
//! after the other, each logged: tells "reported ok but nothing appeared" from "appeared"). Anything else (or a release build) = off.

/// Which attempts to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// native, then osascript if native returned an error
    Auto,
    Native,
    Osascript,
    Both,
}

/// The mode for a value of the variable; `debug` is whether this is a debug build. Pure.
pub fn mode_from(debug: bool, var: Option<&str>) -> Option<Mode> {
    if !debug {
        return None;
    }
    match var.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("1") => Some(Mode::Auto),
        Some("native") => Some(Mode::Native),
        Some("osascript") => Some(Mode::Osascript),
        Some("both") => Some(Mode::Both),
        _ => None,
    }
}

/// The diagnostic that is on for this process, if any.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mode() -> Option<Mode> {
    mode_from(cfg!(debug_assertions), std::env::var("HEYLOOK_MAC_NOTIFY").ok().as_deref())
}

/// A string inside an AppleScript double-quoted literal: backslash and double quote escaped, other control characters dropped
/// (a raw line break inside the literal is accepted by AppleScript).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn applescript_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The AppleScript of the fallback: the caller's title, no sound unless the app setting asks for one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn applescript(title: &str, body: &str, sound: &str) -> String {
    let mut s = format!("display notification {} with title {}", applescript_string(body), applescript_string(title));
    if sound != "none" {
        s.push_str(" sound name \"default\"");
    }
    s
}

#[cfg(target_os = "macos")]
fn native(app: &tauri::AppHandle, title: &str, body: &str, sound: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title).body(body);
    if sound != "none" {
        n = n.sound("default");
    }
    n.show().map_err(|e| e.to_string().chars().take(200).collect())
}

#[cfg(target_os = "macos")]
fn osascript(title: &str, body: &str, sound: &str) -> Result<(), String> {
    let out = crate::winproc::hidden("osascript")
        .arg("-e")
        .arg(applescript(title, body, sound))
        .output()
        .map_err(|e| format!("could not start osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect())
    }
}

/// Makes the attempts of `mode`, logs the result of each in startup.log and returns Ok when one reported success (that does not
/// prove that a banner appeared: that is what the person at the Mac reports).
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle, mode: Mode, title: &str, body: &str, sound: &str) -> Result<(), String> {
    use crate::startup::line;
    line("notify", &format!("macos: diagnostic on (HEYLOOK_MAC_NOTIFY, mode {mode:?}), bundle {}", app.config().identifier));
    let mut errors: Vec<String> = vec![];
    let mut shown = false;
    if matches!(mode, Mode::Auto | Mode::Native | Mode::Both) {
        match native(app, title, body, sound) {
            Ok(()) => {
                line("notify", "macos: shown (native)");
                shown = true;
            }
            Err(e) => {
                line("notify", &format!("macos: failed: native: {e}"));
                errors.push(format!("native: {e}"));
            }
        }
    }
    let fallback = match mode {
        Mode::Osascript | Mode::Both => true,
        Mode::Auto => !shown,
        Mode::Native => false,
    };
    if fallback {
        match osascript(title, body, sound) {
            Ok(()) => {
                line("notify", "macos: shown (osascript)");
                shown = true;
            }
            Err(e) => {
                line("notify", &format!("macos: failed: osascript: {e}"));
                errors.push(format!("osascript: {e}"));
            }
        }
    }
    if shown {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_diagnostic_is_off_unless_a_debug_build_is_asked() {
        for v in [None, Some(""), Some("0"), Some("yes"), Some("true")] {
            assert_eq!(mode_from(true, v), None, "{v:?}");
        }
        assert_eq!(mode_from(true, Some("1")), Some(Mode::Auto));
        assert_eq!(mode_from(true, Some(" Native ")), Some(Mode::Native));
        assert_eq!(mode_from(true, Some("osascript")), Some(Mode::Osascript));
        assert_eq!(mode_from(true, Some("BOTH")), Some(Mode::Both));
        // a release build never enables it, whatever the variable says
        for v in [None, Some("1"), Some("both"), Some("osascript")] {
            assert_eq!(mode_from(false, v), None, "{v:?}");
        }
        // and the shipped behaviour is untouched: the honest message stays
        assert!(include_str!("shell.rs").contains("not available on macOS in this version"));
    }

    #[test]
    fn the_applescript_is_escaped_and_silent_unless_a_sound_is_set() {
        assert_eq!(applescript("Hey Look!", "Hello", "none"), "display notification \"Hello\" with title \"Hey Look!\"");
        assert_eq!(applescript("Hey Look!", "Hello", "mail"), "display notification \"Hello\" with title \"Hey Look!\" sound name \"default\"");
        // a subject cannot break out of the string literal
        assert_eq!(applescript_string(r#"say "hi" \ now"#), r#""say \"hi\" \\ now""#);
        assert_eq!(applescript_string("a\u{7}b"), "\"ab\"");
        let evil = applescript("t", "\" & (do shell script \"x\") & \"", "none");
        assert_eq!(evil, "display notification \"\\\" & (do shell script \\\"x\\\") & \\\"\" with title \"t\"");
    }
}
