//! The app could not start at all: `Builder::build()` failed, the window could not be created, or the setup stopped. Until 1.0.6 that
//! ended in a panic with no console (a release build is a Windows GUI program): the person saw nothing, the process just went away.
//!
//! What happens now, in this order, on every system: the reason goes to `startup.log` (in the data folder, also when the data folder
//! was not opened yet: it is worked out from the identifier). On Windows the person then gets a native message box (`MessageBoxW`:
//! there is no page and no dialog plugin yet) that says what failed, where the log is and how to get the Microsoft WebView2 Runtime,
//! and the process ends with exit code 1. The texts are in the language of Windows (the first of its preferred UI languages that the
//! app has, else English): the app's own language setting lives in a database that has not been opened at this point. macOS and Linux
//! keep what they did (the panic, with its message on stderr) and only gain the line in `startup.log`.
//!
//! Three doors lead here: the WebView2 Runtime check before the builder (so Tauri's own English box is not shown first), the result of
//! `Builder::build()`, and a panic hook for Tauri's `Failed to setup app: ...` (the window of the config is created in that step, and
//! so is our own setup closure). Debug builds can force each one with `HEYLOOK_TEST_START_FAIL=webview2|build|setup` and pick the
//! language with `HEYLOOK_TEST_UI_LANG=<tag>`; release builds read neither.
use crate::i18n::{self, Lang, K};
use std::path::{Path, PathBuf};

/// Exit code of a start that failed (the same on every system).
pub const EXIT_CODE: i32 = 1;

/// The first language of the list (Windows' preferred UI languages, best first, as `de-DE`, `zh-Hans-CN`, `en-US`) that the app has.
/// English in the list ends the walk (it is a language the app has); a list with none of ours is English.
pub fn language_from(tags: &[String]) -> Lang {
    for tag in tags {
        let l = i18n::parse(tag);
        if l != Lang::En {
            return l;
        }
        if tag.trim().to_ascii_lowercase().replace('_', "-").split('-').next() == Some("en") {
            return Lang::En;
        }
    }
    Lang::En
}

/// Title and text of the message box. The text ends with the log file's path when it is known.
pub fn message_in(l: Lang, log: Option<&Path>) -> (String, String) {
    let mut body = i18n::tr_in(l, K::StartFailBody).to_string();
    if let Some(p) = log {
        body.push_str(&format!("\n\n{}\n{}", i18n::tr_in(l, K::LoadFailLog), p.display()));
    }
    (i18n::tr_in(l, K::StartFailTitle).to_string(), body)
}

/// The folder the app needs and cannot use, and what the system said about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileProblem {
    pub folder: PathBuf,
    pub error: String,
}

/// Can the app use this data folder? It must be a folder (or be creatable as one) and a file must be writable in it. `None` = usable.
/// This is what tells a damaged profile (a file where the folder should be, no write permission, a full or read-only disk) from a missing
/// WebView2 Runtime: both end in "the window could not be created", but only the second is cured by installing the runtime.
pub fn profile_problem(dir: &Path) -> Option<ProfileProblem> {
    let fail = |e: String| Some(ProfileProblem { folder: dir.to_path_buf(), error: e });
    match std::fs::metadata(dir) {
        Ok(m) if !m.is_dir() => return fail("a file with this name exists where the folder should be".to_string()),
        Ok(_) => {}
        Err(_) => {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return fail(e.to_string());
            }
        }
    }
    let probe = dir.join(format!(".write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"x") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            None
        }
        Err(e) => fail(e.to_string()),
    }
}

/// The folders to check, in order: the app's data folder (settings, mail database, log) and, on Windows, the folder of the web view's
/// user data (`%LOCALAPPDATA%\<identifier>`; a package keeps both in its own folder, already covered by the first).
fn profile_folders() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = log_dir().into_iter().collect();
    if cfg!(windows) && crate::pkg::dirs().is_none() {
        if let Some(l) = std::env::var_os("LOCALAPPDATA").filter(|l| !l.is_empty()) {
            v.push(PathBuf::from(l).join(crate::identity::identifier()));
        }
    }
    v
}

/// Which text to show: the data folder's (with the folder and the system's words) when it is the known cause and the runtime is there,
/// else the WebView2 text, as before.
pub fn message_for(l: Lang, log: Option<&Path>, runtime_missing: bool, problem: Option<&ProfileProblem>) -> (String, String) {
    match problem {
        Some(p) if !runtime_missing => (
            i18n::tr_in(l, K::StartFailTitle).to_string(),
            format!("{}\n\n{}\n{}\n\n{}\n{}", i18n::tr_in(l, K::StartFailProfile), i18n::tr_in(l, K::StartFailFolder), p.folder.display(), i18n::tr_in(l, K::StartFailSaid), p.error),
        ),
        _ => message_in(l, log),
    }
}

/// Where `startup.log` of this run is (or will be) when no `AppHandle` exists yet, from the identifier and the environment (`env` is
/// `std::env::var` in the app): the folder the app's setup opens later, so the person finds one log, not two.
pub fn data_folder_for(identifier: &str, os: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let non_empty = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    let base = match os {
        "windows" => PathBuf::from(non_empty("APPDATA")?),
        "macos" => PathBuf::from(non_empty("HOME")?).join("Library").join("Application Support"),
        _ => match non_empty("XDG_DATA_HOME") {
            Some(x) => PathBuf::from(x),
            None => PathBuf::from(non_empty("HOME")?).join(".local").join("share"),
        },
    };
    Some(base.join(identifier))
}

/// Tauri's message when the step that creates the window (and runs our setup) fails.
pub fn is_setup_panic(message: &str) -> bool {
    message.starts_with("Failed to setup app")
}

/// A debug build's test seam (`HEYLOOK_TEST_START_FAIL`); always None in a release build.
pub fn seam() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("HEYLOOK_TEST_START_FAIL").ok().filter(|v| !v.is_empty()) } else { None }
}

/// The data folder to log into: the real one when it is known already (the setup ran), else worked out. A debug build on a test data
/// folder (`HEYLOOK_DATA_DIR`) writes there, like its setup does.
fn log_dir() -> Option<PathBuf> {
    if let Some(d) = crate::startup::log_dir() {
        return Some(d);
    }
    // a package keeps its data (and so its log) in its own folder
    if let Some(d) = crate::pkg::dirs() {
        return Some(d.local_state.clone());
    }
    if let Some(d) = crate::legacy_names::test_data_dir() {
        return Some(d);
    }
    data_folder_for(crate::identity::identifier(), std::env::consts::OS, &|k| std::env::var(k).ok())
}

/// Writes the reason to `startup.log` (creating the folder if needed) and returns the log's path.
pub fn record(what: &str) -> Option<PathBuf> {
    let dir = log_dir();
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
        crate::startup::init_log_dir(d.clone()); // (also writes what was waiting for the folder)
    }
    crate::startup::line("fatal", &format!("the app could not start: {what}"));
    dir.map(|d| d.join("startup.log"))
}

/// The app cannot go on. Logs the reason; on Windows shows the message box and ends the process with `EXIT_CODE` (does not return);
/// elsewhere returns, and the caller does what it always did (a panic).
pub fn fail_start(what: &str) {
    static ONCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if ONCE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let log = record(what);
    #[cfg(windows)]
    {
        let (lang, tags) = windows_language();
        crate::startup::line("fatal", &format!("the message is shown in {lang:?} (Windows UI languages: {tags:?})"));
        let runtime_missing = webview_runtime_missing();
        let problem = if runtime_missing { None } else { profile_folders().iter().find_map(|d| profile_problem(d)) };
        if let Some(p) = &problem {
            crate::startup::line("fatal", &format!("the data folder cannot be used: {} ({})", p.folder.display(), p.error));
        }
        let (title, body) = message_for(lang, log.as_deref(), runtime_missing, problem.as_ref());
        show_box(&title, &body);
        crate::startup::line("fatal", &format!("error message shown, ending with exit code {EXIT_CODE}"));
        std::process::exit(EXIT_CODE);
    }
    #[cfg(not(windows))]
    let _ = log;
}

/// Hook for `Failed to setup app: ...` (Tauri creates the window of the config and then runs our setup in one step, in the event loop).
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let text = info
            .payload()
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        if is_setup_panic(&text) {
            fail_start(&text);
        }
        prev(info);
    }));
}

/// Is the Microsoft WebView2 Runtime missing? (The same question Tauri asks on Windows; asked here first so that the person gets the
/// translated message, not Tauri's English one.) A debug build can say yes with `HEYLOOK_TEST_START_FAIL=webview2`.
pub fn webview_runtime_missing() -> bool {
    seam().as_deref() == Some("webview2") || (cfg!(windows) && tauri::webview_version().is_err())
}

#[cfg(windows)]
fn windows_language() -> (Lang, Vec<String>) {
    if cfg!(debug_assertions) {
        if let Ok(tag) = std::env::var("HEYLOOK_TEST_UI_LANG") {
            return (language_from(std::slice::from_ref(&tag)), vec![tag]);
        }
    }
    let tags = ui_languages();
    (language_from(&tags), tags)
}

/// The preferred UI languages of the user, best first (`GetUserPreferredUILanguages`), empty when Windows does not say.
#[cfg(windows)]
fn ui_languages() -> Vec<String> {
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: the documented two-call form: the first call only asks for the buffer size (in UTF-16 units, with the closing NULs)
    unsafe {
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut len).is_err() || len == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u16; len as usize];
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut len).is_err() {
            return Vec::new();
        }
        buf.truncate(len as usize);
        buf.split(|c| *c == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
    }
}

#[cfg(windows)]
fn show_box(title: &str, body: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
    let (t, b) = (HSTRING::from(title), HSTRING::from(body));
    // SAFETY: two valid, NUL-terminated UTF-16 strings that live until the call returns; no owner window
    unsafe {
        MessageBoxW(None, &b, &t, MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_windows_ui_language_picks_one_of_the_eight() {
        for (tag, want) in [
            ("en-US", Lang::En),
            ("vi-VN", Lang::Vi),
            ("fr-FR", Lang::Fr),
            ("fr-CA", Lang::Fr),
            ("zh-Hans-CN", Lang::ZhHans),
            ("zh-CN", Lang::ZhHans),
            ("es-ES", Lang::Es),
            ("es-MX", Lang::Es),
            ("ja-JP", Lang::Ja),
            ("de-DE", Lang::De),
            ("de-AT", Lang::De),
            ("ru-RU", Lang::Ru),
        ] {
            assert_eq!(language_from(&tags(&[tag])), want, "{tag}");
        }
    }

    #[test]
    fn the_first_language_the_app_has_wins_and_english_ends_the_walk() {
        assert_eq!(language_from(&tags(&["ko-KR", "de-DE", "en-US"])), Lang::De, "Korean is not offered: the next one the person has");
        assert_eq!(language_from(&tags(&["en-GB", "fr-FR"])), Lang::En, "English first: English");
        assert_eq!(language_from(&tags(&["zh-Hant-TW", "ja-JP"])), Lang::Ja, "Traditional Chinese is not Simplified");
        assert_eq!(language_from(&tags(&["pt-BR", "ar-SA"])), Lang::En, "none of ours: English");
        assert_eq!(language_from(&[]), Lang::En, "Windows did not say: English");
        assert_eq!(language_from(&tags(&["", "ru"])), Lang::Ru);
    }

    #[test]
    fn the_message_says_what_failed_where_the_log_is_and_how_to_get_the_runtime_in_every_language() {
        let log = Path::new("C:\\Users\\Someone\\AppData\\Roaming\\thnonl.heylook\\startup.log");
        let mut seen = std::collections::HashSet::new();
        for l in i18n::LANGS {
            let (title, body) = message_in(l, Some(log));
            assert!(title.contains("Hey Look!"), "{l:?}: {title}");
            assert!(body.contains("WebView2"), "{l:?}: names the part to install");
            assert!(body.contains("https://developer.microsoft.com/microsoft-edge/webview2/"), "{l:?}: where to get it");
            assert!(body.ends_with(&log.display().to_string()), "{l:?}: the log path closes the text");
            assert!(body.contains(i18n::tr_in(l, K::LoadFailLog)), "{l:?}: and is introduced");
            assert!(body.contains("\n\n"), "{l:?}: paragraphs");
            assert!(!body.contains("panic") && !body.contains("HRESULT") && !body.contains("Builder"), "{l:?}: no jargon");
            assert!(seen.insert(body), "{l:?}: its own text");
        }
        assert_eq!(seen.len(), 8);
    }

    #[test]
    fn english_is_the_fallback_text_and_a_missing_log_path_is_left_out() {
        let (title, body) = message_in(language_from(&tags(&["sv-SE"])), None);
        assert_eq!(title, "Hey Look! could not start");
        assert!(body.starts_with("Hey Look! could not start because its window could not be created."));
        assert!(!body.contains("Log file:"));
        assert_eq!(i18n::en(K::StartFailTitle), title);
    }

    #[test]
    fn the_log_folder_is_the_one_the_setup_opens_later() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(
            data_folder_for("thnonl.heylook", "windows", &env(&[("APPDATA", "C:\\Users\\A\\AppData\\Roaming")])),
            Some(PathBuf::from("C:\\Users\\A\\AppData\\Roaming").join("thnonl.heylook"))
        );
        assert_eq!(data_folder_for("thnonl.heylook", "macos", &env(&[("HOME", "/Users/a")])), Some(PathBuf::from("/Users/a/Library/Application Support/thnonl.heylook")));
        assert_eq!(data_folder_for("thnonl.heylook", "linux", &env(&[("HOME", "/home/a")])), Some(PathBuf::from("/home/a/.local/share/thnonl.heylook")));
        assert_eq!(data_folder_for("thnonl.heylook", "linux", &env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/data")])), Some(PathBuf::from("/data/thnonl.heylook")));
        assert_eq!(data_folder_for("thnonl.heylook", "windows", &env(&[])), None);
        assert_eq!(data_folder_for("thnonl.heylook", "windows", &env(&[("APPDATA", "  ")])), None);
    }

    #[test]
    fn only_taurys_setup_failure_triggers_the_hook() {
        assert!(is_setup_panic("Failed to setup app: error encountered during setup hook: no such table"));
        assert!(is_setup_panic("Failed to setup app: WebviewRuntimeNotInstalled"));
        assert!(!is_setup_panic("called `Option::unwrap()` on a `None` value"));
        assert!(!is_setup_panic("index out of bounds: the len is 3 but the index is 5"));
        assert!(!is_setup_panic("thread panicked: Failed to setup app")); // only the message that starts with it
    }

    #[test]
    fn an_unusable_data_folder_is_named_and_a_missing_runtime_keeps_its_text() {
        let base = std::env::temp_dir().join(format!("hl-startfail-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        // a usable folder (made on the way) is no problem
        assert_eq!(profile_problem(&base.join("ok").join("deeper")), None);
        // a FILE where the folder should be (the case of the QA sandbox): the cause is known, the folder is named
        let file = base.join("is-a-file");
        std::fs::write(&file, b"x").unwrap();
        let p = profile_problem(&file).expect("a file is not a folder");
        assert_eq!(p.folder, file);
        assert!(p.error.contains("file"), "{}", p.error);
        // a folder below a file cannot be created either
        let below = file.join("sub");
        assert!(profile_problem(&below).is_some());
        // the decision, in every language: the folder and the error are in the text, no WebView2 words
        for l in i18n::LANGS {
            let (title, body) = message_for(l, None, false, Some(&p));
            assert_eq!(title, i18n::tr_in(l, K::StartFailTitle));
            assert!(body.contains(&file.display().to_string()) && body.contains(&p.error), "{l:?}: {body}");
            assert!(!body.contains("WebView2"), "{l:?}: {body}");
            // no problem found, or the runtime is missing: the old text with the log
            let log = Path::new("C:\\x\\startup.log");
            assert_eq!(message_for(l, Some(log), false, None), message_in(l, Some(log)));
            assert_eq!(message_for(l, Some(log), true, Some(&p)), message_in(l, Some(log)), "{l:?}: a missing runtime wins");
        }
    }

    #[test]
    fn the_seam_is_a_debug_build_thing() {
        // (the variable itself is not set in unit tests; what this pins is that release builds cannot read it)
        if !cfg!(debug_assertions) {
            assert_eq!(seam(), None);
        }
    }
}
