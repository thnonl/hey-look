//! The autostart entry and the tray start (1.0.9, owner: "the all-white window still happens when the app starts automatically with Windows. I think
//! autostart should start the app in tray mode").
//!
//! What was already true (read from the code and from a real logon of the owner's 1.0.8, see coder-v109-autostart-tray.md): the entry the app registers
//! (`tauri-plugin-autostart`, `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value "Hey Look!") has carried `--minimized` since 1.0.0, a start with that
//! flag makes no window until the desktop is ready (`startgate.rs`) and then keeps it hidden until a person asks for it (tray click, tray menu, a second start, a
//! notification: `shell::show_main`). So the autostart already IS a tray start. What this file adds are the holes around it:
//!
//! 1. The entry is looked after. The plugin writes `<path> --minimized` with an unquoted path and never looks at the value again (`is_enabled` only asks
//!    whether a value of that name exists). `ensure_entry` reads our own entry at every start (Windows) and writes it again, in the form
//!    `"<path>" --minimized`, when it is this program's entry and differs (flag missing, path not quoted). It touches nothing else: not another program's
//!    value, not the "enabled / disabled in Task Manager" switch (`StartupApproved`), not an entry that points to another exe.
//! 2. A copy of the app that is not the owner's (a QA build: its own identifier or data folder, `identity::isolated`) registers under its own value name, so
//!    a test that turns "Start when I sign in" on or off can no longer overwrite or delete the real entry of the installed app.
//! 3. A second start that is itself a tray start (`--minimized`: a second autostart, an installer relaunch, a relaunch by the system) is handed to the running
//!    instance like any second start, but it must not bring the window up: nobody asked for it (`is_tray_start` in the single-instance callback).
//! 4. A restart that a person is looking at (the app's own restart after a blank or dead page, the restart after an update the person asked for) inherits the
//!    arguments of the old run, `--minimized` among them, so the window the person was using would turn into a tray start. The old run leaves a note
//!    (`mark_window_wanted`), the new one reads it (`take_window_wanted`) and shows its window.
//! 5. A tray start must not leave the app invisible: `tray_confirmed` checks that the icon is really in the notification area (the icon library reports a
//!    success when the first `Shell_NotifyIcon` call failed because the shell was not ready) and asks for it again; when it never appears, the window is shown.
//!
//! macOS and Linux register `--minimized` through the same plugin (a launch agent, an `.desktop` entry); nothing here changes them (the pure parts compile
//! and are tested everywhere, the registry part is Windows only).
//!
//! 1.0.10 (owner decision after the white-window saga): the start at Windows sign-in is a VISIBLE start by default. The entry is `"<exe>"` and the window comes up
//! like in any start (after the start gate, `startgate.rs`). The tray start of 1.0.9 stays as an opt-in switch, Settings > Notifications > "Start in the tray"
//! (pref `startInTray`, default off): then the entry is `"<exe>" --minimized` and everything above (gate, tray check, ghost parking) works as in 1.0.9. The entry is
//! looked after in the form that matches the switch, so an entry of an install from 1.0.0 .. 1.0.9 (`--minimized`) is written again without the flag.
use std::path::Path;
use std::sync::OnceLock;
#[cfg(any(windows, test))]
use std::time::Duration;

/// The argument of the autostart entry that starts in the tray (the switch "Start in the tray").
pub const TRAY_FLAG: &str = "--minimized";

/// The pref of the switch "Start in the tray" (`prefs` blob, written by the main page; default off: the start at sign-in shows the window).
pub const TRAY_PREF: &str = "startInTray";

/// The value of the pref in the `prefs` blob (`shell::prefs`); off when it is not there.
pub fn start_in_tray(prefs: &serde_json::Value) -> bool {
    crate::shell::pbool(prefs, TRAY_PREF, false)
}

/// Does this start stay in the tray? The flag asks for it (an entry of 1.0.0 .. 1.0.9, the switch on, a relaunch that inherits it); the package's startup task has no
/// argument, so for it the switch decides (`by_startup_task`). Pure.
pub fn tray_start(has_flag: bool, by_startup_task: bool, prefs: &serde_json::Value) -> bool {
    has_flag || (by_startup_task && start_in_tray(prefs))
}

/// Is this a tray start? `args[0]` is the program (as `std::env::args` and the single-instance callback give them).
pub fn is_tray_start(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == TRAY_FLAG)
}

/// The name of the autostart value of this copy: the app's name (as the plugin names it), and for a copy that is not the owner's (`isolated_as`: the
/// AppUserModelID of `identity.rs`) that name in brackets, so the two never share an entry.
pub fn entry_name(base: &str, isolated_as: Option<&str>) -> String {
    match isolated_as {
        Some(id) => format!("{base} [{id}]"),
        None => base.to_string(),
    }
}

static ENTRY_NAME: OnceLock<String> = OnceLock::new();

/// Remembers the name the autostart plugin was built with (once, in `run`).
pub fn set_entry_name(name: &str) {
    let _ = ENTRY_NAME.set(name.to_string());
}

// ---------- the value in the Run key ----------

/// What the entry should say for the exe at `exe`: `"<exe>"` (the window shows at sign-in) or, with the switch "Start in the tray" on, `"<exe>" --minimized`.
#[cfg(any(windows, test))]
pub fn expected_value(exe: &str, tray: bool) -> String {
    if tray { format!("\"{exe}\" {TRAY_FLAG}") } else { format!("\"{exe}\"") }
}

/// The program of a command line as the Run key keeps it: quoted, or (what the plugin wrote until 1.0.8) not quoted at all, with a path that may hold spaces
/// ("...\Hey Look!\hey-look.exe --minimized"): then the program ends at the first `.exe` that is followed by a space or the end.
#[cfg(any(windows, test))]
pub fn program_of(value: &str) -> String {
    let v = value.trim();
    if let Some(rest) = v.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    let lower = v.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(".exe") {
        let end = from + i + 4;
        if end == lower.len() || lower[end..].starts_with(char::is_whitespace) {
            return v[..end].to_string();
        }
        from = end;
    }
    v.split_whitespace().next().unwrap_or("").to_string()
}

/// The same file? (Windows paths: case does not matter, `/` is `\`, a `\\?\` prefix is no difference.)
#[cfg(any(windows, test))]
pub fn same_program(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// What to do with the entry found in the Run key.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// No value of that name: the person has not turned the start at sign-in on (or off).
    Absent,
    /// This program's entry, in the form written by `expected_value`.
    Current,
    /// This program's entry, but not in that form (the flag of the old tray start is still there or is missing, the path is not quoted ...): write this instead.
    Rewrite(String),
    /// An entry of that name that starts another program: not ours to change.
    Other,
}

#[cfg(any(windows, test))]
pub fn plan(current: Option<&str>, exe: &str, tray: bool) -> Plan {
    let Some(cur) = current else { return Plan::Absent };
    if !same_program(&program_of(cur), exe) {
        return Plan::Other;
    }
    let want = expected_value(exe, tray);
    if cur.trim() == want {
        Plan::Current
    } else {
        Plan::Rewrite(want)
    }
}

/// Windows: looks at this copy's entry in the Run key and brings it into the form of `expected_value` (for the switch `tray`) when it is this program's. Logged
/// either way (the next report about a window at sign-in then says what was registered). Does nothing in the Store package (its startup task has no value).
#[cfg(windows)]
pub fn ensure_entry(tray: bool) {
    if crate::pkg::packaged() {
        return;
    }
    let (Some(name), Ok(exe)) = (ENTRY_NAME.get(), std::env::current_exe()) else { return };
    let exe = exe.display().to_string();
    let current = win::read_run_value(name);
    let switch = if tray { "Start in the tray: on" } else { "Start in the tray: off" };
    match plan(current.as_deref(), &exe, tray) {
        Plan::Absent => crate::startup::line("autostart", &format!("no entry \"{name}\" in the Run key: the app does not start when the person signs in ({switch})")),
        Plan::Current => crate::startup::line("autostart", &format!("entry \"{name}\" is {} ({switch})", current.unwrap_or_default())),
        Plan::Rewrite(to) => {
            let from = current.unwrap_or_default();
            let wrote = win::write_run_value_checked(name, &to);
            crate::startup::line("autostart", &format!("entry \"{name}\" was {from}: {} {to} ({switch})", match &wrote { Ok(()) => "written again as".to_string(), Err(e) => format!("could NOT be written again ({e}) as") }));
        }
        Plan::Other => crate::startup::line("autostart", &format!("entry \"{name}\" starts another program ({}): left alone", current.unwrap_or_default())),
    }
}

#[cfg(not(windows))]
pub fn ensure_entry(_tray: bool) {}

/// The entry as it must be after the switch was turned on, read back from `HKCU\...\Run`: Ok when it is there in the form of the switch, else the words for the error
/// toast. Pure.
#[cfg(any(windows, test))]
pub fn check_written(name: &str, read_back: Option<&str>, exe: &str, tray: bool) -> Result<(), String> {
    match plan(read_back, exe, tray) {
        Plan::Current => Ok(()),
        Plan::Absent => Err(format!("The start at sign-in could not be turned on: the entry \"{name}\" is not in the current user's Run key after it was written.")),
        Plan::Rewrite(_) => Err(format!("The start at sign-in could not be turned on: the entry \"{name}\" reads {} instead of {}.", read_back.unwrap_or_default(), expected_value(exe, tray))),
        Plan::Other => Err(format!("The start at sign-in could not be turned on: the entry \"{name}\" starts another program ({}).", read_back.unwrap_or_default())),
    }
}

/// After the switch was turned off: Ok when neither the current user's Run key nor the machine-wide one still has an entry of this program, else the words for the
/// error toast (a machine-wide entry, written when an elevated copy turned the switch on, cannot be removed by a copy that is not elevated). Pure.
#[cfg(any(windows, test))]
pub fn check_removed(name: &str, user: Option<&str>, machine: Option<&str>, exe: &str) -> Result<(), String> {
    if user.is_some_and(|v| same_program(&program_of(v), exe)) {
        return Err(format!("The start at sign-in could not be turned off: the entry \"{name}\" is still in the current user's Run key."));
    }
    if machine.is_some_and(|v| same_program(&program_of(v), exe)) {
        return Err(format!("The start at sign-in is also registered for all users (\"{name}\" in HKEY_LOCAL_MACHINE\\...\\Run); it can only be removed by running Hey Look! as administrator once and turning the switch off."));
    }
    Ok(())
}

/// Windows: the switch "Start Hey Look! when I sign in". The entry is written to the CURRENT USER's Run key and nowhere else, and it is read back: an error comes
/// back with the Windows error text, and the page shows the real state of the switch.
///
/// Why not the plugin's `enable()`: its `WindowsEnableMode` is `Dynamic`, which tries `HKEY_LOCAL_MACHINE\...\Run` first and falls back to the current user only
/// when that is refused ("Access is denied"). A copy that runs as an administrator (an elevated start, or a user such as the Windows Sandbox's
/// `WDAGUtilityAccount` whose token is elevated without a prompt) can write HKLM, so the switch said "on" and `enable()` said Ok while `HKCU\...\Run` stayed empty
/// (QA 1.0.10, Sandbox: the app's own look at HKCU found "no entry"). An entry for every user is also not what the switch means.
#[cfg(windows)]
pub fn set_entry(enabled: bool, tray: bool) -> Result<(), String> {
    let (Some(name), Ok(exe)) = (ENTRY_NAME.get(), std::env::current_exe()) else { return Err("The start at sign-in cannot be changed: the name of the entry is not known.".into()) };
    let exe = exe.display().to_string();
    let log = |what: &str| crate::startup::line("autostart", &format!("the switch was turned {} ({}): {what}", if enabled { "on" } else { "off" }, if tray { "Start in the tray: on" } else { "Start in the tray: off" }));
    let done = (|| {
        // an entry of this program in the machine-wide Run key (an older elevated run of the plugin wrote one): it would start the app a second time, or keep it
        // starting after the switch is off. Removed when this copy is allowed to; otherwise the switch cannot be turned off here (below)
        let machine = win::read_machine_value(name);
        let machine_is_ours = machine.as_deref().is_some_and(|v| same_program(&program_of(v), &exe));
        let machine_removed = if machine_is_ours { win::delete_machine_value(name) } else { Ok(()) };
        if enabled {
            win::write_run_value_checked(name, &expected_value(&exe, tray)).map_err(|e| format!("The start at sign-in could not be turned on: Windows refused to write the entry \"{name}\" ({e})."))?;
            win::approve(name);
            check_written(name, win::read_run_value(name).as_deref(), &exe, tray)
        } else {
            win::delete_run_value(name).map_err(|e| format!("The start at sign-in could not be turned off: Windows refused to remove the entry \"{name}\" ({e})."))?;
            let leftover = if machine_removed.is_ok() { win::read_machine_value(name) } else { machine };
            check_removed(name, win::read_run_value(name).as_deref(), leftover.as_deref(), &exe)
        }
    })();
    match &done {
        Ok(()) => log("the entry was read back and is in the Run key of the current user (or gone)"),
        Err(e) => log(&format!("could not be done: {e}")),
    }
    done
}

// ---------- a restart that a person is looking at ----------

const WINDOW_NOTE: &str = "show-after-restart.txt";
/// A note older than this is a leftover (the restart it was for did not happen) and means nothing.
const NOTE_MAX_AGE_S: i64 = 600;

/// Pure: does the text of the note (a unix time) ask for the window at `now`?
pub fn window_wanted(note: &str, now: i64) -> bool {
    note.trim().parse::<i64>().is_ok_and(|t| now >= t && now - t <= NOTE_MAX_AGE_S)
}

/// The old run leaves a note in the data folder: "the window was on screen, the run that follows shows its window although it was started with `--minimized`".
pub fn mark_window_wanted(dir: &Path, now: i64) {
    let _ = std::fs::write(dir.join(WINDOW_NOTE), now.to_string());
}

/// The restart did not happen (the installer did not start): the note is taken back.
pub fn clear_window_wanted(dir: &Path) {
    let _ = std::fs::write(dir.join(WINDOW_NOTE), "");
}

/// The new run reads the note and empties it: true when a fresh one was there.
pub fn take_window_wanted(dir: &Path, now: i64) -> bool {
    let path = dir.join(WINDOW_NOTE);
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    if text.is_empty() {
        return false;
    }
    let _ = std::fs::write(&path, "");
    window_wanted(&text, now)
}

// ---------- the tray icon of a tray start ----------

/// How the check of the tray icon ended.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayOutcome {
    /// The icon is in the notification area (after `ms`); `asked` = how often it had to be asked for again.
    Present { ms: u128, asked: u32 },
    /// It never came, or the person asked for the window first.
    Absent { ms: u128, asked: u32 },
}

/// How long the check waits for the icon.
#[cfg(any(windows, test))]
pub const TRAY_WAIT: Duration = Duration::from_secs(15);
/// How often the icon is looked for.
#[cfg(any(windows, test))]
pub const TRAY_POLL: Duration = Duration::from_millis(500);
/// When (after the start of the check) the icon is asked for again if it is still not there.
#[cfg(any(windows, test))]
pub const TRAY_REASK_AT_MS: [u128; 4] = [1_000, 4_000, 8_000, 12_000];

/// Waits for the tray icon to be in the notification area; `present` looks (None: it cannot be told, that counts as present, nothing is guessed),
/// `ask_again` makes the icon library register it again. The clock and the sleeping are injected (a test runs 15 s in no time). `stop` ends the wait (a person
/// asked for the window, or the app is quitting).
#[cfg(any(windows, test))]
pub fn tray_confirmed(mut present: impl FnMut() -> Option<bool>, mut ask_again: impl FnMut(), elapsed: impl Fn() -> Duration, mut sleep: impl FnMut(Duration), stop: impl Fn() -> bool) -> TrayOutcome {
    let mut asked = 0u32;
    loop {
        let ms = elapsed().as_millis();
        if present().unwrap_or(true) {
            return TrayOutcome::Present { ms, asked };
        }
        if stop() || elapsed() >= TRAY_WAIT {
            return TrayOutcome::Absent { ms, asked };
        }
        if (asked as usize) < TRAY_REASK_AT_MS.len() && ms >= TRAY_REASK_AT_MS[asked as usize] {
            ask_again();
            asked += 1;
        }
        sleep(TRAY_POLL);
    }
}

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE};
    use windows::Win32::UI::Shell::{Shell_NotifyIconW, NIM_DELETE, NOTIFYICONDATAW};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowThreadProcessId, RegisterWindowMessageW, SendMessageTimeoutW, SMTO_ABORTIFHUNG};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The key that holds the entries: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. A debug build run with `HEYLOOK_TEST_RUN_KEY=<subkey of HKCU>` looks there
    /// instead, so a test of the migration can put a value somewhere that Windows never runs at sign-in (a release build reads no variable).
    fn run_key() -> Vec<u16> {
        let test = if cfg!(debug_assertions) { std::env::var("HEYLOOK_TEST_RUN_KEY").ok().filter(|k| !k.trim().is_empty()) } else { None };
        wide(&test.unwrap_or_else(|| r"Software\Microsoft\Windows\CurrentVersion\Run".to_string()))
    }

    /// The string value `name` of `HKCU\...\Run`, if there is one.
    pub fn read_run_value(name: &str) -> Option<String> {
        read_string(HKEY_CURRENT_USER, &run_key(), name)
    }

    /// The Task Manager switches of the Run entries (`StartupApproved\Run`); not written when a test key stands in for the Run key.
    const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    /// "Enabled" in `StartupApproved` (what the plugin writes, and Task Manager when the person turns the entry on).
    const APPROVED_ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    fn test_key() -> bool {
        cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_RUN_KEY").is_ok_and(|k| !k.trim().is_empty())
    }

    /// The text of a Win32 error for the toast ("Access is denied. (os error 5)").
    fn os_text(code: u32) -> String {
        std::io::Error::from_raw_os_error(code as i32).to_string()
    }

    /// The string value `name` of `root\subkey`, if there is one.
    fn read_string(root: HKEY, subkey: &[u16], name: &str) -> Option<String> {
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), None, KEY_QUERY_VALUE, &mut key) != ERROR_SUCCESS {
                return None;
            }
            let value = wide(name);
            let (mut kind, mut bytes) = (REG_VALUE_TYPE(0), 0u32);
            let mut out = None;
            if RegQueryValueExW(key, PCWSTR(value.as_ptr()), None, Some(&mut kind), None, Some(&mut bytes)) == ERROR_SUCCESS && bytes > 0 {
                let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
                let mut got = (buf.len() * 2) as u32;
                if RegQueryValueExW(key, PCWSTR(value.as_ptr()), None, Some(&mut kind), Some(buf.as_mut_ptr() as *mut u8), Some(&mut got)) == ERROR_SUCCESS {
                    let n = (got as usize / 2).min(buf.len());
                    out = Some(String::from_utf16_lossy(&buf[..n]).trim_end_matches('\0').to_string());
                }
            }
            let _ = RegCloseKey(key);
            out
        }
    }

    /// The value `name` of `HKLM\...\Run` (an entry for every user), if there is one. Never read when a test key stands in for the Run key.
    pub fn read_machine_value(name: &str) -> Option<String> {
        if test_key() {
            return None;
        }
        read_string(HKEY_LOCAL_MACHINE, &wide(r"Software\Microsoft\Windows\CurrentVersion\Run"), name)
    }

    /// Deletes the value `name` of `root\subkey`: Ok when it is gone (or never was), else the Win32 error.
    fn delete_value(root: HKEY, subkey: &[u16], name: &str) -> Result<(), u32> {
        unsafe {
            let mut key = HKEY::default();
            let opened = RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), None, KEY_SET_VALUE, &mut key);
            if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND {
                return Ok(());
            }
            if opened != ERROR_SUCCESS {
                return Err(opened.0);
            }
            let n = wide(name);
            let gone = RegDeleteValueW(key, PCWSTR(n.as_ptr()));
            let _ = RegCloseKey(key);
            if gone == ERROR_SUCCESS || gone == ERROR_FILE_NOT_FOUND {
                Ok(())
            } else {
                Err(gone.0)
            }
        }
    }

    /// Deletes this copy's value in `HKCU\...\Run`.
    pub fn delete_run_value(name: &str) -> Result<(), String> {
        delete_value(HKEY_CURRENT_USER, &run_key(), name).map_err(os_text)
    }

    /// Deletes this copy's value in `HKLM\...\Run`. The error is the Win32 text (usually "Access is denied": the app does not run as administrator).
    pub fn delete_machine_value(name: &str) -> Result<(), String> {
        if test_key() {
            return Ok(());
        }
        delete_value(HKEY_LOCAL_MACHINE, &wide(r"Software\Microsoft\Windows\CurrentVersion\Run"), name).map_err(os_text)
    }

    /// Writes the string value `name` of `HKCU\...\Run`, creating the key when it is not there yet; the error carries the Win32 text.
    pub fn write_run_value_checked(name: &str, value: &str) -> Result<(), String> {
        unsafe {
            let mut key = HKEY::default();
            let opened = RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(run_key().as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None);
            if opened != ERROR_SUCCESS {
                return Err(os_text(opened.0));
            }
            let (n, v) = (wide(name), wide(value));
            let bytes = std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2);
            let set = RegSetValueExW(key, PCWSTR(n.as_ptr()), None, REG_SZ, Some(bytes));
            let _ = RegCloseKey(key);
            if set == ERROR_SUCCESS { Ok(()) } else { Err(os_text(set.0)) }
        }
    }

    /// Turning the switch on in the app also turns the entry on in Task Manager when the person had turned it off there (what the plugin did); only when the
    /// `StartupApproved` key exists (Windows makes it), and never for a test key. Best effort.
    pub fn approve(name: &str) {
        if test_key() {
            return;
        }
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(wide(APPROVED_KEY).as_ptr()), None, KEY_SET_VALUE, &mut key) != ERROR_SUCCESS {
                return;
            }
            let n = wide(name);
            let _ = RegSetValueExW(key, PCWSTR(n.as_ptr()), None, REG_BINARY, Some(&APPROVED_ENABLED));
            let _ = RegCloseKey(key);
        }
    }

    /// The hidden window of this process's tray icon (class `tray_icon_app` of the icon library).
    fn tray_window() -> Option<HWND> {
        unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> windows::core::BOOL {
            // SAFETY: a window handle the system hands to the enumeration, and `found` is the address of the caller's HWND that outlives the enumeration
            unsafe {
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == std::process::id() {
                    let mut name = [0u16; 64];
                    let n = GetClassNameW(hwnd, &mut name) as usize;
                    if String::from_utf16_lossy(&name[..n.min(64)]) == "tray_icon_app" {
                        *(found.0 as *mut HWND) = hwnd;
                        return false.into();
                    }
                }
            }
            true.into()
        }
        let mut found = HWND::default();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut HWND as isize));
        }
        (!found.0.is_null()).then_some(found)
    }

    /// Debug builds: `HEYLOOK_TEST_TRAY=drop` / `drop-always` (see `test_drop_tray_icon`).
    fn test_mode() -> Option<String> {
        if cfg!(debug_assertions) { std::env::var("HEYLOOK_TEST_TRAY").ok().map(|v| v.trim().to_lowercase()) } else { None }
    }

    /// Tells the hidden window of this process's tray icon that the taskbar was created: the icon library then removes and registers the icon again (what it does
    /// when Explorer restarts). Sent to that window only, not broadcast: other programs' icons are not made to flicker. True when the window was found.
    pub fn ask_tray_again() -> bool {
        if test_mode().as_deref() == Some("drop-always") {
            return false; // (the icon never comes back: the road of an icon that cannot be registered)
        }
        let Some(hwnd) = tray_window() else { return false };
        unsafe {
            let msg = RegisterWindowMessageW(w!("TaskbarCreated"));
            let _ = SendMessageTimeoutW(hwnd, msg, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 2000, None);
        }
        true
    }

    /// Debug builds with `HEYLOOK_TEST_TRAY=drop` (or `drop-always`, where asking again does nothing): takes the icon out of the notification area behind the icon
    /// library's back, as a first registration the shell refused would have left it (the library thinks it is there, the shell does not know it). QA of the check.
    pub fn test_drop_tray_icon() -> bool {
        if !matches!(test_mode().as_deref(), Some("drop") | Some("drop-always")) {
            return false;
        }
        let Some(hwnd) = tray_window() else { return false };
        let mut dropped = false;
        for id in 1..=16u32 {
            let nid = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: id, ..Default::default() };
            dropped |= unsafe { Shell_NotifyIconW(NIM_DELETE, &nid) }.as_bool();
        }
        dropped
    }
}

/// Windows: asks the tray icon to register again (see `win::ask_tray_again`).
#[cfg(windows)]
pub fn ask_tray_again() -> bool {
    win::ask_tray_again()
}

/// Windows, debug builds: see `win::test_drop_tray_icon`.
#[cfg(all(windows, debug_assertions))]
pub fn test_drop_tray_icon() -> bool {
    win::test_drop_tray_icon()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const EXE: &str = r"C:\Users\ann\AppData\Local\Hey Look!\hey-look.exe";

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_tray_start_is_the_flag_after_the_program() {
        assert!(is_tray_start(&args(&["hey-look.exe", "--minimized"])));
        assert!(is_tray_start(&args(&["hey-look.exe", "x", "--minimized"])));
        assert!(!is_tray_start(&args(&["hey-look.exe"])));
        assert!(!is_tray_start(&args(&["--minimized"])), "the first argument is the program");
        assert!(!is_tray_start(&args(&["hey-look.exe", "--minimized=1", "-minimized", "minimized"])));
        assert!(!is_tray_start(&[]));
    }

    #[test]
    fn a_copy_that_is_not_the_owners_has_its_own_entry_name() {
        assert_eq!(entry_name("Hey Look!", None), "Hey Look!");
        assert_eq!(entry_name("Hey Look!", Some("thnonl.heylook.qa.v109")), "Hey Look! [thnonl.heylook.qa.v109]");
        assert_ne!(entry_name("Hey Look!", Some("thnonl.heylook.qa")), entry_name("Hey Look!", None));
    }

    #[test]
    fn the_program_of_a_run_value_quoted_or_not() {
        assert_eq!(program_of(&format!("\"{EXE}\" --minimized")), EXE);
        assert_eq!(program_of(&format!("{EXE} --minimized")), EXE, "what the plugin wrote until 1.0.8: a path with a space, not quoted");
        assert_eq!(program_of(EXE), EXE);
        assert_eq!(program_of(r"C:\a\b.exe.bak\c.exe -x"), r"C:\a\b.exe.bak\c.exe", ".exe in the middle of a name is not the end");
        assert_eq!(program_of(r"C:\Program Files\X\X.EXE /s"), r"C:\Program Files\X\X.EXE");
        assert_eq!(program_of("explorer.exe shell:AppsFolder\\Claude"), "explorer.exe");
        assert_eq!(program_of("  \"C:\\x y\\z.exe\"  "), "C:\\x y\\z.exe");
        assert_eq!(program_of("C:\\tool --flag"), "C:\\tool", "no .exe: the first word");
        assert_eq!(program_of(""), "");
    }

    #[test]
    fn the_same_program_in_any_spelling_of_its_path() {
        assert!(same_program(EXE, &EXE.to_uppercase()));
        assert!(same_program(EXE, &EXE.replace('\\', "/")));
        assert!(same_program(&format!("\"{EXE}\""), EXE));
        assert!(same_program(&format!(r"\\?\{EXE}"), EXE));
        assert!(!same_program(EXE, r"C:\Users\ann\AppData\Local\Hey Look! QA\hey-look.exe"));
        assert!(!same_program("", ""), "nothing is the same as nothing");
    }

    #[test]
    fn the_entry_is_kept_rewritten_or_left_alone() {
        // default (the switch "Start in the tray" off): a visible start, no flag
        let visible = format!("\"{EXE}\"");
        let tray = format!("\"{EXE}\" --minimized");
        assert_eq!(expected_value(EXE, false), visible);
        assert_eq!(expected_value(EXE, true), tray);
        assert_eq!(plan(None, EXE, false), Plan::Absent);
        assert_eq!(plan(None, EXE, true), Plan::Absent);
        assert_eq!(plan(Some(&visible), EXE, false), Plan::Current);
        assert_eq!(plan(Some(&format!("  {visible} ")), EXE, false), Plan::Current, "blanks around it are no reason to write");
        assert_eq!(plan(Some(&tray), EXE, true), Plan::Current);
        // the entry of 1.0.0 .. 1.0.9 (every install has the flag, 1.0.0 .. 1.0.8 also an unquoted path): with the switch off it is written again, visible
        assert_eq!(plan(Some(&tray), EXE, false), Plan::Rewrite(visible.clone()), "an entry of 1.0.9 becomes the visible start");
        assert_eq!(plan(Some(&format!("{EXE} --minimized")), EXE, false), Plan::Rewrite(visible.clone()), "so does the unquoted one of 1.0.0 .. 1.0.8");
        // the switch on: the other way round (and the quoting of an old entry)
        assert_eq!(plan(Some(&visible), EXE, true), Plan::Rewrite(tray.clone()));
        assert_eq!(plan(Some(&format!("{EXE} --minimized")), EXE, true), Plan::Rewrite(tray.clone()));
        assert_eq!(plan(Some(EXE), EXE, true), Plan::Rewrite(tray.clone()));
        // a hand-made entry of this program that differs (other arguments, the spelling of the path): the form of the switch, as in 1.0.9
        assert_eq!(plan(Some(&format!("\"{EXE}\" --minimized --other")), EXE, false), Plan::Rewrite(visible.clone()));
        assert_eq!(plan(Some(&format!("\"{EXE}\" --other")), EXE, true), Plan::Rewrite(tray.clone()));
        assert_eq!(plan(Some(&format!("\"{}\"", EXE.to_uppercase())), EXE, false), Plan::Rewrite(visible), "the spelling of the path is normalised");
        // an entry that starts another program is not touched (a QA build next to the installed app, a copy in another folder), whatever the switch says
        for on in [false, true] {
            assert_eq!(plan(Some(&format!("{} --minimized", r"C:\other\hey-look.exe")), EXE, on), Plan::Other);
            assert_eq!(plan(Some("explorer.exe shell:AppsFolder\\x"), EXE, on), Plan::Other);
            assert_eq!(plan(Some(""), EXE, on), Plan::Other);
        }
    }

    #[test]
    fn the_start_in_the_tray_switch_is_off_until_it_is_turned_on() {
        let p = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        assert!(!start_in_tray(&serde_json::Value::Null), "no prefs saved yet: off");
        assert!(!start_in_tray(&p("{}")) && !start_in_tray(&p(r#"{"startInTray":false}"#)));
        assert!(!start_in_tray(&p(r#"{"startInTray":"yes"}"#)), "only a real true counts");
        assert!(start_in_tray(&p(r#"{"startInTray":true}"#)));
        assert_eq!(TRAY_PREF, "startInTray");
    }

    #[test]
    fn a_start_stays_in_the_tray_for_the_flag_or_for_the_switch_in_a_start_by_the_package_task() {
        let off = serde_json::json!({});
        let on = serde_json::json!({"startInTray": true});
        // the flag is a request (an old entry that was not rewritten yet, a relaunch with inherited arguments, the switch on)
        assert!(tray_start(true, false, &off) && tray_start(true, false, &on) && tray_start(true, true, &off));
        // no flag: a normal start and a visible autostart show the window ...
        assert!(!tray_start(false, false, &off) && !tray_start(false, false, &on), "the switch is about the entry: a start by hand is no tray start");
        // ... and the package's startup task (no argument to carry the choice) follows the switch
        assert!(!tray_start(false, true, &off), "default: the package's start at sign-in shows the window");
        assert!(tray_start(false, true, &on));
    }

    #[test]
    fn the_note_for_a_restart_that_a_person_is_looking_at() {
        assert!(window_wanted("1000", 1000));
        assert!(window_wanted("1000\n", 1000 + 600), "ten minutes");
        assert!(!window_wanted("1000", 1000 + 601), "a leftover means nothing");
        assert!(!window_wanted("1000", 999), "a note from the future means nothing");
        assert!(!window_wanted("", 1000) && !window_wanted("soon", 1000));
        let dir = std::env::temp_dir().join(format!("heylook-restart-note-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!take_window_wanted(&dir, 5000), "no note yet (or an empty one)");
        mark_window_wanted(&dir, 5000);
        assert!(take_window_wanted(&dir, 5030), "the run that follows reads it");
        assert!(!take_window_wanted(&dir, 5031), "and only one run does");
        mark_window_wanted(&dir, 5000);
        clear_window_wanted(&dir);
        assert!(!take_window_wanted(&dir, 5001), "taken back: the restart did not happen");
        mark_window_wanted(&dir, 5000);
        assert!(!take_window_wanted(&dir, 5000 + 3600), "an hour old: not for this start, and it is emptied all the same");
        assert!(!take_window_wanted(&dir, 5001));
    }

    /// The tray check on a simulated clock; `appears_ms` = when the icon is in the notification area (None: never), `fixed_by_ask` = the n-th request makes it appear.
    fn run(appears_ms: Option<u128>, asks_needed: Option<u32>, stop_at_ms: Option<u128>) -> (TrayOutcome, u128, u32) {
        let clock = Cell::new(0u128);
        let asked = Cell::new(0u32);
        let appeared = RefCell::new(false);
        let outcome = tray_confirmed(
            || {
                if appears_ms.is_some_and(|t| clock.get() >= t) || asks_needed.is_some_and(|n| asked.get() >= n) {
                    *appeared.borrow_mut() = true;
                }
                Some(*appeared.borrow())
            },
            || asked.set(asked.get() + 1),
            || Duration::from_millis(clock.get() as u64),
            |d| clock.set(clock.get() + d.as_millis()),
            || stop_at_ms.is_some_and(|t| clock.get() >= t),
        );
        (outcome, clock.get(), asked.get())
    }

    #[test]
    fn a_tray_icon_that_is_there_is_confirmed_at_once_without_asking() {
        assert_eq!(run(Some(0), None, None), (TrayOutcome::Present { ms: 0, asked: 0 }, 0, 0));
    }

    #[test]
    fn an_icon_that_comes_late_is_waited_for_and_one_that_needs_a_second_try_gets_it() {
        let (o, _, asked) = run(Some(2_300), None, None);
        assert_eq!((o, asked), (TrayOutcome::Present { ms: 2_500, asked: 1 }, 1), "asked at 1 s, there at the poll after 2.3 s");
        let (o, _, asked) = run(None, Some(2), None);
        assert_eq!(asked, 2);
        assert!(matches!(o, TrayOutcome::Present { asked: 2, .. }), "{o:?}");
    }

    #[test]
    fn an_icon_that_never_comes_ends_the_wait_after_fifteen_seconds_after_four_requests() {
        let (o, clock, asked) = run(None, None, None);
        assert_eq!((o, asked), (TrayOutcome::Absent { ms: 15_000, asked: 4 }, 4));
        assert_eq!(clock, 15_000);
    }

    #[test]
    fn a_person_asking_for_the_window_ends_the_wait_and_a_tray_that_cannot_be_asked_counts_as_present() {
        let (o, clock, _) = run(None, None, Some(1_250));
        assert!(matches!(o, TrayOutcome::Absent { .. }) && clock == 1_500, "{o:?} {clock}");
        let o = tray_confirmed(|| None, || panic!("nothing to ask"), || Duration::ZERO, |_| {}, || false);
        assert_eq!(o, TrayOutcome::Present { ms: 0, asked: 0 });
    }

    /// The source of a file without its test modules (for the wiring tests).
    fn code(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(name);
        crate::test_guard::non_test_code(&std::fs::read_to_string(p).unwrap().replace('\r', ""))
    }

    #[test]
    fn the_plugin_is_built_with_the_copys_own_name_and_writes_the_flag_on_macos_and_linux_only() {
        let lib = code("lib.rs");
        let run = &lib[lib.find("pub fn run() {").unwrap()..];
        let plugin = &run[run.find("tauri_plugin_autostart::Builder::new()").unwrap()..];
        let plugin = &plugin[..plugin.find(".build()").unwrap()];
        assert!(plugin.contains(".args(entry_args.iter().copied())") && plugin.contains(".app_name("), "{plugin}");
        let before = &run[..run.find("tauri_plugin_autostart::Builder::new()").unwrap()];
        // Windows: the plugin writes the entry without arguments (a visible start) and `ensure_entry` adds the flag when the switch is on; the launch agent / .desktop
        // of macOS and Linux keep `--minimized` (the switch is offered on Windows only)
        assert!(before.contains("let entry_args: &[&str] = if cfg!(windows) { &[] } else { &[autostart::TRAY_FLAG] };"), "{before}");
        assert!(before.contains("autostart::set_entry_name(") && before.contains("autostart::entry_name("), "the name is chosen before the plugin is built");
        assert!(before.contains("identity::isolated()"), "an isolated copy has its own entry");
    }

    #[test]
    fn the_entry_is_looked_after_at_every_start_after_the_switch_is_turned_on_and_when_the_tray_switch_changes() {
        let lib = code("lib.rs");
        let setup = &lib[lib.find(".setup(|app| {").unwrap()..];
        let setup = &setup[..setup.find(".on_window_event").unwrap()];
        assert!(setup.contains("autostart::ensure_entry(autostart::start_in_tray("), "at every start, in the form of the switch");
        assert!(setup.find("db::open(").unwrap() < setup.find("autostart::ensure_entry(").unwrap(), "the switch is a pref: the database is open first");
        let set = &lib[lib.find("fn set_autostart(").unwrap()..];
        let set = &set[..set.find("\n}\n").unwrap()];
        assert!(set.contains("autostart::set_entry(enabled, autostart::start_in_tray(") && set.contains("pkg::packaged()"), "Windows writes the entry itself, in the form of the switch; the package has no value to write: {set}");
        assert!(!set.contains("m.enable()") || set.find("#[cfg(not(windows))]").unwrap() < set.find("m.enable()").unwrap(), "the plugin's enable() (machine-wide key for an administrator) is not used on Windows: {set}");
        // the switch itself: a change of the pref writes the entry again, at once
        let sett = &lib[lib.find("fn set_setting(").unwrap()..];
        let sett = &sett[..sett.find("\n}\n").unwrap()];
        assert!(sett.contains("autostart::start_in_tray(") && sett.contains("autostart::ensure_entry("), "{sett}");
        assert!(sett.find("db::set_setting(").unwrap() < sett.rfind("autostart::ensure_entry(").unwrap(), "after the pref is saved");
    }


    #[test]
    fn a_written_entry_is_read_back_and_a_missing_or_wrong_one_is_an_error_with_words() {
        let name = "Hey Look!";
        assert_eq!(check_written(name, Some(&expected_value(EXE, false)), EXE, false), Ok(()));
        assert_eq!(check_written(name, Some(&expected_value(EXE, true)), EXE, true), Ok(()));
        // the Sandbox case of QA 1.0.10: Ok from the plugin, nothing in the current user's Run key
        let e = check_written(name, None, EXE, false).unwrap_err();
        assert!(e.contains("not in the current user's Run key") && e.contains(name), "{e}");
        let e = check_written(name, Some(&expected_value(EXE, true)), EXE, false).unwrap_err();
        assert!(e.contains("reads") && e.contains("--minimized"), "{e}");
        let e = check_written(name, Some(r"C:\Windows\notepad.exe"), EXE, false).unwrap_err();
        assert!(e.contains("another program"), "{e}");
    }

    #[test]
    fn a_removed_entry_is_gone_from_both_run_keys_or_the_error_says_where_it_is() {
        let mine = expected_value(EXE, false);
        assert_eq!(check_removed("Hey Look!", None, None, EXE), Ok(()));
        assert_eq!(check_removed("Hey Look!", None, Some(r"C:\Windows\notepad.exe"), EXE), Ok(()), "another program's machine-wide value is not ours");
        assert!(check_removed("Hey Look!", Some(&mine), None, EXE).unwrap_err().contains("still in the current user's Run key"));
        let e = check_removed("Hey Look!", None, Some(&mine), EXE).unwrap_err();
        assert!(e.contains("all users") && e.contains("administrator"), "{e}");
    }

    #[test]
    fn the_switch_is_written_by_the_app_to_the_current_user_and_read_back_not_left_to_the_plugin_on_windows() {
        let a = code("autostart.rs");
        let set = &a[a.find("pub fn set_entry(").unwrap()..];
        let set = &set[..set.find("\n}\n").unwrap()];
        assert!(set.contains("win::write_run_value_checked(") && set.contains("win::delete_run_value(") && set.contains("check_written(") && set.contains("check_removed("), "{set}");
        assert!(set.find("win::write_run_value_checked(").unwrap() < set.find("check_written(").unwrap(), "read back after the write");
        assert!(set.contains("map_err(|e|") && set.contains("Windows refused"), "the Windows error text goes to the toast");
        // the registry code creates the key (a Run key that does not exist yet) and names the error
        let w = &a[a.find("pub fn write_run_value_checked(").unwrap()..];
        let w = &w[..w.find("\n    }\n").unwrap()];
        assert!(w.contains("RegCreateKeyExW(HKEY_CURRENT_USER") && w.contains("os_text("), "{w}");
        assert!(!w.contains("HKEY_LOCAL_MACHINE"), "never the machine-wide key");
        // the page keeps the switch where it was and shows the error when the call fails
        let ui = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src").join("components").join("SettingsDialog.tsx")).unwrap().replace('\r', "");
        let toggle = &ui[ui.find("const toggleAuto = async").unwrap()..];
        let toggle = &toggle[..toggle.find("\n  };").unwrap()];
        assert!(toggle.find("await api.setAutostart(v)").unwrap() < toggle.find("setAutostart((a) => ({ ...a, enabled: v }))").unwrap(), "{toggle}");
        assert!(toggle.contains("showToast(() => friendlyError(e)") && toggle.contains("api.getAutostart()"), "{toggle}");
    }
    #[test]
    fn a_second_start_with_the_flag_does_not_bring_the_window_up() {
        let lib = code("lib.rs");
        let single = &lib[lib.find("tauri_plugin_single_instance::init(").unwrap()..];
        let single = &single[..single.find("}))").unwrap()];
        assert!(single.contains("autostart::is_tray_start(&args)"), "{single}");
        assert!(single.find("is_tray_start").unwrap() < single.find("shell::show_main(app)").unwrap(), "{single}");
        assert!(single.contains("return;"), "{single}");
    }

    #[test]
    fn a_restart_that_a_person_is_looking_at_keeps_the_window() {
        let lib = code("lib.rs");
        let setup = &lib[lib.find(".setup(|app| {").unwrap()..];
        let setup = &setup[..setup.find(".on_window_event").unwrap()];
        assert!(setup.contains("autostart::take_window_wanted(&dir, now())"), "the note is read in the setup");
        assert!(setup.contains("let show_at_start = !minimized || !shell::tray_ready() || window_wanted;"), "{setup}");
        // the two restarts that inherit the arguments: the app's own (startup.rs) and the one after an update the person asked for (update.rs)
        let start = code("startup.rs");
        let restart = &start[start.find("fn restart_app_with(").unwrap()..];
        let restart = &restart[..restart.find("app.restart();").unwrap()];
        assert!(restart.contains("mark_window_wanted") && restart.contains("window_shown(app)"), "{restart}");
        let upd = code("update.rs");
        let install = &upd[upd.find("pub async fn update_install(").unwrap()..];
        let install = &install[..install.find("\n}\n").unwrap()];
        assert!(install.contains("mark_window_wanted") && install.contains("if restart"), "{install}");
        assert!(install.find("mark_window_wanted").unwrap() < install.find(".install(&bytes)").unwrap(), "the note is written before the installer ends this process");
        assert!(install.contains("clear_window_wanted"), "an install that did not start takes the note back");
    }

    #[test]
    fn a_tray_start_checks_that_the_icon_is_there_before_it_keeps_the_window_hidden() {
        let gate = code("startgate.rs");
        let start = &gate[gate.find("pub fn start(").unwrap()..];
        assert!(start.contains("autostart::tray_confirmed("), "{start}");
        assert!(start.find("autostart::tray_confirmed(").unwrap() < start.find("WebviewWindowBuilder::from_config").unwrap(), "before the window is made");
        assert!(start.contains("show_at_start = true"), "an icon that never comes shows the window");
        let shell = code("shell.rs");
        assert!(shell.contains("pub fn tray_icon_present(") && shell.contains(".rect()"), "the icon is looked for with the shell's own answer");
    }
}
