//! The names this process uses in places that are shared with other copies of the app on the same machine: the system credential
//! store (service name) and the Windows notification registration (AppUserModelID).
//!
//! The released app uses `heylook` / `thnonl.heylook`. A copy that must not touch the real ones (a debug build run on a test data
//! folder, `HEYLOOK_DATA_DIR`, see `legacy_names::data_dir_overridden`, or a build with another app identifier, e.g. `thnonl.heylook.qa`)
//! uses `heylook.qa` / `thnonl.heylook.qa`. The credential store and the registry cannot be redirected like the data folder, so the
//! name is the only separation: a test run can neither read nor overwrite the owner's AI key or tokens.
//!
//! EVERY credential store access goes through `entry` (the only place that builds a `keyring::Entry`, see `source_guard`).

/// Application identifier of the released app (tauri.conf.json).
pub const SHIPPED_ID: &str = "thnonl.heylook";
/// Credential store service of the released app.
pub const KEYRING_SERVICE_RELEASE: &str = "heylook";
/// Credential store service of every isolated (test) copy.
pub const KEYRING_SERVICE_QA: &str = "heylook.qa";
/// Suffix of the AppUserModelID of an isolated copy whose identifier is still the shipped one.
const QA_SUFFIX: &str = ".qa";

use std::sync::OnceLock;

static IDENTIFIER: OnceLock<String> = OnceLock::new();
static ISOLATED: OnceLock<bool> = OnceLock::new();
static AUMID: OnceLock<String> = OnceLock::new();

/// Called once at the start of `run`, with the identifier from the Tauri config, before anything reads a name.
pub fn init(identifier: &str) {
    let _ = IDENTIFIER.set(identifier.to_string());
}

/// The application identifier of this build (the shipped one before `init`, e.g. in unit tests).
pub fn identifier() -> &'static str {
    IDENTIFIER.get().map(String::as_str).unwrap_or(SHIPPED_ID)
}

/// Whether the web view's inspector is switched off for this copy (D-037). Inspect Element in the native menus of a text field and F12 / Ctrl+Shift+I exist only in a debug build
/// (tauri's `devtools` feature is not enabled, Cargo.toml, so a RELEASE build has no inspector under any condition). A QA build is a debug build on its own identifier or
/// data folder: its native menus must be those of the release, so its windows are made without the inspector. A developer who wants it on such a copy sets
/// `HEYLOOK_DEVTOOLS=1`; `tauri dev` (the shipped identifier, no test data folder) keeps it. The QA's remote control (the test bridge, CDP on Windows) does not use it.
pub fn devtools_off() -> bool {
    devtools_off_for(cfg!(debug_assertions), isolated(), std::env::var("HEYLOOK_DEVTOOLS").ok().as_deref())
}

/// Pure decision of `devtools_off`.
pub fn devtools_off_for(debug_build: bool, isolated: bool, keep: Option<&str>) -> bool {
    debug_build && isolated && keep != Some("1")
}

/// Pure decision: isolated when a test data folder is in use or the identifier is not the shipped one.
pub fn is_isolated_for(identifier: &str, data_dir_overridden: bool) -> bool {
    data_dir_overridden || identifier != SHIPPED_ID
}

pub fn isolated() -> bool {
    *ISOLATED.get_or_init(|| is_isolated_for(identifier(), crate::legacy_names::data_dir_overridden()))
}

/// Credential store service for a copy (pure): an isolated (test) copy has its own, the Microsoft Store version (a package, pkg.rs) has its own so that it
/// shares nothing with a GitHub install on the same PC, every other copy uses the shipped one. A test copy that happens to run packaged stays isolated.
pub fn keyring_service_for(isolated: bool, packaged: bool) -> &'static str {
    if isolated {
        KEYRING_SERVICE_QA
    } else if packaged {
        crate::pkg::KEYRING_SERVICE_STORE
    } else {
        KEYRING_SERVICE_RELEASE
    }
}

/// AppUserModelID for a copy (pure): the identifier itself when it is not the shipped one, the shipped one plus `.qa` for a
/// test data folder under the shipped identifier, else the shipped one.
pub fn aumid_for(identifier: &str, data_dir_overridden: bool) -> String {
    if identifier != SHIPPED_ID {
        identifier.to_string()
    } else if data_dir_overridden {
        format!("{SHIPPED_ID}{QA_SUFFIX}")
    } else {
        SHIPPED_ID.to_string()
    }
}

/// The credential store service of this process.
pub fn keyring_service() -> &'static str {
    keyring_service_for(isolated(), crate::pkg::packaged())
}

/// The AppUserModelID of this process (registered in the registry and used by the toasts).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn aumid() -> &'static str {
    AUMID.get_or_init(|| aumid_choice(identifier(), crate::legacy_names::data_dir_overridden(), crate::pkg::process_aumid().as_deref())).as_str()
}

/// The AppUserModelID of a process (pure): the package's own (`<family>!App`) when it runs in a package and is not an isolated copy, else the derived one.
pub fn aumid_choice(identifier: &str, data_dir_overridden: bool, process_aumid: Option<&str>) -> String {
    match process_aumid {
        Some(own) if !is_isolated_for(identifier, data_dir_overridden) => own.to_string(),
        _ => aumid_for(identifier, data_dir_overridden),
    }
}

/// A credential: the system store's entry, or (cargo feature `qa-secrets`, QA kits only) a record in the JSON file of `qasecrets.rs`. Callers use the three methods and
/// cannot tell which one it is; the choice is made in `entry_in` and nowhere else.
pub struct Cred(CredKind);

#[cfg_attr(feature = "qa-secrets", allow(dead_code))] // (the system store is not built into a QA-secrets kit)
enum CredKind {
    Os(keyring::Entry),
    #[cfg(feature = "qa-secrets")]
    File { service: String, user: String },
}

impl Cred {
    pub fn get_password(&self) -> keyring::Result<String> {
        match &self.0 {
            CredKind::Os(e) => e.get_password(),
            #[cfg(feature = "qa-secrets")]
            CredKind::File { service, user } => qa_store().and_then(|s| s.get(service, user).ok_or(keyring::Error::NoEntry)),
        }
    }

    pub fn set_password(&self, value: &str) -> keyring::Result<()> {
        match &self.0 {
            CredKind::Os(e) => e.set_password(value),
            #[cfg(feature = "qa-secrets")]
            CredKind::File { service, user } => qa_store().and_then(|s| s.set(service, user, value).map_err(|e| keyring::Error::PlatformFailure(Box::new(e)))),
        }
    }

    pub fn delete_credential(&self) -> keyring::Result<()> {
        match &self.0 {
            CredKind::Os(e) => e.delete_credential(),
            #[cfg(feature = "qa-secrets")]
            CredKind::File { service, user } => qa_store().and_then(|s| match s.delete(service, user) {
                Ok(true) => Ok(()),
                Ok(false) => Err(keyring::Error::NoEntry),
                Err(e) => Err(keyring::Error::PlatformFailure(Box::new(e))),
            }),
        }
    }
}

#[cfg(feature = "qa-secrets")]
static QA_STORE: OnceLock<crate::qasecrets::FileStore> = OnceLock::new();

/// Called at the start with the data folder (a no-op without the feature): from then on the credentials of this copy are in `<data folder>/qa-secrets.json`.
pub fn init_qa_store(_data_dir: &std::path::Path) {
    #[cfg(feature = "qa-secrets")]
    {
        let _ = QA_STORE.set(crate::qasecrets::FileStore::new(_data_dir.join(crate::qasecrets::FILE_NAME)));
        crate::startup::line("secrets", "QA file store in use (qa-secrets.json in the data folder); the system credential store is not used");
    }
}

#[cfg(feature = "qa-secrets")]
fn qa_store() -> keyring::Result<&'static crate::qasecrets::FileStore> {
    QA_STORE.get().ok_or_else(|| keyring::Error::Invalid("store".into(), "the QA file store is not initialised yet".into()))
}

/// The credential store entry `user` of this process. The one function in the app that builds a credential.
pub fn entry(user: &str) -> keyring::Result<Cred> {
    entry_in(keyring_service(), user)
}

/// An entry under an explicit service (only the migration of the old service name needs this). An isolated copy is refused
/// every service but its own: it can never touch the owner's entries, whatever a caller asks for.
pub fn entry_in(service: &str, user: &str) -> keyring::Result<Cred> {
    if !service_allowed(isolated(), service) {
        return Err(keyring::Error::Invalid("service".into(), "this copy of the app is isolated from the real credentials".into()));
    }
    #[cfg(feature = "qa-secrets")]
    return Ok(Cred(CredKind::File { service: service.to_string(), user: user.to_string() }));
    #[cfg(not(feature = "qa-secrets"))]
    keyring::Entry::new(service, user).map(|e| Cred(CredKind::Os(e)))
}

/// Pure guard: an isolated copy may only use the isolated service.
pub fn service_allowed(isolated: bool, service: &str) -> bool {
    !isolated || service == KEYRING_SERVICE_QA
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn released_app_keeps_its_names() {
        assert_eq!(KEYRING_SERVICE_RELEASE, "heylook");
        assert_eq!(keyring_service_for(false, false), "heylook");
        assert_eq!(SHIPPED_ID, "thnonl.heylook");
        assert_eq!(aumid_for("thnonl.heylook", false), "thnonl.heylook");
        assert!(!is_isolated_for("thnonl.heylook", false));
    }

    #[test]
    fn test_copies_get_other_names() {
        assert_eq!(keyring_service_for(true, false), "heylook.qa");
        assert_ne!(keyring_service_for(true, false), keyring_service_for(false, false));
        assert!(is_isolated_for("thnonl.heylook", true));
        assert!(is_isolated_for("thnonl.heylook.qa", false));
        assert_eq!(aumid_for("thnonl.heylook", true), "thnonl.heylook.qa");
        assert_eq!(aumid_for("thnonl.heylook.qa", false), "thnonl.heylook.qa");
        assert_eq!(aumid_for("thnonl.heylook.qa", true), "thnonl.heylook.qa");
    }

    #[test]
    fn isolated_copy_cannot_use_the_real_service() {
        assert!(service_allowed(false, "heylook"));
        assert!(service_allowed(false, "hey-mail")); // (the released app's one-time migration of the oldest name)
        assert!(service_allowed(true, "heylook.qa"));
        assert!(!service_allowed(true, "heylook"));
        assert!(!service_allowed(true, "hey-mail"));
    }

    /// WP14 WA.2.3 / A-16: the Store version keeps its passwords and tokens apart from a GitHub install on the same PC; nothing else changes.
    #[test]
    fn the_store_version_has_its_own_credential_service() {
        assert_eq!(keyring_service_for(false, true), "heylook.store");
        assert_eq!(crate::pkg::KEYRING_SERVICE_STORE, "heylook.store");
        assert_eq!(keyring_service_for(false, false), "heylook", "unpackaged copies are as before");
        assert_eq!(keyring_service_for(true, false), "heylook.qa");
        assert_eq!(keyring_service_for(true, true), "heylook.qa", "a test copy never touches real credentials, packaged or not");
        // the three services are three different names
        let names = [keyring_service_for(false, false), keyring_service_for(false, true), keyring_service_for(true, false)];
        assert_eq!(names.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    }

    /// WP14 WA.2.4 / A-13: a packaged process shows its toasts under its package AppUserModelID; an unpackaged or an isolated copy keeps the derived one.
    #[test]
    fn the_toasts_of_a_package_use_the_package_id() {
        assert_eq!(aumid_choice("thnonl.heylook", false, Some("40278Noamo.651773BC9C4C7_p3yr7tk4wrq2g!App")), "40278Noamo.651773BC9C4C7_p3yr7tk4wrq2g!App");
        assert_eq!(aumid_choice("thnonl.heylook", false, None), "thnonl.heylook", "unpackaged: as before");
        assert_eq!(aumid_choice("thnonl.heylook", true, Some("x_p3yr7tk4wrq2g!App")), "thnonl.heylook.qa", "a test copy keeps its own id");
        assert_eq!(aumid_choice("thnonl.heylook.qa", false, Some("x_p3yr7tk4wrq2g!App")), "thnonl.heylook.qa");
    }

    /// Strip comments and everything from the first `#[cfg(test)]` on.
    fn production_code(src: &str) -> String {
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        src[..end].lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
    }

    fn sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push((p.display().to_string(), std::fs::read_to_string(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
        out
    }

    /// D-037: only a debug build on an isolated copy (a QA build) is made without the inspector; a developer can keep it; a normal `tauri dev` run and a release build are not touched.
    #[test]
    fn a_qa_build_has_no_inspector_and_nothing_else_changes() {
        assert!(devtools_off_for(true, true, None), "a debug build on a test copy");
        assert!(!devtools_off_for(true, true, Some("1")), "HEYLOOK_DEVTOOLS=1 keeps it");
        assert!(devtools_off_for(true, true, Some("0")) && devtools_off_for(true, true, Some("")), "only 1 keeps it");
        assert!(!devtools_off_for(true, false, None), "tauri dev on the shipped identifier keeps it");
        assert!(!devtools_off_for(false, true, None) && !devtools_off_for(false, false, None), "a release build is not touched here (it has no inspector: Cargo.toml has no `devtools` feature)");
    }

    /// D-037: the claim in the comment of `devtools_off` is checked: tauri's `devtools` feature, which would put the inspector into a release build, is not enabled.
    #[test]
    fn a_release_build_has_no_devtools_feature() {
        let cargo = include_str!("../Cargo.toml");
        let tauri_line = cargo.lines().find(|l| l.trim_start().starts_with("tauri = ")).expect("the tauri dependency");
        assert!(!tauri_line.contains("devtools"), "{tauri_line}");
        assert!(!cargo.lines().any(|l| l.contains("devtools") && !l.trim_start().starts_with('#')), "no crate of Cargo.toml asks for devtools");
    }

    #[test]
    fn source_guard_one_place_builds_credential_entries() {
        for (path, src) in sources() {
            let code = production_code(&src);
            let n = code.matches("Entry::new").count();
            if path.ends_with("identity.rs") {
                assert_eq!(n, 1, "identity.rs builds exactly one keyring Entry (in entry_in)");
            } else {
                assert_eq!(n, 0, "{path}: build credential entries with identity::entry, not keyring::Entry::new");
            }
            if !path.ends_with("identity.rs") {
                assert!(!code.contains("\"heylook\""), "{path}: the service name lives in identity.rs only");
                let bare = code.split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|w| w == "KEYRING_SERVICE");
                assert!(!bare, "{path}: use identity::entry");
            }
        }
    }

    #[test]
    fn source_guard_toast_and_registry_use_the_derived_aumid() {
        for (path, src) in sources() {
            let code = production_code(&src);
            if path.ends_with("identity.rs") {
                continue;
            }
            // the shipped id as a literal may appear only in the legacy file (old-name cleanup) and the webview folder helper
            assert!(!code.contains("\"thnonl.heylook\""), "{path}: use identity::aumid() / identity::identifier()");
            assert!(!code.contains("shell::AUMID") && !code.contains("{AUMID}") && !code.contains("Toast::new(AUMID)"), "{path}: use identity::aumid()");
        }
    }
}
