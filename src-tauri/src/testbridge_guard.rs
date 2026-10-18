//! Source guards of the debug-only test bridge (see testbridge/mod.rs). They read the source files, so they hold in every build of the
//! tests, also in `cargo test --release` where the module itself is not compiled: a release build must have no trace of the bridge.
//!
//! What keeps it out of a release build: the module is declared `#[cfg(debug_assertions)]`, its only uses (lib.rs: the plugin, the start)
//! are `#[cfg(debug_assertions)]` too, it registers no command (so `generate_handler!`, `APP_COMMANDS` of build.rs and the capability
//! files never mention it), and no other file knows its environment variable. The release workflow also searches the built binaries for
//! the variable's name (.github/scripts/check-no-test-bridge.cjs).

const LIB: &str = include_str!("lib.rs");
const BUILD: &str = include_str!("../build.rs");
const DEFAULT_CAP: &str = include_str!("../capabilities/default.json");
const POPOUT_CAP: &str = include_str!("../capabilities/popout.json");
const TAURI_CONF: &str = include_str!("../tauri.conf.json");
const NO_UPDATER_CONF: &str = include_str!("../tauri.no-updater.conf.json");

/// The name of the environment variable, put together here so that this file itself does not carry the string.
fn env_name() -> String {
    ["HEYLOOK", "TEST", "BRIDGE"].join("_")
}

fn module_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("testbridge")
}

fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The part of lib.rs that is compiled outside the tests.
fn lib_code() -> String {
    crate::test_guard::non_test_code(LIB)
}

#[test]
fn the_module_is_declared_for_debug_builds_only() {
    assert!(LIB.contains("#[cfg(debug_assertions)]\nmod testbridge;\n"), "lib.rs must declare the bridge as `#[cfg(debug_assertions)] mod testbridge;`");
    assert_eq!(LIB.matches("mod testbridge;").count(), 1);
}

#[test]
fn every_use_in_lib_rs_is_debug_only() {
    // every statement of lib.rs that names `testbridge` has `#[cfg(debug_assertions)]` on the line(s) just before it
    let code = lib_code();
    let lines: Vec<&str> = code.lines().collect();
    let mut uses = 0;
    for (i, l) in lines.iter().enumerate() {
        let code = l.split("//").next().unwrap_or("");
        if !code.contains("testbridge") {
            continue;
        }
        uses += 1;
        // the previous non-comment line must be the attribute
        let prev = lines[..i].iter().rev().map(|p| p.trim()).find(|p| !p.starts_with("//")).unwrap_or("");
        assert_eq!(prev, "#[cfg(debug_assertions)]", "lib.rs line {} uses testbridge without `#[cfg(debug_assertions)]`: {l}", i + 1);
    }
    // the declaration, the plugin and the start
    assert_eq!(uses, 3, "lib.rs is expected to use the bridge in exactly three places (module, plugin, start)");
}

#[test]
fn the_bridge_adds_no_command_or_capability() {
    for (name, text) in [("build.rs", BUILD), ("capabilities/default.json", DEFAULT_CAP), ("capabilities/popout.json", POPOUT_CAP), ("tauri.conf.json", TAURI_CONF), ("tauri.no-updater.conf.json", NO_UPDATER_CONF)] {
        let low = text.to_ascii_lowercase();
        assert!(!low.contains("bridge"), "{name} mentions the bridge");
        assert!(!low.contains("testbridge") && !low.contains("test_bridge"), "{name}");
    }
    // the handler list of lib.rs
    let at = LIB.find("tauri::generate_handler![").unwrap();
    let handler = &LIB[at..at + LIB[at..].find("])").unwrap()];
    assert!(!handler.to_ascii_lowercase().contains("bridge"));
    // and the module declares none
    let mut files = vec![];
    rust_files(&module_dir(), &mut files);
    assert!(files.len() >= 5, "{files:?}");
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        // (assembled so that this test does not match itself)
        for banned in [["#[tauri::", "command]"].concat(), ["generate_", "handler!"].concat(), ["invoke_", "handler("].concat(), ["Manager", "::state"].concat()] {
            assert!(!text.contains(&banned), "{} contains {banned}: the bridge must not be callable from a page", f.display());
        }
    }
}

#[test]
fn the_environment_variable_is_named_in_the_module_only() {
    let name = env_name();
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    rust_files(&src, &mut files);
    let module = module_dir();
    let mut named_in_module = 0;
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        if f.starts_with(&module) {
            if text.contains(&name) {
                named_in_module += 1;
            }
            continue;
        }
        assert!(!text.contains(&name), "{} names the bridge variable outside the module", f.display());
    }
    assert_eq!(named_in_module, 1, "exactly one file of the module (mod.rs) holds the name");
    assert!(std::fs::read_to_string(module.join("mod.rs")).unwrap().contains(&format!("pub const ENV_VAR: &str = \"{name}\";")));
    // the page side and the other files do not carry it either (the release check searches for it in the binary)
    assert!(!BUILD.contains(&name) && !LIB.contains(&name));
}

#[test]
fn only_the_bridge_files_hold_its_scripts() {
    // `__hlb` (the page side's global) is not used by the app's own code
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![];
    rust_files(&src, &mut files);
    for f in files {
        if f.starts_with(module_dir()) || f.ends_with("testbridge_guard.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(!text.contains("__hlb"), "{}", f.display());
    }
    // the web app's own sources do not know the bridge either
    let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("src");
    fn walk(dir: &std::path::Path, bad: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, bad);
            } else if let Ok(t) = std::fs::read_to_string(&p) {
                if t.contains("__hlb") || t.contains(&["TEST", "BRIDGE"].join("_")) {
                    bad.push(p.display().to_string());
                }
            }
        }
    }
    let mut bad = vec![];
    walk(&web, &mut bad);
    assert!(bad.is_empty(), "{bad:?}");
}
