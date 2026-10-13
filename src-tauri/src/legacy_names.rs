//! Data saved by earlier builds under the old product name, moved to the current names once.
//!
//! THIS IS THE ONLY FILE THAT MAY CONTAIN THE OLD NAMES (the old app identifier, `heymail.db`, the old keyring service, the old
//! notification id). Everything else uses the current names (`thnonl.heylook`, `heylook.db`, service `heylook`).
//!
//! What is migrated, each time at most once and never over something that already exists:
//! 1. the data folder `<data root>/<old identifier>` -> `<data root>/<new identifier>` (rename, or copy + byte-for-byte verify, and only
//!    then delete the old one);
//! 2. the database files inside it (`heymail.db`, `-wal`, `-shm`, the `pre-shard` backups) -> `heylook.db...`;
//! 3. the saved passwords, OAuth tokens and secrets in the system credential store (old service name -> new service name);
//! 4. on Windows, the notification registration of the old id is removed.
use crate::{db, lock, Db};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The identifier of the first builds; their data folder was `<data root>/<OLD_ID>`.
const OLD_ID: &str = "asia.elgaucho.heymail";
const OLD_DB: &str = "heymail.db";
const NEW_DB: &str = "heylook.db";
/// Credential store service name of the first builds (the new one is `crate::KEYRING_SERVICE`).
const OLD_KEYRING_SERVICE: &str = "hey-mail";
#[cfg(windows)]
const OLD_AUMID: &str = "asia.elgaucho.heylook";

// ---------- data folder ----------

#[derive(Debug, PartialEq)]
pub enum Decision {
    /// nothing to do, and why
    NoOp(&'static str),
    Migrate,
    /// something is in the way: leave everything as it is
    Refuse(String),
}

fn has_db(dir: &Path) -> bool {
    dir.join(OLD_DB).is_file() || dir.join(NEW_DB).is_file()
}

fn is_empty_dir(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
}

/// What to do about the old folder. Never overwrites an existing new folder.
pub fn decide(new_dir: &Path, old_dir: &Path) -> Decision {
    if has_db(new_dir) {
        return Decision::NoOp("the new data folder already has a database");
    }
    if !has_db(old_dir) {
        return Decision::NoOp("no data under the old name");
    }
    if new_dir.exists() && !is_empty_dir(new_dir) {
        return Decision::Refuse(format!("the new data folder {} exists and is not empty, so {} was not moved", new_dir.display(), old_dir.display()));
    }
    Decision::Migrate
}

#[derive(Debug, PartialEq)]
pub enum Moved {
    Renamed,
    Copied,
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    use std::io::Read;
    let (mut fa, mut fb) = (io::BufReader::new(fs::File::open(a)?), io::BufReader::new(fs::File::open(b)?));
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut x, mut y) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = fa.read(&mut x)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut y[..n])?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
    }
}

/// Every file of `a` exists in `b` with the same bytes, and `b` has nothing else.
fn same_tree(a: &Path, b: &Path) -> io::Result<bool> {
    let mut names_a: Vec<_> = fs::read_dir(a)?.map(|e| e.map(|e| e.file_name())).collect::<io::Result<_>>()?;
    let mut names_b: Vec<_> = fs::read_dir(b)?.map(|e| e.map(|e| e.file_name())).collect::<io::Result<_>>()?;
    names_a.sort();
    names_b.sort();
    if names_a != names_b {
        return Ok(false);
    }
    for n in names_a {
        let (pa, pb) = (a.join(&n), b.join(&n));
        let ok = if pa.is_dir() { pb.is_dir() && same_tree(&pa, &pb)? } else { pb.is_file() && same_bytes(&pa, &pb)? };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Move `old` to `new` (which does not exist, or is empty). `rename` is a parameter so that tests can make it fail.
/// A rename is the whole move. Without it (another drive, a file in use) the folder is copied next to `new`, compared byte for
/// byte, renamed into place, and only then is the old folder deleted. If anything fails nothing has been deleted.
pub fn move_dir(old: &Path, new: &Path, rename: &dyn Fn(&Path, &Path) -> io::Result<()>) -> Result<Moved, String> {
    if new.exists() {
        fs::remove_dir(new).map_err(|e| format!("the new folder exists and could not be replaced: {e}"))?; // only succeeds when empty
    }
    if rename(old, new).is_ok() {
        return Ok(Moved::Renamed);
    }
    let name = new.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = new.with_file_name(format!("{name}.migrating"));
    let _ = fs::remove_dir_all(&tmp); // left over from an attempt that did not finish
    let copied = copy_tree(old, &tmp).and_then(|_| same_tree(old, &tmp));
    match copied {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err("the copy differs from the original (a file changed while it was copied); the old folder was kept".into());
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(format!("copying failed: {e}; the old folder was kept"));
        }
    }
    fs::rename(&tmp, new).map_err(|e| format!("could not put the copy in place: {e}; the old folder was kept"))?;
    if let Err(e) = fs::remove_dir_all(old) {
        eprintln!("data migration: the data was copied, but the old folder {} could not be deleted: {e}", old.display());
    }
    Ok(Moved::Copied)
}

/// `heymail.db...` -> `heylook.db...` inside `dir` (the main file, `-wal`, `-shm`, the pre-shard backups). Only when the new main
/// file is not there yet, and never over an existing file.
pub fn rename_db_files(dir: &Path) -> Result<usize, String> {
    if dir.join(NEW_DB).exists() || !dir.join(OLD_DB).is_file() {
        return Ok(0);
    }
    let mut pairs: Vec<(PathBuf, PathBuf)> = vec![];
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(rest) = name.strip_prefix(OLD_DB) {
            if name != OLD_DB {
                pairs.push((e.path(), dir.join(format!("{NEW_DB}{rest}"))));
            }
        }
    }
    // the side files first, the main file last: SQLite pairs them by name
    pairs.push((dir.join(OLD_DB), dir.join(NEW_DB)));
    if let Some((_, to)) = pairs.iter().find(|(_, to)| to.exists()) {
        return Err(format!("{} already exists, so the database files were not renamed", to.display()));
    }
    for (from, to) in &pairs {
        fs::rename(from, to).map_err(|e| format!("could not rename {}: {e}", from.display()))?;
    }
    Ok(pairs.len())
}

/// The folder the app keeps its data in (and the log of what was moved). `new_dir` is the folder for the current identifier.
/// If the old data could not be moved this time, the old folder is used for this run (nothing is hidden from the user) and the
/// move is tried again at the next start.
pub fn resolve_data_dir(new_dir: PathBuf, log: &dyn Fn(&str)) -> PathBuf {
    resolve_with(new_dir, &|old, new| move_dir(old, new, &|a, b| fs::rename(a, b)), log)
}

fn resolve_with(new_dir: PathBuf, mover: &dyn Fn(&Path, &Path) -> Result<Moved, String>, log: &dyn Fn(&str)) -> PathBuf {
    let old_dir = new_dir.parent().map(|p| p.join(OLD_ID));
    let mut dir = new_dir.clone();
    if let Some(old_dir) = old_dir {
        match decide(&new_dir, &old_dir) {
            Decision::NoOp(why) => {
                if old_dir.exists() {
                    log(&format!("data migration: nothing to do ({why})"));
                }
            }
            Decision::Refuse(why) => log(&format!("data migration: {why}")),
            Decision::Migrate => match mover(&old_dir, &new_dir) {
                Ok(how) => log(&format!("data migration: moved {} to {} ({how:?})", old_dir.display(), new_dir.display())),
                Err(e) => {
                    log(&format!("data migration failed: {e}. Using the old folder for this session; it will be tried again at the next start."));
                    dir = old_dir;
                }
            },
        }
    }
    match rename_db_files(&dir) {
        Ok(0) => {}
        Ok(n) => log(&format!("data migration: renamed {n} database file(s) to the new name")),
        Err(e) => log(&format!("data migration: {e}")),
    }
    dir
}

/// The data folder for this run: the one of the current identifier, after the one-time migration. A DEBUG build never uses the real
/// folder unless `HEYLOOK_ALLOW_REAL_DATA=1` is set, see `choose_debug_data`; release builds always use it.
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    use tauri::Manager;
    #[cfg(debug_assertions)]
    let new_dir = match debug_data() {
        DebugData::Test(p) => p,
        DebugData::Default(p) => {
            eprintln!("debug build without a test data folder: using {} (set HEYLOOK_DATA_DIR or heylook-data-dir.txt to choose one, HEYLOOK_ALLOW_REAL_DATA=1 to use the real data)", p.display());
            p
        }
        DebugData::Real => app.path().app_data_dir()?,
    };
    #[cfg(not(debug_assertions))]
    let new_dir = app.path().app_data_dir()?;
    let dir = resolve_data_dir(new_dir, &|m| eprintln!("{m}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Name of the file next to the executable that names the test data folder (first line = path). Unlike the environment variable it
/// survives an installer-driven update and restart, where the new process may not inherit the environment.
const MARKER: &str = "heylook-data-dir.txt";

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn read_marker(exe_dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(exe_dir.join(MARKER)).ok()?;
    let line = text.trim_start_matches('\u{feff}').lines().next()?.trim().trim_matches('"');
    (!line.is_empty()).then(|| PathBuf::from(line))
}

/// Where a debug build keeps its data.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
enum DebugData {
    /// a test folder chosen with `HEYLOOK_DATA_DIR` or the marker file
    Test(PathBuf),
    /// nothing chosen: a throw-away folder, so a misplaced marker file or a forgotten variable can never reach the real data
    Default(PathBuf),
    /// explicitly asked for with `HEYLOOK_ALLOW_REAL_DATA=1`: the real data folder, with all migrations
    Real,
}

/// The decision: the environment variable, else the marker file, else (only with the explicit opt-in) the real folder, else a
/// throw-away folder. A chosen test folder wins over the opt-in.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn choose_debug_data(env_dir: Option<PathBuf>, marker: Option<PathBuf>, allow_real: bool, fallback: PathBuf) -> DebugData {
    if let Some(p) = env_dir.filter(|p| !p.as_os_str().is_empty()) {
        return DebugData::Test(p);
    }
    if let Some(p) = marker {
        return DebugData::Test(p);
    }
    if allow_real {
        DebugData::Real
    } else {
        DebugData::Default(fallback)
    }
}

#[cfg(debug_assertions)]
fn debug_data() -> DebugData {
    let marker = std::env::current_exe().ok().and_then(|e| e.parent().and_then(read_marker));
    choose_debug_data(
        std::env::var_os("HEYLOOK_DATA_DIR").map(PathBuf::from),
        marker,
        std::env::var("HEYLOOK_ALLOW_REAL_DATA").is_ok_and(|v| v == "1"),
        std::env::temp_dir().join("heylook-debug-data"),
    )
}

/// A debug build that is not on the real data: the system credential store and the registry cannot be redirected, so such a run must
/// not move the real ones (see `migrate_keyring`, `remove_old_notification_id`). Always false in release builds, which ignore the
/// variable, the marker file and the opt-in.
pub fn data_dir_overridden() -> bool {
    #[cfg(debug_assertions)]
    {
        debug_data() != DebugData::Real
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// The test data folder of a debug build (shown in Settings > About), None for release builds and for `HEYLOOK_ALLOW_REAL_DATA=1`.
pub fn test_data_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        match debug_data() {
            DebugData::Test(p) | DebugData::Default(p) => Some(p),
            DebugData::Real => None,
        }
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// The data folder in use (managed state).
pub struct DataDir(pub PathBuf);

// ---------- credential store ----------

/// The part of the credential store the migration needs (a fake in tests).
pub trait Creds {
    fn get(&self, service: &str, user: &str) -> Option<String>;
    fn set(&self, service: &str, user: &str, value: &str) -> bool;
    fn delete(&self, service: &str, user: &str);
}

pub struct SystemCreds;

impl Creds for SystemCreds {
    fn get(&self, service: &str, user: &str) -> Option<String> {
        keyring::Entry::new(service, user).ok()?.get_password().ok().filter(|s| !s.is_empty())
    }
    fn set(&self, service: &str, user: &str, value: &str) -> bool {
        keyring::Entry::new(service, user).and_then(|e| e.set_password(value)).is_ok()
    }
    fn delete(&self, service: &str, user: &str) {
        if let Ok(e) = keyring::Entry::new(service, user) {
            let _ = e.delete_credential();
        }
    }
}

/// Move every entry saved under the old service name to the current one: `users` are the credential names (account ids,
/// `<id>:smtp`, `secret:<name>`). An entry that already exists under the new name is kept as it is. The old entry is deleted only
/// after the new one reads back the same value. Returns how many were moved and whether everything went well.
pub fn migrate_creds(store: &dyn Creds, new_service: &str, users: &[String]) -> (usize, bool) {
    let (mut moved, mut ok) = (0, true);
    for user in users {
        let Some(value) = store.get(OLD_KEYRING_SERVICE, user) else { continue };
        if store.get(new_service, user).is_none() {
            if !store.set(new_service, user, &value) || store.get(new_service, user).as_deref() != Some(value.as_str()) {
                ok = false;
                continue;
            }
            moved += 1;
        }
        store.delete(OLD_KEYRING_SERVICE, user);
    }
    (moved, ok)
}

/// Once per install: the account ids come from the database, the secret names from `secret_names`.
pub fn migrate_keyring(db: &Db, secret_names: &[&str]) {
    let flag = "legacy_keyring_done";
    if data_dir_overridden() {
        return; // a test data folder: the real credentials stay where they are
    }
    if db::get_setting(&lock(db), flag).as_deref() == Some("1") {
        return;
    }
    let mut users: Vec<String> = secret_names.iter().map(|n| format!("secret:{n}")).collect();
    {
        let c = lock(db);
        if let Ok(mut st) = c.prepare("SELECT id FROM accounts") {
            if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
                for id in rows.flatten() {
                    users.push(format!("{id}:smtp"));
                    users.push(id);
                }
            }
        }
    }
    let (moved, ok) = migrate_creds(&SystemCreds, crate::KEYRING_SERVICE, &users);
    if moved > 0 {
        eprintln!("data migration: moved {moved} saved password(s) / token(s) to the new credential name");
    }
    if ok {
        let _ = db::set_setting(&lock(db), flag, "1");
    }
}

/// Windows: forget the notification registration of the old id.
#[cfg(windows)]
pub fn remove_old_notification_id() {
    use std::os::windows::process::CommandExt;
    if data_dir_overridden() {
        return;
    }
    let _ = std::process::Command::new("reg")
        .args(["delete", &format!(r"HKCU\Software\Classes\AppUserModelId\{OLD_AUMID}"), "/f"])
        .creation_flags(0x0800_0000)
        .output();
}

#[cfg(not(windows))]
pub fn remove_old_notification_id() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("heylook-legacy-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(name), bytes).unwrap();
    }

    #[test]
    fn decide_no_op_when_there_is_nothing_old() {
        let root = tmp("d1");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        assert_eq!(decide(&new, &old), Decision::NoOp("no data under the old name"));
        put(&old, "notes.txt", b"x"); // an old folder without a database is not ours to move
        assert_eq!(decide(&new, &old), Decision::NoOp("no data under the old name"));
    }

    #[test]
    fn decide_no_op_when_the_new_folder_has_a_database() {
        let root = tmp("d2");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, b"old");
        put(&new, NEW_DB, b"new");
        assert_eq!(decide(&new, &old), Decision::NoOp("the new data folder already has a database"));
    }

    #[test]
    fn decide_migrates_into_a_missing_or_empty_folder() {
        let root = tmp("d3");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, b"old");
        assert_eq!(decide(&new, &old), Decision::Migrate);
        fs::create_dir_all(&new).unwrap();
        assert_eq!(decide(&new, &old), Decision::Migrate);
        // an old folder whose database was already renamed (an interrupted earlier run) still counts
        fs::remove_file(old.join(OLD_DB)).unwrap();
        put(&old, NEW_DB, b"old");
        assert_eq!(decide(&new, &old), Decision::Migrate);
    }

    #[test]
    fn decide_refuses_to_overwrite_a_folder_with_content() {
        let root = tmp("d4");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, b"old");
        put(&new, "something.txt", b"mine");
        assert!(matches!(decide(&new, &old), Decision::Refuse(_)));
    }

    #[test]
    fn move_by_rename() {
        let root = tmp("m1");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, b"data");
        put(&old.join("sub"), "a.bin", b"1234");
        assert_eq!(move_dir(&old, &new, &|a, b| fs::rename(a, b)), Ok(Moved::Renamed));
        assert!(!old.exists());
        assert_eq!(fs::read(new.join(OLD_DB)).unwrap(), b"data");
        assert_eq!(fs::read(new.join("sub").join("a.bin")).unwrap(), b"1234");
    }

    #[test]
    fn move_by_verified_copy_when_rename_fails() {
        let root = tmp("m2");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, &vec![7u8; 200_000]);
        put(&old, "heymail.db-wal", b"wal");
        put(&old.join("sub"), "a.bin", b"1234");
        let fail = |_: &Path, _: &Path| -> io::Result<()> { Err(io::Error::other("another drive")) };
        assert_eq!(move_dir(&old, &new, &fail), Ok(Moved::Copied));
        assert!(!old.exists(), "deleted only after the copy was verified");
        assert_eq!(fs::read(new.join(OLD_DB)).unwrap().len(), 200_000);
        assert_eq!(fs::read(new.join("heymail.db-wal")).unwrap(), b"wal");
        assert_eq!(fs::read(new.join("sub").join("a.bin")).unwrap(), b"1234");
        assert!(!root.join("new.migrating").exists());
    }

    #[test]
    fn a_failed_move_leaves_the_old_folder_alone() {
        let root = tmp("m3");
        let (new, old) = (root.join("new"), root.join(OLD_ID));
        put(&old, OLD_DB, b"data");
        // the new folder cannot be created: a file with that name is in the way
        fs::write(&new, b"i am a file").unwrap();
        let fail = |_: &Path, _: &Path| -> io::Result<()> { Err(io::Error::other("no")) };
        assert!(move_dir(&old, &new, &fail).is_err());
        assert_eq!(fs::read(old.join(OLD_DB)).unwrap(), b"data");
    }

    #[test]
    fn tree_comparison_notices_differences() {
        let root = tmp("m4");
        let (a, b) = (root.join("a"), root.join("b"));
        put(&a, "f", b"same");
        put(&b, "f", b"same");
        assert!(same_tree(&a, &b).unwrap());
        put(&b, "f", b"diff");
        assert!(!same_tree(&a, &b).unwrap());
        put(&b, "f", b"same");
        put(&b, "extra", b"x");
        assert!(!same_tree(&a, &b).unwrap());
    }

    #[test]
    fn database_files_get_the_new_name() {
        let d = tmp("r1");
        for n in ["heymail.db", "heymail.db-wal", "heymail.db-shm", "heymail.db.pre-shard.bak", "heymail.db.pre-shard.1700000000.bak", "mail-a1.db", "icon.png"] {
            put(&d, n, n.as_bytes());
        }
        assert_eq!(rename_db_files(&d), Ok(5));
        for n in ["heylook.db", "heylook.db-wal", "heylook.db-shm", "heylook.db.pre-shard.bak", "heylook.db.pre-shard.1700000000.bak", "mail-a1.db", "icon.png"] {
            assert!(d.join(n).is_file(), "{n}");
        }
        assert!(!d.join(OLD_DB).exists() && !d.join("heymail.db-wal").exists());
        assert_eq!(fs::read(d.join("heylook.db")).unwrap(), b"heymail.db");
        // run again: nothing to do
        assert_eq!(rename_db_files(&d), Ok(0));
    }

    #[test]
    fn database_files_are_never_renamed_over_existing_ones() {
        let d = tmp("r2");
        put(&d, OLD_DB, b"old");
        put(&d, "heymail.db-wal", b"old wal");
        put(&d, "heylook.db-wal", b"stale");
        assert!(rename_db_files(&d).is_err());
        assert_eq!(fs::read(d.join(OLD_DB)).unwrap(), b"old");
        // a new database present: left alone
        let d2 = tmp("r3");
        put(&d2, OLD_DB, b"old");
        put(&d2, NEW_DB, b"new");
        assert_eq!(rename_db_files(&d2), Ok(0));
        assert_eq!(fs::read(d2.join(NEW_DB)).unwrap(), b"new");
    }

    #[test]
    fn an_interrupted_rename_is_finished_next_time() {
        // the side file was renamed, the crash came before the main file
        let d = tmp("r4");
        put(&d, OLD_DB, b"main");
        put(&d, "heylook.db-wal", b"wal already moved");
        assert_eq!(rename_db_files(&d), Ok(1));
        assert_eq!(fs::read(d.join("heylook.db")).unwrap(), b"main");
        assert_eq!(fs::read(d.join("heylook.db-wal")).unwrap(), b"wal already moved");
    }

    #[test]
    fn resolve_migrates_the_folder_and_the_database_names() {
        let root = tmp("x1");
        let (new, old) = (root.join("thnonl.heylook"), root.join(OLD_ID));
        put(&old, OLD_DB, b"mail");
        put(&old, "mail-a1.db", b"shard");
        let log = RefCell::new(vec![]);
        let dir = resolve_data_dir(new.clone(), &|m| log.borrow_mut().push(m.to_string()));
        assert_eq!(dir, new);
        assert_eq!(fs::read(new.join(NEW_DB)).unwrap(), b"mail");
        assert_eq!(fs::read(new.join("mail-a1.db")).unwrap(), b"shard");
        assert!(!old.exists());
        assert!(log.borrow().iter().any(|m| m.contains("moved")));
        // the second start does nothing
        log.borrow_mut().clear();
        assert_eq!(resolve_data_dir(new.clone(), &|m| log.borrow_mut().push(m.to_string())), new);
        assert_eq!(fs::read(new.join(NEW_DB)).unwrap(), b"mail");
    }

    #[test]
    fn resolve_leaves_an_existing_new_folder_untouched() {
        let root = tmp("x2");
        let (new, old) = (root.join("thnonl.heylook"), root.join(OLD_ID));
        put(&old, OLD_DB, b"old mail");
        put(&new, NEW_DB, b"new mail");
        assert_eq!(resolve_data_dir(new.clone(), &|_| {}), new);
        assert_eq!(fs::read(new.join(NEW_DB)).unwrap(), b"new mail");
        assert_eq!(fs::read(old.join(OLD_DB)).unwrap(), b"old mail");
    }

    #[test]
    fn resolve_without_old_data_does_nothing() {
        let root = tmp("x3");
        let new = root.join("thnonl.heylook");
        assert_eq!(resolve_data_dir(new.clone(), &|_| {}), new);
        assert!(!new.exists());
    }

    #[test]
    fn resolve_uses_the_old_folder_when_the_move_fails() {
        let root = tmp("x4");
        let (new, old) = (root.join("thnonl.heylook"), root.join(OLD_ID));
        put(&old, OLD_DB, b"mail");
        let dir = resolve_with(new.clone(), &|_, _| Err("disk full".into()), &|_| {});
        assert_eq!(dir, old);
        assert!(old.join(NEW_DB).is_file(), "named for the new app, found again by the next start");
        assert!(!new.exists());
        // the obstacle is gone: the next start moves it
        assert_eq!(resolve_data_dir(new.clone(), &|_| {}), new);
        assert_eq!(fs::read(new.join(NEW_DB)).unwrap(), b"mail");
        assert!(!old.exists());
    }

    #[test]
    fn resolve_leaves_a_blocked_new_path_alone() {
        let root = tmp("x5");
        let (new, old) = (root.join("thnonl.heylook"), root.join(OLD_ID));
        put(&old, OLD_DB, b"mail");
        fs::write(&new, b"a file in the way").unwrap();
        assert_eq!(resolve_data_dir(new.clone(), &|_| {}), new);
        assert_eq!(fs::read(old.join(OLD_DB)).unwrap(), b"mail");
    }

    #[test]
    fn marker_file_names_the_test_folder() {
        let d = tmp("mk");
        assert_eq!(read_marker(&d), None);
        put(&d, MARKER, b"\xEF\xBB\xBF\"E:/work/e2e-data/thnonl.heylook\"\r\nsecond line ignored\r\n");
        assert_eq!(read_marker(&d), Some(PathBuf::from("E:/work/e2e-data/thnonl.heylook")));
        put(&d, MARKER, b"   \n");
        assert_eq!(read_marker(&d), None);
    }

    #[test]
    fn a_debug_build_never_reaches_the_real_data_by_accident() {
        let fb = PathBuf::from("T:/heylook-debug-data");
        let p = |s: &str| Some(PathBuf::from(s));
        // nothing chosen: the throw-away folder
        assert_eq!(choose_debug_data(None, None, false, fb.clone()), DebugData::Default(fb.clone()));
        // an empty variable counts as not set
        assert_eq!(choose_debug_data(p(""), None, false, fb.clone()), DebugData::Default(fb.clone()));
        // the variable, then the marker file
        assert_eq!(choose_debug_data(p("E:/a"), p("E:/b"), false, fb.clone()), DebugData::Test(PathBuf::from("E:/a")));
        assert_eq!(choose_debug_data(None, p("E:/b"), false, fb.clone()), DebugData::Test(PathBuf::from("E:/b")));
        // only the explicit opt-in gives the real folder ...
        assert_eq!(choose_debug_data(None, None, true, fb.clone()), DebugData::Real);
        // ... and a chosen test folder still wins over it
        assert_eq!(choose_debug_data(p("E:/a"), None, true, fb.clone()), DebugData::Test(PathBuf::from("E:/a")));
        assert_eq!(choose_debug_data(None, p("E:/b"), true, fb), DebugData::Test(PathBuf::from("E:/b")));
    }

    // ---------- credentials ----------

    #[derive(Default)]
    struct Fake(RefCell<HashMap<(String, String), String>>, bool);

    impl Creds for Fake {
        fn get(&self, s: &str, u: &str) -> Option<String> {
            self.0.borrow().get(&(s.into(), u.into())).cloned()
        }
        fn set(&self, s: &str, u: &str, v: &str) -> bool {
            if self.1 && s != OLD_KEYRING_SERVICE {
                return false; // the store refuses new entries
            }
            self.0.borrow_mut().insert((s.into(), u.into()), v.into());
            true
        }
        fn delete(&self, s: &str, u: &str) {
            self.0.borrow_mut().remove(&(s.into(), u.into()));
        }
    }

    fn users(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn credentials_move_to_the_new_service() {
        let f = Fake::default();
        f.set(OLD_KEYRING_SERVICE, "acc1", "pw1");
        f.set(OLD_KEYRING_SERVICE, "acc1:smtp", "pw2");
        f.set(OLD_KEYRING_SERVICE, "secret:ai_key", "key");
        let (moved, ok) = migrate_creds(&f, "heylook", &users(&["acc1", "acc1:smtp", "secret:ai_key", "secret:none", "acc2"]));
        assert_eq!((moved, ok), (3, true));
        assert_eq!(f.get("heylook", "acc1").as_deref(), Some("pw1"));
        assert_eq!(f.get("heylook", "acc1:smtp").as_deref(), Some("pw2"));
        assert_eq!(f.get("heylook", "secret:ai_key").as_deref(), Some("key"));
        assert_eq!(f.get(OLD_KEYRING_SERVICE, "acc1"), None);
        // again: nothing to do
        assert_eq!(migrate_creds(&f, "heylook", &users(&["acc1"])), (0, true));
    }

    #[test]
    fn credentials_never_overwrite_a_new_entry() {
        let f = Fake::default();
        f.set(OLD_KEYRING_SERVICE, "acc1", "old");
        f.set("heylook", "acc1", "new");
        assert_eq!(migrate_creds(&f, "heylook", &users(&["acc1"])), (0, true));
        assert_eq!(f.get("heylook", "acc1").as_deref(), Some("new"));
    }

    #[test]
    fn credentials_stay_where_they_are_when_the_new_one_cannot_be_saved() {
        let f = Fake(RefCell::default(), true);
        f.set(OLD_KEYRING_SERVICE, "acc1", "pw");
        let (moved, ok) = migrate_creds(&f, "heylook", &users(&["acc1"]));
        assert_eq!((moved, ok), (0, false));
        assert_eq!(f.get(OLD_KEYRING_SERVICE, "acc1").as_deref(), Some("pw"));
    }
}
