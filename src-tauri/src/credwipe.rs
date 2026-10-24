//! `hey-look.exe --remove-saved-credentials`: removes the passwords and tokens this app saved in the system credential store, then ends (WP14 W14.4,
//! REQ-14.4.2 b). The Windows uninstaller runs it when the person ticks "Delete the application data" (src-tauri/nsis/hooks.nsh), so an uninstall that is
//! meant to leave nothing behind leaves nothing in Credential Manager either (`cmdkey /list | findstr /i heylook`).
//!
//! It removes only what the released app saved: the entries of the service `heylook` (identity.rs `KEYRING_SERVICE_RELEASE`). Windows names such an entry
//! `<user>.<service>` (keyring's Windows store), so the targets that end in `.heylook` are the ones (the whole list of the person's credentials is read, only the
//! names, and only the matching ones are deleted). A test copy (`heylook.qa`) and the Microsoft Store version
//! (`heylook.store`, which Windows keeps apart and which has its own uninstall) never match. It starts no window, no web view, no database and takes
//! no single-instance lock: it only talks to the credential store and returns the exit code (0 = done, also when there was nothing, 1 = a failure).

/// The command line argument.
pub const FLAG: &str = "--remove-saved-credentials";

/// Is this a run that only removes the saved credentials (the flag among the arguments, the program name not counted)?
pub fn wanted(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == FLAG)
}

#[cfg(any(windows, test))] // (the removal itself is Windows; the rules are compiled for the tests everywhere)
/// Is the credential `target` (`<user>.<service>`) one of the service `service`, with a user in front of it (pure)?
pub fn is_ours(target: &str, service: &str) -> bool {
    target.len() > service.len() + 1 && target.ends_with(&format!(".{service}"))
}

#[cfg(any(windows, test))]
/// What a run did, for the exit code and the tests: the targets found and how many were removed.
#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub found: usize,
    pub removed: usize,
}

#[cfg(any(windows, test))]
/// The removal itself against any store (the real one on Windows, a list in the test): every target of the service is deleted, one that cannot be
/// deleted is counted and skipped.
pub fn remove_all(targets: &[String], service: &str, delete: &mut dyn FnMut(&str) -> bool) -> Outcome {
    let ours: Vec<&String> = targets.iter().filter(|t| is_ours(t, service)).collect();
    let removed = ours.iter().filter(|t| delete(t)).count();
    Outcome { found: ours.len(), removed }
}

#[cfg(any(windows, test))]
/// The exit code of a run: 0 when everything that was found is gone (also when nothing was found), 1 otherwise.
pub fn exit_code(o: &Outcome) -> i32 {
    if o.removed == o.found { 0 } else { 1 }
}

#[cfg(windows)]
pub fn run() -> i32 {
    use windows::Win32::Security::Credentials::{CredDeleteW, CredEnumerateW, CredFree, CRED_ENUMERATE_FLAGS, CRED_TYPE_GENERIC};
    let service = crate::identity::KEYRING_SERVICE_RELEASE;
    let mut count = 0u32;
    let mut list: *mut *mut windows::Win32::Security::Credentials::CREDENTIALW = std::ptr::null_mut();
    let mut targets = Vec::new();
    // (nothing found is an error of Windows, ERROR_NOT_FOUND: that is a clean end, not a failure)
    // (no filter: Windows only takes a name PREFIX followed by `*`, and our entries are recognised by the end of their name; only the names are read here)
    if unsafe { CredEnumerateW(windows::core::PCWSTR::null(), Some(CRED_ENUMERATE_FLAGS(0)), &mut count, &mut list) }.is_ok() {
        for i in 0..count as usize {
            let cred = unsafe { *list.add(i) };
            if cred.is_null() {
                continue;
            }
            let name = unsafe { (*cred).TargetName };
            if !name.is_null() {
                targets.push(unsafe { name.to_string() }.unwrap_or_default());
            }
        }
        unsafe { CredFree(list as *const core::ffi::c_void) };
    }
    let outcome = remove_all(&targets, service, &mut |t| unsafe { CredDeleteW(&windows::core::HSTRING::from(t), CRED_TYPE_GENERIC, None) }.is_ok());
    exit_code(&outcome)
}

#[cfg(not(windows))]
pub fn run() -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn the_flag() {
        assert!(wanted(&s(&["hey-look.exe", "--remove-saved-credentials"])));
        assert!(wanted(&s(&["C:\\Program Files\\Hey Look!\\hey-look.exe", "x", "--remove-saved-credentials"])));
        assert!(!wanted(&s(&["--remove-saved-credentials"])), "the first argument is the program");
        assert!(!wanted(&s(&["hey-look.exe", "--remove-saved-credentials=1", "remove-saved-credentials", "--minimized"])));
        assert!(!wanted(&s(&["hey-look.exe"])));
    }

    #[test]
    fn only_the_entries_of_the_released_service() {
        let svc = "heylook";
        assert!(is_ours("a1b2.heylook", svc));
        assert!(is_ours("a1b2:smtp.heylook", svc));
        assert!(is_ours("secret:ai_key.heylook", svc));
        for no in ["a1b2.heylook.qa", "a1b2.heylook.store", "a1b2.hey-mail", "heylook", ".heylook", "x.notheylook", "Google Chrome", "a1b2.heylook ", "heylook.heylook.store"] {
            assert!(!is_ours(no, svc), "{no:?} is not ours");
        }
    }

    #[test]
    fn removal_counts_and_never_touches_other_entries() {
        let found = s(&["a.heylook", "b:smtp.heylook", "c.heylook.qa", "d.heylook.store", "e.other"]);
        let mut deleted = Vec::new();
        let out = remove_all(&found, "heylook", &mut |t| {
            deleted.push(t.to_string());
            true
        });
        assert_eq!(out, Outcome { found: 2, removed: 2 });
        assert_eq!(deleted, s(&["a.heylook", "b:smtp.heylook"]));
        assert_eq!(exit_code(&out), 0);
        // nothing there: a clean end
        assert_eq!(exit_code(&remove_all(&[], "heylook", &mut |_| true)), 0);
        // one that cannot be deleted: a failure, the others are still removed
        let mut calls = 0;
        let out = remove_all(&s(&["a.heylook", "b.heylook", "c.heylook"]), "heylook", &mut |_| {
            calls += 1;
            calls != 2
        });
        assert_eq!(out, Outcome { found: 3, removed: 2 });
        assert_eq!(exit_code(&out), 1);
    }

    /// The run is wired first in `run()` (before anything is created) and only for the flag.
    #[test]
    fn it_runs_before_anything_else() {
        let lib = include_str!("lib.rs");
        let at = lib.find("pub fn run() {").expect("run()");
        let body = &lib[at..];
        let wipe = body.find("credwipe::wanted").expect("run() checks the flag");
        assert!(wipe < body.find("startup::init_clock()").unwrap(), "before the clock, the config and the app");
        assert!(body[wipe..].contains("std::process::exit(credwipe::run())"));
    }
}
