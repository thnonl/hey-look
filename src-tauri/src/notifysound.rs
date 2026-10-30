//! The new-mail sound (1.0.7 W13.8): one Hey Look! sound ("10-pop", `sounds/new-mail.wav`, made by `scripts/gen-notify-sound.mjs`) with an on / off switch
//! (`prefs.notifySound` = "pop" | "none", per mailbox) and a preview button.
//!
//! When it plays (REQ-13.8.2 to 13.8.4): once per batch of new mail that makes a notification decision (`shell::notify_new` has already left out own and moved
//! mail: `newmail::counts_as_new`), when the sound is on for at least one mailbox of the batch, at most once every 3 s for the whole app, and not when the app
//! would not show the notification (paused, switched off, the window in front) or the OS says it must not disturb (Windows: `SHQueryUserNotificationState`).
//! The preview ignores all of that.
//!
//! How it plays, per OS (REQ-13.8.6):
//!   - Windows: the toast is silent (a custom `<audio src="file:///...">` is not supported for an unpackaged desktop app: Windows keeps to its own `ms-winsoundevent`
//!     sounds there, so no Hey Look! sound can be given through the toast) and the app plays the embedded WAV with `PlaySoundW(SND_MEMORY | SND_ASYNC | SND_NODEFAULT)`
//!     when Windows accepts notifications (`QUNS_ACCEPTS_NOTIFICATIONS`: not presentation mode, no full-screen app, not quiet time / Focus / Do not disturb) and the
//!     toast notifier of the app is enabled.
//!   - macOS: the notification is silent (macnotify.rs) and the app plays the sound, so it is also heard when the banners are off: `NSSound` from the embedded bytes, on the main thread.
//!   - Linux: the notification carries the hints `sound-file` and `sound-name`; a notification server without the capability "sound" does not play it, then the app
//!     plays the file with the first of `pw-play`, `paplay`, `aplay` found in PATH (no shell, the path as one argument).
//! The decisions (on / off, throttle, which player, the file on disk) are plain functions below, with tests; the calls into the OS are small.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The sound, byte for byte the approved sample (REQ-13.8.7).
pub static SOUND: &[u8] = include_bytes!("../sounds/new-mail.wav");
/// SHA-256 of the approved sample (spec-107-wp13 W13.8, AC-13.8.10).
#[cfg_attr(not(test), allow(dead_code))]
pub const SOUND_SHA256: &str = "4a9ccd9b2584dbd52773b9557bcd6c9c1ac56e91fa69fc0c0505b92fb292fa4f";
/// At most one sound per this time for the whole app (REQ-13.8.3).
pub const THROTTLE: Duration = Duration::from_secs(3);

/// Is the sound on for a stored `notifySound` value? "none" is Silent (also what 1.0.6 stored); anything else, a missing or an unknown value is on.
pub fn is_on(value: Option<&str>) -> bool {
    value.map_or(true, |v| v != "none")
}

/// Is the sound on for this mailbox (its own value, else the one of "All accounts")?
pub fn on_for(p: &Value, account: &str) -> bool {
    let v = crate::shell::eff(p, account, "notifySound");
    is_on(v.as_ref().and_then(|x| x.as_str()))
}

/// REQ-13.8.2: does a batch of new mail from these mailboxes want the sound? (on for at least one of them)
pub fn batch_wants_sound<'a>(p: &Value, accounts: impl IntoIterator<Item = &'a str>) -> bool {
    accounts.into_iter().any(|a| on_for(p, a))
}

/// The throttle: the time of the last sound that was let through.
pub struct Throttle(Mutex<Option<Instant>>);

impl Throttle {
    pub const fn new() -> Self {
        Throttle(Mutex::new(None))
    }
    /// True (and remembered) when the last sound was at least THROTTLE before `now`, or there was none. Takes the clock as an argument (tests use a fake one).
    pub fn allow_at(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = *last {
            if now.checked_duration_since(t).map_or(true, |d| d < THROTTLE) {
                return false;
            }
        }
        *last = Some(now);
        true
    }
}

static GLOBAL: Throttle = Throttle::new();

/// Claims the next sound of the app: false when one played less than 3 s ago.
pub fn claim() -> bool {
    GLOBAL.allow_at(Instant::now())
}

/// Where the sound is kept on disk for the systems that need a path (the Linux hint and the players): `<data>/sounds/new-mail.wav`.
pub fn sound_path(data: &Path) -> PathBuf {
    data.join("sounds").join("new-mail.wav")
}

/// The file with the embedded bytes, written when it is missing or differs (size and hash are checked), so an updated app replaces an older sound. Returns its path.
pub fn materialise(data: &Path) -> std::io::Result<PathBuf> {
    let path = sound_path(data);
    if let Ok(have) = std::fs::read(&path) {
        if have.len() == SOUND.len() && Sha256::digest(&have)[..] == Sha256::digest(SOUND)[..] {
            return Ok(path);
        }
    }
    std::fs::create_dir_all(path.parent().unwrap_or(data))?;
    let tmp = path.with_extension("wav.part");
    std::fs::write(&tmp, SOUND)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// The players tried on Linux, in this order (REQ-13.8.6).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PLAYERS: [&str; 3] = ["pw-play", "paplay", "aplay"];

/// The first player that is a file in one of the folders of `path_var` (the value of PATH).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn find_player(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    for name in PLAYERS {
        for dir in std::env::split_paths(path_var) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Linux: what carries the sound for a notification server that lists these capabilities (REQ-13.8.6).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Carrier {
    /// the notification has the hints `sound-file` and `sound-name`
    Server,
    /// the server does not play sounds: the app plays the file
    Player,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn carrier(capabilities: &[String]) -> Carrier {
    if capabilities.iter().any(|c| c == "sound") { Carrier::Server } else { Carrier::Player }
}

/// The data folder of the app, where the sound file lives.
fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.try_state::<crate::legacy_names::DataDir>().map(|d| d.0.clone())
}

/// The sound file on disk for this app (written once, then found again). For the OSes that need a path.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn file_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app).ok_or("no data folder")?;
    materialise(&dir).map_err(|e| format!("the sound file could not be written: {e}"))
}

// ---------------------------------------------------------------- Windows

/// Windows: may the app make a sound now? (REQ-13.8.4) The state is read with `SHQueryUserNotificationState`: only `QUNS_ACCEPTS_NOTIFICATIONS` allows it (it reports
/// presentation mode, a full-screen app and quiet time, which is Focus / Do not disturb). The toast notifier of the app must be enabled too. The text says why not.
#[cfg(windows)]
pub fn windows_allows_sound() -> Result<(), String> {
    use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};
    use windows::Win32::UI::Shell::{QUNS_ACCEPTS_NOTIFICATIONS, SHQueryUserNotificationState};
    use windows::core::HSTRING;
    // (a state that cannot be read does not silence the sound)
    if let Ok(state) = unsafe { SHQueryUserNotificationState() } {
        if state != QUNS_ACCEPTS_NOTIFICATIONS {
            return Err(format!("Windows does not accept notifications now (state {})", state.0));
        }
    }
    if let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(crate::identity::aumid())) {
        if let Ok(setting) = notifier.Setting() {
            if setting != NotificationSetting::Enabled {
                return Err(format!("the notifications of the app are not enabled (setting {})", setting.0));
            }
        }
    }
    Ok(())
}

/// Windows: plays the embedded WAV, asynchronously.
#[cfg(windows)]
fn play_windows() -> Result<(), String> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    use windows::core::PCWSTR;
    // SAFETY: with SND_MEMORY the first argument is the address of the WAV image; `SOUND` is static, so it outlives the asynchronous playback.
    let ok = unsafe { PlaySoundW(PCWSTR(SOUND.as_ptr().cast()), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT) };
    if ok.as_bool() { Ok(()) } else { Err("Windows could not play the sound".into()) }
}

// ---------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
static NSSOUND: Mutex<usize> = Mutex::new(0);

/// macOS: plays the embedded WAV with `NSSound` on the main thread (AppKit). One `NSSound` is made on the first use and kept: it is played again, from the start, for every later sound.
#[cfg(target_os = "macos")]
fn play_macos(app: &tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        use std::ffi::c_void;
        let result: Result<(), String> = objc2::rc::autoreleasepool(|_| {
            // SAFETY: plain Objective-C messages to Foundation / AppKit classes on the main thread; every object that comes back is checked for null before it is used.
            unsafe {
                let mut held = NSSOUND.lock().unwrap_or_else(|p| p.into_inner());
                if *held == 0 {
                    let data_class = AnyClass::get(c"NSData").ok_or("no NSData class")?;
                    let sound_class = AnyClass::get(c"NSSound").ok_or("no NSSound class")?;
                    let data: *mut AnyObject = msg_send![data_class, dataWithBytes: SOUND.as_ptr().cast::<c_void>(), length: SOUND.len()];
                    if data.is_null() {
                        return Err("no sound data".to_string());
                    }
                    let alloc: *mut AnyObject = msg_send![sound_class, alloc];
                    let sound: *mut AnyObject = msg_send![alloc, initWithData: data];
                    if sound.is_null() {
                        return Err("NSSound could not read the sound".to_string());
                    }
                    *held = sound as usize;
                }
                let sound = *held as *mut AnyObject;
                let _: Bool = msg_send![sound, stop];
                let started: Bool = msg_send![sound, play];
                if started.as_bool() { Ok(()) } else { Err("NSSound did not start".to_string()) }
            }
        });
        if let Err(e) = result {
            crate::startup::line("notify", &format!("sound: macOS could not play it: {e}"));
        }
    })
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- Linux

/// Linux: plays the file with the first player found in PATH; nothing found = an error (the caller logs it once).
#[cfg(target_os = "linux")]
fn play_linux(app: &tauri::AppHandle) -> Result<(), String> {
    use std::process::Stdio;
    let file = file_for(app)?;
    let path = std::env::var_os("PATH").unwrap_or_default();
    let Some(player) = find_player(&path) else {
        return Err("no sound player (pw-play, paplay, aplay) was found".into());
    };
    let mut child = crate::winproc::hidden(&player.to_string_lossy()).arg(&file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    // (the player ends by itself; the thread only collects it, so no zombie is left)
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Linux: the hints of a notification that carries the sound, when the server plays sounds itself; otherwise the app plays the file at once. `Ok(true)` = the
/// notification carries it (the caller adds the hints), `Ok(false)` = the app plays it.
#[cfg(target_os = "linux")]
pub fn linux_carrier(app: &tauri::AppHandle) -> (Carrier, Option<PathBuf>) {
    let caps = notify_rust::get_capabilities().unwrap_or_default();
    match carrier(&caps) {
        Carrier::Server => match file_for(app) {
            Ok(p) => (Carrier::Server, Some(p)),
            Err(_) => (Carrier::Player, None),
        },
        Carrier::Player => (Carrier::Player, None),
    }
}

/// Linux: plays with a player and logs a missing player once.
#[cfg(target_os = "linux")]
pub fn play_with_player(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if let Err(e) = play_linux(app) {
        if !LOGGED.swap(true, Ordering::Relaxed) {
            crate::startup::line("notify", &format!("sound: skipped ({e})"));
        }
    }
}

// ---------------------------------------------------------------- what the rest of the app calls

/// The sound of a new-mail batch for the systems where the app plays it (Windows, macOS): checks the OS rules, plays, and logs what happened.
/// (Linux: `shell::toast_linux` carries it in the notification.) The throttle was claimed by the caller.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn play_new_mail(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        let _ = app;
        match windows_allows_sound().and_then(|_| play_windows()) {
            Ok(()) => crate::startup::line("notify", "sound: played"),
            Err(e) => crate::startup::line("notify", &format!("sound: skipped ({e})")),
        }
    }
    #[cfg(target_os = "macos")]
    match play_macos(app) {
        Ok(()) => crate::startup::line("notify", "sound: played"),
        Err(e) => crate::startup::line("notify", &format!("sound: skipped ({e})")),
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
}

/// The preview button (REQ-13.8.1): plays once, switch on or off, whatever the quiet rules say.
pub fn preview(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        return play_windows();
    }
    #[cfg(target_os = "macos")]
    return play_macos(app);
    #[cfg(target_os = "linux")]
    return play_linux(app);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("no sound on this system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("heylook-notifysound-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_embedded_sound_is_the_approved_sample() {
        assert_eq!(SOUND.len(), 30_914);
        let hex: String = Sha256::digest(SOUND).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, SOUND_SHA256, "src-tauri/sounds/new-mail.wav must stay byte for byte the sample the owner chose");
        assert_eq!(&SOUND[0..4], b"RIFF");
        assert_eq!(&SOUND[8..12], b"WAVE");
    }

    #[test]
    fn the_sound_plays_once_per_batch_and_at_most_every_three_seconds() {
        let t = Throttle::new();
        let t0 = Instant::now();
        assert!(t.allow_at(t0), "the first one plays");
        assert!(!t.allow_at(t0), "the same moment: a second mailbox of the same round does not play");
        assert!(!t.allow_at(t0 + Duration::from_millis(2_999)), "an IDLE push right after a poll");
        assert!(t.allow_at(t0 + Duration::from_secs(3)), "3 s later it plays again");
        assert!(!t.allow_at(t0 + Duration::from_secs(4)), "the 3 s count from the last sound that played, not from the first");
        assert!(t.allow_at(t0 + Duration::from_secs(6)));
        // a clock that went back is a closed gate, not a panic
        assert!(!t.allow_at(t0));
    }

    #[test]
    fn a_silent_mailbox_makes_no_sound_but_another_does() {
        // "All accounts" on, mailbox A silent: a batch of A only is silent, a batch with B plays
        let p = json!({ "notifySound": "pop", "accountPrefs": { "A": { "notifySound": "none" } } });
        assert!(!batch_wants_sound(&p, ["A"]));
        assert!(batch_wants_sound(&p, ["B"]));
        assert!(batch_wants_sound(&p, ["A", "B"]), "one mailbox that wants it is enough");
        // "All accounts" off, mailbox B on
        let p = json!({ "notifySound": "none", "accountPrefs": { "B": { "notifySound": "pop" } } });
        assert!(!batch_wants_sound(&p, ["A"]));
        assert!(batch_wants_sound(&p, ["B"]));
        // 1.0.6 stored values: Silent stays silent, every other choice is on, nothing stored is on
        assert!(!is_on(Some("none")));
        for old in ["mail", "default", "im", "reminder", "sms", "pop", "", "something else"] {
            assert!(is_on(Some(old)), "{old}");
        }
        assert!(is_on(None));
        assert!(batch_wants_sound(&json!({}), ["A"]), "no preferences stored yet: on");
        assert!(batch_wants_sound(&Value::Null, ["A"]));
        assert!(!batch_wants_sound(&json!({ "notifySound": "none" }), Vec::<&str>::new()), "an empty batch makes no sound");
    }

    #[test]
    fn own_and_moved_mail_make_no_sound() {
        // the batch the sound looks at is the one `shell::notify_new` gets: only mail that `newmail::counts_as_new` accepts. Own mail (From = a mailbox) and moved mail are not in it.
        use crate::newmail::{counts_as_new, own_set};
        let own = own_set(["me@x.test"]);
        assert!(counts_as_new("inbox", false, false, "ann@x.test", &own, false), "a new mail from somebody else counts");
        assert!(!counts_as_new("inbox", false, false, "ME@x.test", &own, false), "a mail from one's own address: no notification, no sound");
        assert!(!counts_as_new("inbox", false, false, "ann@x.test", &own, true), "a moved mail: no notification, no sound");
        assert!(!counts_as_new("inbox", true, false, "ann@x.test", &own, false), "the first sync of a mailbox: no sound");
        assert!(!counts_as_new("sent", false, false, "ann@x.test", &own, false));
        // the batch that remains empty asks for no sound at all
        let p = json!({ "notifySound": "pop" });
        let batch: Vec<&str> = vec![];
        assert!(!batch_wants_sound(&p, batch));
    }

    #[test]
    fn the_sound_file_is_written_once_and_matches_the_embedded_bytes() {
        let dir = temp("file");
        let path = sound_path(&dir);
        assert_eq!(path, dir.join("sounds").join("new-mail.wav"));
        let _ = std::fs::remove_file(&path);
        assert_eq!(materialise(&dir).unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), SOUND, "the bytes on disk are the embedded ones");
        // a second call leaves the file alone (same modification time)
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(30));
        materialise(&dir).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before, "not written again");
        // an older or damaged file is replaced
        std::fs::write(&path, b"old sound").unwrap();
        materialise(&dir).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), SOUND);
        let mut changed = SOUND.to_vec();
        changed[100] ^= 0xff;
        std::fs::write(&path, &changed).unwrap();
        materialise(&dir).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), SOUND, "same size but another hash: replaced");
    }

    #[test]
    fn the_player_is_the_first_of_pw_play_paplay_aplay_found_in_path() {
        let a = temp("players-a");
        let b = temp("players-b");
        for n in PLAYERS {
            let _ = std::fs::remove_file(a.join(n));
            let _ = std::fs::remove_file(b.join(n));
        }
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_player(&path), None, "none installed: the sound is skipped");
        std::fs::write(b.join("aplay"), b"").unwrap();
        assert_eq!(find_player(&path), Some(b.join("aplay")));
        std::fs::write(a.join("paplay"), b"").unwrap();
        assert_eq!(find_player(&path), Some(a.join("paplay")), "paplay comes before aplay, wherever it is in PATH");
        std::fs::write(b.join("pw-play"), b"").unwrap();
        assert_eq!(find_player(&path), Some(b.join("pw-play")), "pw-play first");
        let _ = std::fs::remove_file(a.join("paplay"));
        let _ = std::fs::remove_file(b.join("aplay"));
        let _ = std::fs::remove_file(b.join("pw-play"));
    }

    #[test]
    fn a_notification_server_that_lists_sound_carries_it_otherwise_the_app_plays_it() {
        let caps = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(carrier(&caps(&["actions", "body", "sound"])), Carrier::Server);
        assert_eq!(carrier(&caps(&["actions", "body"])), Carrier::Player, "GNOME Shell lists no sound: the app plays it");
        assert_eq!(carrier(&[]), Carrier::Player, "a server that cannot be asked: the app plays it");
    }

    #[test]
    fn the_sources_keep_the_wiring_the_spec_asks_for() {
        let shell = include_str!("shell.rs");
        let body = &shell[shell.find("pub fn notify_new(").unwrap()..shell.find("fn notify_actions_for(").unwrap()];
        assert!(body.contains("notifysound::batch_wants_sound") && body.contains("notifysound::claim()"), "one decision and one throttle claim per batch");
        assert!(body.contains("first_pop"), "only the first notification of a batch carries the sound");
        let lib = include_str!("lib.rs");
        assert!(lib.contains("fn play_notify_sound(") && lib.contains("notifysound::preview"), "the preview command");
    }
}
