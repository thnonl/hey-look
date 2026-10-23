//! The app inside its Microsoft Store package (WP14 option A, spec WA.2; PACKAGING.md > Microsoft Store).
//!
//! The Store version is the same `hey-look.exe` in an MSIX package (full trust). Windows virtualises writes of a packaged desktop app to AppData
//! and the registry into a private, per-package place; that is wrong for a database in WAL mode (a real `heylook.db` and virtualised `-wal` files
//! would mix), for attachments that another program must open, for the notification registration and for the autostart entry. So a packaged
//! process
//!   - keeps its data in the package's own folder `%LOCALAPPDATA%\Packages\<family>\LocalState`, the web view's data in
//!     `...\LocalCache` (`EBWebView` below it) and the files that "Open" hands to other programs in `...\TempState` (real paths, not virtualised);
//!     it never touches `%APPDATA%\thnonl.heylook` (a copy installed from GitHub on the same PC keeps its data, and this one is separate: no migration);
//!   - keeps its passwords and tokens under the credential store service `heylook.store` (identity.rs);
//!   - uses the package's own AppUserModelID for notifications and registers nothing in the registry (shell.rs);
//!   - does not update itself: the Store does (`update::managed_by` answers "msstore"; every check answers `Managed`, no download, no install);
//!   - starts at sign-in through the package's startup task `HeyLookStartup` (manifest), under the control of the person (Windows Settings > Apps >
//!     Startup) and the organisation, not through the registry `Run` key (`get_autostart` / `set_autostart` in lib.rs).
//! The unpackaged builds (the GitHub installers, `tauri dev`) are not touched by any of this: `packaged()` is false there.
//!
//! `HEYLOOK_SIMULATE_PACKAGED=1` (debug builds only, compiled out of a release build) switches the UI and updater logic (`ui_packaged`) so that QA can
//! see the Store texts without a package. It never changes a path, the credential store service or anything of the operating system: those read
//! `packaged()` (the real thing). `HEYLOOK_SIMULATE_AUTOSTART_LOCK=user|policy` (debug, with the simulation on) forces the locked state of the autostart
//! switch for the same purpose.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The id of the startup task in the manifest (src-tauri/msix/AppxManifest.xml.in).
pub const STARTUP_TASK_ID: &str = "HeyLookStartup";
/// The credential store service of a packaged copy (a GitHub install on the same PC keeps `heylook`).
pub const KEYRING_SERVICE_STORE: &str = "heylook.store";

/// The folders of a package under `%LOCALAPPDATA%\Packages\<family>` (the package's own storage; the app writes there directly, nothing is virtualised).
#[derive(Debug, Clone, PartialEq)]
pub struct Dirs {
    /// `LocalState`: the data folder (database, shards, logs, settings files)
    pub local_state: PathBuf,
    /// `LocalCache`: the web view's user data folder (`EBWebView` is made below it by the web view)
    pub local_cache: PathBuf,
    /// `TempState`: the files that "Open" hands to other programs
    pub temp_state: PathBuf,
}

/// Is `name` a package family name (`<name>_<13 characters>`)? It becomes a folder name, so nothing but the characters Windows allows in one passes.
pub fn is_family_name(name: &str) -> bool {
    let Some((id, publisher)) = name.rsplit_once('_') else { return false };
    (3..=50).contains(&id.len())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !id.starts_with('.')
        && publisher.len() == 13
        && publisher.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

/// The folders of the package `family` below `local_app_data` (pure).
pub fn dirs_for(local_app_data: &Path, family: &str) -> Option<Dirs> {
    if !is_family_name(family) || !local_app_data.is_absolute() {
        return None;
    }
    let root = local_app_data.join("Packages").join(family);
    Some(Dirs { local_state: root.join("LocalState"), local_cache: root.join("LocalCache"), temp_state: root.join("TempState") })
}

/// The folder for the files that "Open" hands to other programs: `TempState\HeyLook` in a package, `<system temp>\HeyLook` otherwise (pure).
pub fn temp_root_for(dirs: Option<&Dirs>, system_temp: &Path) -> PathBuf {
    dirs.map(|d| d.temp_state.join("HeyLook")).unwrap_or_else(|| system_temp.join("HeyLook"))
}

/// The folder of the files that "Open" hands to other programs (a day's worth, cleaned up at start).
pub fn temp_root() -> PathBuf {
    temp_root_for(dirs(), &std::env::temp_dir())
}

// ---------- the real thing ----------

/// The package full name of this process (`GetCurrentPackageFullName`), None when the process has no package identity.
#[cfg(windows)]
fn query(f: unsafe fn(*mut u32, Option<windows::core::PWSTR>) -> windows::Win32::Foundation::WIN32_ERROR) -> Option<String> {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, WIN32_ERROR};
    let mut len = 0u32;
    // (an unpackaged process answers APPMODEL_ERROR_NO_PACKAGE, 15700; a packaged one asks for a buffer)
    let rc = unsafe { f(&mut len, None) };
    if rc != ERROR_INSUFFICIENT_BUFFER || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    let rc = unsafe { f(&mut len, Some(windows::core::PWSTR(buf.as_mut_ptr()))) };
    if rc != WIN32_ERROR(0) {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]))
}

/// Does this process run with a package identity (inside the MSIX of the Microsoft Store)? Asked once. Real, never simulated.
pub fn packaged() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| {
        #[cfg(windows)]
        {
            query(windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName).is_some()
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
}

/// Debug builds only: `HEYLOOK_SIMULATE_PACKAGED=1`. A release build has no such thing (the whole function is compiled out).
#[cfg(debug_assertions)]
fn simulated() -> bool {
    std::env::var("HEYLOOK_SIMULATE_PACKAGED").ok().as_deref() == Some("1")
}
#[cfg(not(debug_assertions))]
fn simulated() -> bool {
    false
}

/// Packaged for the UI and the updater logic: really packaged, or (debug builds) simulated. NOT for paths, the credential store or the system: use `packaged`.
pub fn ui_packaged() -> bool {
    packaged() || simulated()
}

/// The package family name of this process (`<name>_<publisher id>`), None when unpackaged.
#[cfg(windows)]
pub fn family_name() -> Option<String> {
    query(windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName).filter(|n| is_family_name(n))
}

/// The AppUserModelID of this process (`<family>!<application id>`), None when unpackaged: the name of the toasts of a packaged app.
#[cfg(windows)]
pub fn process_aumid() -> Option<String> {
    query(windows::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId).filter(|n| n.contains('!'))
}
#[cfg(not(windows))]
pub fn process_aumid() -> Option<String> {
    None
}

/// The package folders of this process, None when unpackaged.
pub fn dirs() -> Option<&'static Dirs> {
    static DIRS: OnceLock<Option<Dirs>> = OnceLock::new();
    DIRS.get_or_init(|| {
        #[cfg(windows)]
        {
            if !packaged() {
                return None;
            }
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            dirs_for(&local, &family_name()?)
        }
        #[cfg(not(windows))]
        {
            None
        }
    })
    .as_ref()
}

// ---------- the startup task ----------

/// What the app shows of the startup task: is it on, and why can the person not change it here (`user`: turned off in Windows Settings > Apps > Startup or
/// Task Manager, where it has to be turned on again; `policy`: the organisation decides).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    pub enabled: bool,
    pub locked: Option<&'static str>,
}

/// `StartupTaskState` (Disabled 0, DisabledByUser 1, Enabled 2, DisabledByPolicy 3, EnabledByPolicy 4) as the switch shows it (pure).
pub fn autostart_info(state: i32) -> AutostartInfo {
    AutostartInfo {
        enabled: matches!(state, 2 | 4),
        locked: match state {
            1 => Some("user"),
            3 | 4 => Some("policy"),
            _ => None,
        },
    }
}

/// What turning the task on or off ended in (pure): Ok, or the reason it did not work. A task the person disabled in Windows cannot be turned on by
/// the app (Windows keeps the person's choice), and a policy decides for the organisation.
pub fn set_outcome(want_enabled: bool, state: i32) -> Result<(), &'static str> {
    let now = autostart_info(state);
    match (now.locked, now.enabled == want_enabled) {
        (Some("user"), _) => Err("start at sign-in is turned off in Windows (Settings > Apps > Startup)"),
        (Some(_), _) => Err("start at sign-in is managed by your organization"),
        (None, true) => Ok(()),
        (None, false) => Err("Windows did not change the start at sign-in setting"),
    }
}

/// The Windows Runtime calls below may run on a thread that no one gave a COM apartment (a command's thread of the pool): once per process an MTA is kept alive, so
/// that every thread without an apartment of its own is a member of it.
#[cfg(windows)]
fn ensure_mta() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() };
    });
}

/// The state of the startup task now.
#[cfg(windows)]
pub fn startup_task_state() -> Result<i32, String> {
    use windows::ApplicationModel::StartupTask;
    ensure_mta();
    let task = StartupTask::GetAsync(&windows::core::HSTRING::from(STARTUP_TASK_ID)).and_then(|op| op.join()).map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))?;
    task.State().map(|s| s.0).map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))
}
#[cfg(not(windows))]
pub fn startup_task_state() -> Result<i32, String> {
    Err("no startup task on this system".into())
}

/// Turns the startup task on (no dialog: a packaged desktop app asks nothing) or off, and says how it ended.
#[cfg(windows)]
pub fn set_startup_task(enabled: bool) -> Result<(), String> {
    use windows::ApplicationModel::StartupTask;
    ensure_mta();
    let task = StartupTask::GetAsync(&windows::core::HSTRING::from(STARTUP_TASK_ID)).and_then(|op| op.join()).map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))?;
    let state = if enabled {
        task.RequestEnableAsync().and_then(|op| op.join()).map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))?.0
    } else {
        task.Disable().map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))?;
        task.State().map_err(|e| format!("the startup task {STARTUP_TASK_ID}: {e}"))?.0
    };
    set_outcome(enabled, state).map_err(String::from)
}
#[cfg(not(windows))]
pub fn set_startup_task(_enabled: bool) -> Result<(), String> {
    Err("no startup task on this system".into())
}

/// The switch of Settings > Notifications & tray in a package (the state of the startup task; an unreadable task shows off and unlocked).
pub fn autostart_now() -> AutostartInfo {
    startup_task_state().map(autostart_info).unwrap_or(AutostartInfo { enabled: false, locked: None })
}

/// Debug builds with the simulation on: `HEYLOOK_SIMULATE_AUTOSTART_LOCK=user|policy` forces the locked state (QA of the two hints in 8 languages).
#[cfg(debug_assertions)]
pub fn simulated_autostart_lock() -> Option<AutostartInfo> {
    if !simulated() {
        return None;
    }
    match std::env::var("HEYLOOK_SIMULATE_AUTOSTART_LOCK").ok().as_deref() {
        Some("user") => Some(autostart_info(1)),
        Some("policy") => Some(autostart_info(3)),
        _ => None,
    }
}
#[cfg(not(debug_assertions))]
pub fn simulated_autostart_lock() -> Option<AutostartInfo> {
    None
}

/// Was this process started by the package's startup task (at sign-in)? Such a start behaves like a start with `--minimized`: the tray only (when there is one).
/// Asked once; false when unpackaged or when Windows does not say.
pub fn started_by_startup_task() -> bool {
    static BY_TASK: OnceLock<bool> = OnceLock::new();
    *BY_TASK.get_or_init(|| {
        #[cfg(windows)]
        {
            use windows::ApplicationModel::Activation::ActivationKind;
            if !packaged() {
                return false;
            }
            ensure_mta();
            true && windows::ApplicationModel::AppInstance::GetActivatedEventArgs().and_then(|a| a.Kind()).map(|k| k == ActivationKind::StartupTask).unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
}

/// The directories override of tauri's config for a packaged run (pure): the data folder is `LocalState`, the web view's folder `LocalCache`.
/// Everything else keeps tauri's choice (nothing else of the app asks for the config, cache or log folder).
pub fn directories_override(d: &Dirs) -> tauri::utils::config::AppDirectoriesOverride {
    tauri::utils::config::AppDirectoriesOverride::Directories(tauri::utils::config::AppDirectoryOverrides {
        data: Some(d.local_state.clone()),
        local_data: Some(d.local_cache.clone()),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = "40278Noamo.651773BC9C4C7_p3yr7tk4wrq2g";

    #[test]
    fn family_names() {
        assert!(is_family_name(FAMILY));
        assert!(is_family_name("HeyLook.Dev_abcdefghijklm"));
        for bad in ["", "x", "no-underscore", "_p3yr7tk4wrq2g", "ab_p3yr7tk4wrq2g", "40278Noamo.651773BC9C4C7_p3yr7tk4wrq2", "40278Noamo.651773BC9C4C7_P3YR7TK4WRQ2G", "a b c_p3yr7tk4wrq2g", "..\\x_p3yr7tk4wrq2g", "a/b/c_p3yr7tk4wrq2g", "..evil.._p3yr7tk4wrq2g", ".hidden_p3yr7tk4wrq2g"] {
            assert!(!is_family_name(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn package_folders() {
        let local = if cfg!(windows) { PathBuf::from(r"C:\Users\x\AppData\Local") } else { PathBuf::from("/home/x/AppData/Local") };
        let d = dirs_for(&local, FAMILY).unwrap();
        assert_eq!(d.local_state, local.join("Packages").join(FAMILY).join("LocalState"));
        assert_eq!(d.local_cache, local.join("Packages").join(FAMILY).join("LocalCache"));
        assert_eq!(d.temp_state, local.join("Packages").join(FAMILY).join("TempState"));
        assert!(dirs_for(&local, "x").is_none(), "a odd family name makes no folder");
        assert!(dirs_for(Path::new("relative"), FAMILY).is_none(), "a relative AppData is refused");
        // never the folder of an unpackaged copy
        for p in [&d.local_state, &d.local_cache, &d.temp_state] {
            assert!(!p.to_string_lossy().contains("thnonl.heylook"));
        }
    }

    #[test]
    fn the_folder_of_the_attachments() {
        let sys = if cfg!(windows) { PathBuf::from(r"C:\Temp") } else { PathBuf::from("/tmp") };
        assert_eq!(temp_root_for(None, &sys), sys.join("HeyLook"), "unpackaged: as before");
        let local = if cfg!(windows) { PathBuf::from(r"C:\Users\x\AppData\Local") } else { PathBuf::from("/home/x/Local") };
        let d = dirs_for(&local, FAMILY).unwrap();
        assert_eq!(temp_root_for(Some(&d), &sys), d.temp_state.join("HeyLook"));
        assert!(!temp_root_for(Some(&d), &sys).starts_with(&sys));
    }

    #[test]
    fn the_startup_task_as_the_switch_shows_it() {
        // Disabled 0, DisabledByUser 1, Enabled 2, DisabledByPolicy 3, EnabledByPolicy 4
        assert_eq!(autostart_info(0), AutostartInfo { enabled: false, locked: None });
        assert_eq!(autostart_info(1), AutostartInfo { enabled: false, locked: Some("user") });
        assert_eq!(autostart_info(2), AutostartInfo { enabled: true, locked: None });
        assert_eq!(autostart_info(3), AutostartInfo { enabled: false, locked: Some("policy") });
        assert_eq!(autostart_info(4), AutostartInfo { enabled: true, locked: Some("policy") });
        assert_eq!(autostart_info(99), AutostartInfo { enabled: false, locked: None }, "an unknown state is off and not locked");
    }

    #[test]
    fn what_turning_it_on_or_off_ended_in() {
        assert_eq!(set_outcome(true, 2), Ok(()));
        assert_eq!(set_outcome(false, 0), Ok(()));
        assert!(set_outcome(true, 0).is_err(), "Windows left it off");
        assert!(set_outcome(false, 2).is_err(), "Windows left it on");
        assert!(set_outcome(true, 1).unwrap_err().contains("Windows"), "the person turned it off in Windows");
        assert!(set_outcome(false, 1).unwrap_err().contains("Windows"));
        assert!(set_outcome(true, 3).unwrap_err().contains("organization"));
        assert!(set_outcome(false, 4).unwrap_err().contains("organization"));
    }

    #[test]
    fn the_override_moves_the_data_and_the_web_view_only() {
        use tauri::utils::config::AppDirectoriesOverride as O;
        let local = if cfg!(windows) { PathBuf::from(r"C:\Users\x\AppData\Local") } else { PathBuf::from("/home/x/Local") };
        let d = dirs_for(&local, FAMILY).unwrap();
        match directories_override(&d) {
            O::Directories(o) => {
                assert_eq!(o.data.as_deref(), Some(d.local_state.as_path()));
                assert_eq!(o.local_data.as_deref(), Some(d.local_cache.as_path()));
                assert!(o.config.is_none() && o.cache.is_none() && o.log.is_none());
            }
            O::Root(_) => panic!("a root would put every folder into one"),
        }
    }

    #[test]
    fn a_test_process_is_not_packaged() {
        assert!(!packaged());
        assert!(dirs().is_none());
        assert!(process_aumid().is_none());
        assert!(!started_by_startup_task());
        assert_eq!(autostart_now(), AutostartInfo { enabled: false, locked: None });
    }

    /// The simulation (WA.2.1) switches the UI and updater logic only and does not exist in a release build.
    #[test]
    fn the_simulation_is_debug_only_and_never_reaches_paths_or_the_system() {
        let src = include_str!("pkg.rs");
        let code: String = src[..src.find("#[cfg(test)]").unwrap()].lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        // the environment variables are read only inside functions that exist in debug builds
        for name in ["HEYLOOK_SIMULATE_PACKAGED", "HEYLOOK_SIMULATE_AUTOSTART_LOCK"] {
            let at = code.find(name).unwrap_or_else(|| panic!("{name} is not read"));
            let before = &code[..at];
            let last_cfg = before.rfind("#[cfg(").unwrap();
            assert!(before[last_cfg..].starts_with("#[cfg(debug_assertions)]"), "{name} is read outside a #[cfg(debug_assertions)] function");
        }
        assert_eq!(code.matches("HEYLOOK_SIMULATE_PACKAGED").count(), 1, "one place reads it");
        // `simulated` is used by `ui_packaged` and the lock seam only
        let uses = code.matches("simulated()").count();
        assert_eq!(uses, 4, "the two definitions, ui_packaged and simulated_autostart_lock, nothing else (found {uses})");
        // the other files: only update.rs (managed_by) and lib.rs (the autostart commands) may ask for the UI form; paths, identity, the shell read `packaged`
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != "rs") {
                continue;
            }
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&p).unwrap();
            let body = &text[..text.find("#[cfg(test)]").unwrap_or(text.len())];
            let asks = body.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains("pkg::ui_packaged") || l.contains("pkg::simulated_autostart_lock"));
            if asks {
                assert!(name == "update.rs" || name == "lib.rs", "{name} asks for the simulated form: paths, identity and the shell must use pkg::packaged()");
            }
        }
    }
}
