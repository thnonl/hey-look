//! Linux: open a link or a file with the desktop's default program, and say so when nothing could.
//!
//! The opener plugin (the `open` crate) starts the first launcher that exists, detached, and reports success as soon as that
//! process was started, never what it did. So `xdg-open` exiting with "no handler" was silent, and under WSL the first launcher
//! is `powershell.exe`, which always starts. Here every launcher is waited for: an exit with status 0, or a launcher that is still
//! running after a few seconds (a program that was started and stays open), counts as opened; anything else goes on to the next
//! launcher, and when none worked the caller gets an error to show.
//!
//! The launchers are started with a clean environment: inside an AppImage the app's own library, plugin and data paths
//! (`APPDIR`, `LD_LIBRARY_PATH`, `GIO_EXTRA_MODULES`, `XDG_DATA_DIRS` ...) point into the mounted image and break a browser or
//! `xdg-open` that is started with them.
//!
//! Compiled on every system so that the rules are tested everywhere; only Linux calls `open`.

use std::process::Stdio;
use std::time::{Duration, Instant};

/// How long a launcher may run before it counts as "started and staying open" (a browser that is not running yet).
const WAIT: Duration = Duration::from_secs(4);

/// Same schemes as the opener plugin's `opener:default` permission.
pub fn url_allowed(url: &str) -> bool {
    let u = url.trim();
    if u.chars().any(|c| c.is_control()) {
        return false;
    }
    let lower = u.to_ascii_lowercase();
    ["http://", "https://", "mailto:", "tel:"].iter().any(|s| lower.starts_with(s) && lower.len() > s.len())
}

/// Open a link (`url_allowed`) or an existing file with the default program.
pub fn open(target: &str, is_url: bool) -> Result<(), String> {
    if is_url {
        if !url_allowed(target) {
            return Err("LINK_NOT_OPENED: That kind of link is not opened.".into());
        }
    } else if !std::path::Path::new(target).exists() {
        return Err("FILE_GONE: That file no longer exists.".into());
    }
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let env = clean_env(&vars);
    launch_first(&launchers(target, is_url, on_wsl()), &env, WAIT, is_url)
}

/// WSL runs a Linux userland on Windows: `wslview` (package `wslu`) hands the link to the Windows default program.
fn on_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.to_ascii_lowercase().contains("microsoft")).unwrap_or(false)
}

/// The launchers to try, in order, each as program + arguments. A path that starts with `-` is made relative so that it is not
/// read as an option (`xdg-open` and `gio` have no `--`).
pub fn launchers(target: &str, is_url: bool, wsl: bool) -> Vec<Vec<String>> {
    let safe = if target.starts_with('-') { format!("./{target}") } else { target.to_string() };
    let mut list: Vec<Vec<String>> = vec![];
    if wsl {
        list.push(vec!["wslview".into(), safe.clone()]);
    }
    list.push(vec!["xdg-open".into(), safe.clone()]);
    list.push(vec!["gio".into(), "open".into(), safe.clone()]);
    list.push(vec!["gnome-open".into(), safe.clone()]);
    list.push(vec!["kde-open".into(), "--".into(), target.to_string()]);
    if is_url {
        list.push(vec!["sensible-browser".into(), target.to_string()]);
    }
    list
}

/// One change to the environment of a launcher.
#[derive(Debug, PartialEq, Eq)]
pub enum EnvChange {
    Remove(String),
    Set(String, String),
}

/// What to change in the environment of a launcher so that it does not see the AppImage it was started from. Nothing changes
/// outside an AppImage (`APPDIR` unset), so a deb or rpm install starts its launchers with the unchanged environment.
pub fn clean_env(vars: &[(String, String)]) -> Vec<EnvChange> {
    let Some(appdir) = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.trim_end_matches('/').to_string()).filter(|v| !v.is_empty()) else {
        return vec![];
    };
    let inside = |p: &str| p == appdir || p.strip_prefix(appdir.as_str()).is_some_and(|rest| rest.starts_with('/'));
    let mut out = vec![];
    for (k, v) in vars {
        if matches!(k.as_str(), "APPDIR" | "APPIMAGE" | "ARGV0" | "OWD") {
            out.push(EnvChange::Remove(k.clone()));
        } else if v.contains(':') {
            let all: Vec<&str> = v.split(':').collect();
            let kept: Vec<&str> = all.iter().copied().filter(|p| !inside(p)).collect();
            if kept.len() == all.len() {
                continue;
            }
            let kept: Vec<&str> = kept.into_iter().filter(|p| !p.is_empty()).collect();
            out.push(if kept.is_empty() { EnvChange::Remove(k.clone()) } else { EnvChange::Set(k.clone(), kept.join(":")) });
        } else if inside(v) {
            out.push(EnvChange::Remove(k.clone()));
        }
    }
    out
}

enum Tried {
    NotInstalled,
    Exited(String),
    Opened,
}

fn try_one(argv: &[String], env: &[EnvChange], wait: Duration) -> Tried {
    let Some((program, args)) = argv.split_first() else { return Tried::NotInstalled };
    let mut cmd = crate::winproc::hidden(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for c in env {
        match c {
            EnvChange::Remove(k) => cmd.env_remove(k),
            EnvChange::Set(k, v) => cmd.env(k, v),
        };
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // not part of the app's process group: a closed app does not take the browser with it
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Tried::NotInstalled,
        Err(e) => return Tried::Exited(format!("{program}: {e}")),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Tried::Opened,
            Ok(Some(status)) => {
                return Tried::Exited(match status.code() {
                    Some(c) => format!("{program} exited with status {c}"),
                    None => format!("{program} was stopped"),
                })
            }
            Ok(None) if start.elapsed() >= wait => {
                // still running: it started a program that stays open; reap it later so that no zombie is left
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Tried::Opened;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Tried::Exited(format!("{program}: {e}")),
        }
    }
}

/// Run the launchers in turn until one opens the target.
pub fn launch_first(list: &[Vec<String>], env: &[EnvChange], wait: Duration, is_url: bool) -> Result<(), String> {
    let mut failures: Vec<String> = vec![];
    for argv in list {
        match try_one(argv, env, wait) {
            Tried::Opened => return Ok(()),
            Tried::NotInstalled => {}
            Tried::Exited(why) => failures.push(why),
        }
    }
    let (what, set) = if is_url { ("link", "browser") } else { ("file", "app") };
    Err(if failures.is_empty() {
        format!("Couldn’t find a program to open the {what}. Install xdg-utils and choose a default {set} in your desktop’s settings.")
    } else {
        format!("Your desktop has no default {set} for this {what} ({}). Choose one in your desktop’s settings.", failures.join("; "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A launcher that exits with `code` (an existing program on every system the tests run on).
    fn exits(code: i32) -> Vec<String> {
        if cfg!(windows) { vec!["cmd".into(), "/C".into(), format!("exit {code}")] } else { vec!["sh".into(), "-c".into(), format!("exit {code}")] }
    }

    fn missing() -> Vec<String> {
        vec!["heylook-no-such-launcher-7f3a".into(), "x".into()]
    }

    #[test]
    fn only_web_mail_and_phone_links_are_opened() {
        for ok in ["https://example.com/a?b=1", "http://127.0.0.1:9/x", "HTTPS://EXAMPLE.COM", "mailto:a@b.c?subject=hi", "tel:+4930123"] {
            assert!(url_allowed(ok), "{ok}");
        }
        for bad in ["", "https://", "file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "-o", "--help", "https://a.b/\nx", "data:text/html,x"] {
            assert!(!url_allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn launchers_are_tried_in_a_fixed_order_and_a_dash_is_not_an_option() {
        let names = |l: &[Vec<String>]| l.iter().map(|a| a[0].clone()).collect::<Vec<_>>();
        assert_eq!(names(&launchers("https://x.y", true, false)), ["xdg-open", "gio", "gnome-open", "kde-open", "sensible-browser"]);
        assert_eq!(names(&launchers("/tmp/a.pdf", false, false)), ["xdg-open", "gio", "gnome-open", "kde-open"], "no browser launcher for a file");
        assert_eq!(names(&launchers("https://x.y", true, true))[0], "wslview", "under WSL the Windows default program comes first");
        let l = launchers("-x.pdf", false, false);
        assert_eq!(l[0], ["xdg-open", "./-x.pdf"]);
        assert_eq!(l[1], ["gio", "open", "./-x.pdf"]);
        assert_eq!(l[3], ["kde-open", "--", "-x.pdf"]);
    }

    #[test]
    fn nothing_changes_outside_an_appimage() {
        assert!(clean_env(&v(&[("PATH", "/usr/bin:/bin"), ("LD_LIBRARY_PATH", "/opt/x/lib")])).is_empty());
        assert!(clean_env(&v(&[("APPDIR", "")])).is_empty());
    }

    #[test]
    fn an_appimage_environment_is_cleaned_for_the_launcher() {
        let m = "/tmp/.mount_HeyLooAbCd";
        let env = clean_env(&v(&[
            ("APPDIR", m),
            ("APPIMAGE", "/home/u/Hey Look!.AppImage"),
            ("ARGV0", "./Hey Look!.AppImage"),
            ("OWD", "/home/u"),
            ("PATH", &format!("{m}/usr/bin:{m}/usr/sbin:/usr/local/bin:/usr/bin")),
            ("LD_LIBRARY_PATH", &format!("{m}/usr/lib:{m}/usr/lib/x86_64-linux-gnu")),
            ("XDG_DATA_DIRS", &format!("{m}/usr/share/:/usr/local/share:/usr/share")),
            ("GDK_PIXBUF_MODULE_FILE", &format!("{m}/usr/lib/loaders.cache")),
            ("GSETTINGS_SCHEMA_DIR", &format!("{m}/usr/share/glib-2.0/schemas")),
            ("HOME", "/home/u"),
            ("MOUNT_LIKE", &format!("{m}-other/lib")), // a sibling folder whose name only starts the same
            ("DISPLAY", ":0"),
            ("LANG", "en_US.UTF-8"),
        ]));
        let set = |k: &str| env.iter().find_map(|c| match c { EnvChange::Set(n, v) if n == k => Some(v.as_str()), _ => None });
        let removed = |k: &str| env.contains(&EnvChange::Remove(k.into()));
        for k in ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "GDK_PIXBUF_MODULE_FILE", "GSETTINGS_SCHEMA_DIR"] {
            assert!(removed(k), "{k}");
        }
        assert_eq!(set("PATH"), Some("/usr/local/bin:/usr/bin"));
        assert_eq!(set("XDG_DATA_DIRS"), Some("/usr/local/share:/usr/share"));
        for k in ["HOME", "MOUNT_LIKE", "DISPLAY", "LANG"] {
            assert!(!removed(k) && set(k).is_none(), "{k} stays as it is");
        }
    }

    #[test]
    fn a_launcher_that_is_missing_or_fails_hands_over_to_the_next() {
        assert!(launch_first(&[missing(), exits(3), exits(0)], &[], Duration::from_secs(5), true).is_ok());
        assert!(launch_first(&[exits(0), exits(3)], &[], Duration::from_secs(5), true).is_ok(), "the first success ends it");
    }

    #[test]
    fn when_no_launcher_works_the_error_says_what_happened() {
        let e = launch_first(&[missing(), exits(3)], &[], Duration::from_secs(5), true).unwrap_err();
        assert!(e.contains("no default browser") && e.contains("link") && e.contains("exited with status 3"), "{e}");
        let e = launch_first(&[missing()], &[], Duration::from_secs(5), false).unwrap_err();
        assert!(e.contains("Couldn’t find a program to open the file") && e.contains("xdg-utils"), "{e}");
        assert!(launch_first(&[], &[], Duration::from_secs(1), true).is_err(), "never a silent success");
    }

    #[test]
    fn a_launcher_that_keeps_running_counts_as_started() {
        let slow = if cfg!(windows) { vec!["ping".into(), "-n".into(), "4".into(), "127.0.0.1".into()] } else { vec!["sleep".into(), "3".into()] };
        let t = Instant::now();
        assert!(launch_first(&[slow], &[], Duration::from_millis(300), true).is_ok());
        assert!(t.elapsed() < Duration::from_secs(2), "does not wait for the program to end");
    }

    #[test]
    fn the_launcher_gets_the_changed_environment() {
        let probe = |expect_set: bool| {
            if cfg!(windows) {
                vec!["cmd".into(), "/C".into(), format!("if defined HEYLOOK_OPEN_PROBE (exit {}) else (exit {})", if expect_set { 0 } else { 1 }, if expect_set { 1 } else { 0 })]
            } else {
                vec!["sh".into(), "-c".into(), format!("test -{} \"$HEYLOOK_OPEN_PROBE\"", if expect_set { 'n' } else { 'z' })]
            }
        };
        let set = [EnvChange::Set("HEYLOOK_OPEN_PROBE".into(), "1".into())];
        assert!(launch_first(&[probe(true)], &set, Duration::from_secs(5), true).is_ok());
        assert!(launch_first(&[probe(true)], &[], Duration::from_secs(5), true).is_err());
        assert!(launch_first(&[probe(false)], &[], Duration::from_secs(5), true).is_ok());
    }

    #[test]
    fn open_checks_the_target_before_any_launcher_starts() {
        assert_eq!(open("file:///etc/passwd", true).unwrap_err(), "LINK_NOT_OPENED: That kind of link is not opened.");
        assert_eq!(open("/no/such/dir/heylook-x.pdf", false).unwrap_err(), "FILE_GONE: That file no longer exists.");
    }
}
