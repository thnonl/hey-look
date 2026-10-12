//! Attachment helpers that do not touch the mail server: safe file names, unique targets, the list of
//! file types that can run code, and cleanup of the temp folder used for "Open".

use std::path::{Path, PathBuf};

/// Extensions that can run programs or scripts. Opening one asks the user first (setting `warn_executables`).
pub const RISKY_EXT: [&str; 22] = [
    "exe", "msi", "msix", "bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "pif", "lnk",
    "hta", "cpl", "jar", "reg", "appx",
];
pub const RISKY_IMAGE: [&str; 2] = ["iso", "img"];

/// Windows reserved device names, which cannot be used as file names.
const RESERVED: [&str; 8] = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1", "COM2", "LPT2"];

pub fn is_risky(name: &str) -> bool {
    let ext = extension(name).to_lowercase();
    RISKY_EXT.contains(&ext.as_str()) || RISKY_IMAGE.contains(&ext.as_str())
}

fn extension(name: &str) -> &str {
    name.rsplit_once('.').map(|(stem, ext)| if stem.is_empty() { "" } else { ext }).unwrap_or("")
}

/// A name that is safe on Windows: no path separators or reserved characters, no trailing dots or spaces.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut out: String = base
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    out = out.trim().trim_end_matches(['.', ' ']).to_string();
    if out.is_empty() || out == ".." {
        return "attachment".into();
    }
    let stem = out.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        out = format!("_{out}");
    }
    out
}

/// `dir/name`, or `dir/stem (n).ext` when that already exists. `exists` is injected so the rule is testable.
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 1;
    loop {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !exists(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Message ids are used as folder names; keep only characters that are safe in a path.
pub fn safe_id(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if s.is_empty() { "message".into() } else { s }
}

/// Remove files under `root` that were last modified more than `max_age_secs` ago (then empty folders).
pub fn cleanup_older_than(root: &Path, max_age_secs: u64, now: std::time::SystemTime) -> std::io::Result<usize> {
    let mut removed = 0;
    if !root.is_dir() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            removed += cleanup_older_than(&path, max_age_secs, now)?;
            let _ = std::fs::remove_dir(&path); // only succeeds when empty
            continue;
        }
        let modified = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(now);
        let age = now.duration_since(modified).map(|d| d.as_secs()).unwrap_or(0);
        if age > max_age_secs && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risky_extensions_are_detected_case_insensitively() {
        assert!(is_risky("Setup.EXE"));
        assert!(is_risky("install.ps1"));
        assert!(is_risky("disk.iso"));
        assert!(!is_risky("report.pdf"));
        assert!(!is_risky("exe"), "a bare name is not an extension");
        assert!(!is_risky(".bashrc"));
    }

    #[test]
    fn names_are_made_safe_for_windows() {
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(clean_name("report.pdf. "), "report.pdf");
        assert_eq!(clean_name("CON.txt"), "_CON.txt");
        assert_eq!(clean_name(""), "attachment");
        assert_eq!(clean_name(".."), "attachment");
    }

    #[test]
    fn duplicate_names_get_a_counter() {
        let dir = Path::new("/d");
        let taken = |p: &Path| p.ends_with("photo.jpg") || p.ends_with("photo (1).jpg");
        assert_eq!(unique_path(dir, "photo.jpg", taken), dir.join("photo (2).jpg"));
        assert_eq!(unique_path(dir, "notes", |_| false), dir.join("notes"));
        assert_eq!(unique_path(dir, "notes", |p| p.ends_with("notes")), dir.join("notes (1)"));
    }

    #[test]
    fn message_ids_become_safe_folder_names() {
        assert_eq!(safe_id("m-12_ab"), "m-12_ab");
        assert_eq!(safe_id("<x>/../y"), "xy");
        assert_eq!(safe_id("///"), "message");
    }

    #[test]
    fn cleanup_removes_only_old_files() {
        let root = std::env::temp_dir().join(format!("heylook-test-{}", std::process::id()));
        let sub = root.join("m1");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("old.pdf"), b"x").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(48 * 3600);
        let removed = cleanup_older_than(&root, 24 * 3600, future).unwrap();
        assert_eq!(removed, 1);
        assert!(!sub.join("old.pdf").exists());
        assert!(!sub.exists(), "empty folder removed");
        let _ = std::fs::remove_dir_all(&root);
    }
}
