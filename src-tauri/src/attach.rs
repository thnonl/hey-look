//! Attachment helpers that do not touch the mail server: safe file names, unique targets, the list of
//! file types that can run code, and cleanup of the temp folder used for "Open".

use std::path::{Path, PathBuf};

/// Extensions that can run programs or scripts. Opening one asks the user first (setting `warn_executables`).
pub const RISKY_EXT: &[&str] = &[
    "exe", "msi", "msix", "bat", "cmd", "com", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "pif", "lnk",
    "hta", "cpl", "jar", "reg", "appx",
    // more programs, scripts and shortcuts
    "dll", "msp", "mst", "msc", "sct", "inf", "ins", "isp", "gadget", "application", "appref-ms", "url", "scf", "ps1xml", "psc1",
    "psd1", "ws", "vb", "vbscript", "chm", "ade", "adp", "mde", "ocx", "sys", "drv", "diagcab", "msixbundle", "appxbundle", "appinstaller",
    "settingcontent-ms", "library-ms", "search-ms", "wsc",
    // Office files that can carry macros
    "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "iqy", "slk", "xla", "xlw",
    // add-ins and remote/embedded launchers: Excel add-in (xll), Remote Desktop, OneNote (embedded files), Java Web Start, ClickOnce
    "xll", "rdp", "one", "onepkg", "jnlp", "xbap", "website",
    // more scripting / shell types
    "ps2", "ps2xml", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml", "job", "shs", "shb", "bas", "py", "pyw", "pyz", "pl", "sh", "command", "xnk",
    // disk images that mount as a drive
    "vhd", "vhdx", "dmg", "wim",
];
pub const RISKY_IMAGE: [&str; 2] = ["iso", "img"];

/// Windows reserved device names other than COM0-9 / LPT0-9 (see `is_reserved`); they cannot be used as file names.
const RESERVED: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn is_reserved(stem: &str) -> bool {
    let s = stem.trim_end().to_uppercase();
    if RESERVED.contains(&s.as_str()) {
        return true;
    }
    // COM0-9 and LPT0-9, plus the superscript digits Windows also reserves
    let mut it = s.chars();
    let head: String = it.by_ref().take(3).collect();
    matches!(head.as_str(), "COM" | "LPT") && matches!((it.next(), it.next()), (Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None))
}

fn risky_ext(name: &str) -> bool {
    let ext = extension(name).trim().to_lowercase();
    RISKY_EXT.contains(&ext.as_str()) || RISKY_IMAGE.contains(&ext.as_str())
}

/// Whether opening this file can run code. Judged on the name as given and on the name `clean_name` stores it under
/// (Windows ignores trailing dots and spaces, so `setup.exe.` is `setup.exe`).
pub fn is_risky(name: &str) -> bool {
    risky_ext(name) || risky_ext(&clean_name(name))
}

/// The text after the last dot. A leading dot counts: Windows takes `.exe` (no stem) as the extension `exe`, so a dotfile-style
/// name is judged on its last segment like any other (`.bashrc` has the harmless extension `bashrc`).
fn extension(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
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
    let stem = out.split('.').next().unwrap_or("");
    if is_reserved(stem) {
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
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue; // never follow a link (or junction) out of the temp folder
        }
        if kind.is_dir() {
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
    fn bare_dot_extension_names_are_risky() {
        // F25: a name that is only a dot and an extension is still that extension on Windows
        for n in [".exe", ".cmd", ".EXE", ".Cmd", " .exe", "..exe", "...exe", "a/.exe", "a\\.exe", ".exe.", ".exe ", ".bat.", ".tar.exe", ".hidden.ps1", ".vbs"] {
            assert!(is_risky(n), "{n:?}");
        }
        for n in [".bashrc", ".gitignore", ".", "..", ".pdf.txt", "exe", "exe."] {
            assert!(!is_risky(n), "{n:?}");
        }
        assert_eq!(clean_name(".exe"), ".exe");
        assert!(is_risky(&clean_name(".exe")));
    }

    #[test]
    fn more_program_types_are_risky() {
        for n in ["a.rdp", "a.xll", "a.xla", "a.one", "a.vhdx", "a.jnlp", "a.vhd", "a.xbap", "a.py", "a.RDP", "x.onepkg"] {
            assert!(is_risky(n), "{n}");
        }
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
    fn trailing_dots_spaces_and_streams_cannot_hide_a_program() {
        // F6: the warning is decided on the name that is actually stored and opened
        for n in ["invoice.exe.", "invoice.exe ", "invoice.EXE. ", "invoice.exe...", "invoice.exe. . ", "invoice.exe\u{a0}", "dir\\invoice.exe.", "a/b/invoice.cmd ."] {
            assert!(is_risky(n), "{n:?}");
            assert!(is_risky(&clean_name(n)), "cleaned {n:?}");
        }
        // an alternate data stream is flattened by clean_name; the stored file is not a program
        assert_eq!(clean_name("note.txt:evil.exe"), "note.txt_evil.exe");
        assert!(is_risky("note.txt:evil.exe"), "conservative: still asks");
        assert!(!is_risky("report.pdf."));
        assert!(!is_risky("exe."));
    }

    #[test]
    fn all_reserved_device_names_are_prefixed() {
        for n in ["COM1", "com2.txt", "COM3.txt", "Com9", "lpt9", "LPT4.log", "COM0", "LPT0.x", "CON", "nul.tar.gz", "AUX.", "PRN ", "COM\u{b9}", "CONIN$", "con .txt"] {
            assert!(clean_name(n).starts_with('_'), "{n:?} -> {}", clean_name(n));
        }
        for n in ["COM", "COM10", "COMX", "LPT", "console.txt", "community.doc", "auxiliary", "communication.pdf"] {
            assert_eq!(clean_name(n), n, "{n:?}");
        }
    }

    #[test]
    fn macro_and_script_types_are_risky() {
        for n in ["a.docm", "a.XLSM", "a.pptm", "a.dll", "a.url", "a.msc", "a.sct", "a.inf", "a.application", "a.chm"] {
            assert!(is_risky(n), "{n}");
        }
        for n in ["a.docx", "a.xlsx", "a.pptx", "a.pdf", "a.txt", "a.png", "a.zip"] {
            assert!(!is_risky(n), "{n}");
        }
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
