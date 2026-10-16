//! Attachment helpers that do not touch the mail server: safe file names, unique targets, the list of
//! file types that can run code, and cleanup of the temp folder used for "Open".

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Extensions that can run programs or scripts, or carry macros / mount as a drive. Opening one asks the user first
/// (setting `warn_executables`). The list lives in `src/riskyExt.json` and is shared with the frontend (file-type icon, no
/// text preview), so the two cannot drift apart.
static RISKY_EXT: LazyLock<HashSet<String>> =
    LazyLock::new(|| serde_json::from_str::<Vec<String>>(include_str!("../../src/riskyExt.json")).expect("src/riskyExt.json is a JSON array of strings").into_iter().collect());

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
    RISKY_EXT.contains(ext.as_str())
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

/// A file name is cut to this many characters and bytes (a name is at most 255 bytes on most file systems, 255 UTF-16 units on NTFS).
pub const NAME_MAX_CHARS: usize = 120;
pub const NAME_MAX_BYTES: usize = 240;

/// Control characters and the invisible ones that disguise a name: zero-width characters, line / paragraph separators, bidi overrides
/// (`invoice<RLO>gpj.exe` is shown as `invoiceexe.jpg`).
fn is_invisible(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

/// `name` cut to `NAME_MAX_CHARS` characters and `NAME_MAX_BYTES` bytes; a short extension (up to 16 characters) is kept.
fn cap_name(name: String) -> String {
    if name.chars().count() <= NAME_MAX_CHARS && name.len() <= NAME_MAX_BYTES {
        return name;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && name[i..].chars().count() <= 17 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    let mut out = String::new();
    let (mut chars, mut bytes) = (ext.chars().count(), ext.len());
    for c in stem.chars() {
        if chars + 1 > NAME_MAX_CHARS || bytes + c.len_utf8() > NAME_MAX_BYTES {
            break;
        }
        out.push(c);
        chars += 1;
        bytes += c.len_utf8();
    }
    let out = out.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if out.is_empty() { "attachment".to_string() } else { format!("{out}{ext}") }
}

/// A name that is safe on Windows: no path separators or reserved characters, no trailing dots or spaces, no hidden characters, not longer
/// than `NAME_MAX_*`. This is the name a received attachment is saved and opened under.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut out: String = base
        .chars()
        .filter(|c| c.is_control() || !is_invisible(*c))
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
    cap_name(out)
}

/// The name an attachment (or an inline picture) gets in a message that is sent: the base name only (no folder, no `..`), no control or
/// hidden characters (a CR / LF cannot reach a header, a right-to-left override cannot swap the extension), no trailing dots or spaces
/// (Windows ignores them: `evil.exe.` is `evil.exe`), a reserved device name (`CON`, `NUL`, `COM1` ...) gets a `_`, at most `NAME_MAX_*`
/// long with its extension kept. Everything else is written as it is (`"`, `;`, `%`, non-ASCII ... are encoded by the MIME layer): the
/// recipient decodes the name the sender chose. Mirrored by `outgoingName` in src/attachName.ts (shared vectors: scripts/fixtures/attach-names.json).
pub fn outgoing_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let s: String = base.chars().filter(|c| !is_invisible(*c)).collect();
    let s = s.trim().trim_end_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if s.is_empty() {
        return "attachment".into();
    }
    let s = if is_reserved(s.split('.').next().unwrap_or("")) { format!("_{s}") } else { s };
    cap_name(s)
}

/// `outgoing_name` of every attachment of a message. Two files that only come to have the same name because of the cleaning
/// (`a/b.txt`, `c/b.txt`) are told apart (`b.txt`, `b (2).txt`); the same name given twice by the sender stays twice (two `report.pdf`).
pub fn outgoing_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(names.len());
    let mut changed: Vec<bool> = Vec::with_capacity(names.len());
    for n in names {
        let mut c = outgoing_name(n);
        let was_changed = c != *n;
        if out.iter().zip(&changed).any(|(o, ch)| *o == c && (*ch || was_changed)) {
            let (stem, ext) = match c.rfind('.') {
                Some(i) if i > 0 => (c[..i].to_string(), c[i..].to_string()),
                _ => (c.clone(), String::new()),
            };
            let mut k = 2;
            c = loop {
                let candidate = format!("{stem} ({k}){ext}");
                if !out.contains(&candidate) {
                    break candidate;
                }
                k += 1;
            };
        }
        out.push(c);
        changed.push(was_changed);
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
        assert!(is_risky("KB5001.msu") && is_risky("page.mhtml") && is_risky("style.xslt"));
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
    fn shared_risky_list_is_clean() {
        // the list is shared with the frontend: lower-case, no dots, no blanks, no duplicates
        let raw: Vec<String> = serde_json::from_str(include_str!("../../src/riskyExt.json")).unwrap();
        assert_eq!(raw.len(), RISKY_EXT.len(), "duplicate entries");
        for e in &raw {
            assert!(!e.is_empty() && *e == e.trim().to_lowercase() && !e.contains('.'), "{e:?}");
        }
        for e in ["exe", "iso", "img", "rdp", "xll", "one", "jnlp", "vhdx", "py", "sh", "docm"] {
            assert!(RISKY_EXT.contains(e), "{e}");
        }
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

    /// `{U+XXXX}` is that character, `{rep:n:text}` is `text` n times (the vectors are shared with src/attachName.ts).
    fn expand(s: &str) -> String {
        let mut out = String::new();
        let mut rest = s;
        while let Some(i) = rest.find('{') {
            out.push_str(&rest[..i]);
            let tail = &rest[i..];
            let end = tail.find('}').unwrap();
            let tok = &tail[1..end];
            if let Some(h) = tok.strip_prefix("U+") {
                out.push(char::from_u32(u32::from_str_radix(h, 16).unwrap()).unwrap());
                rest = &tail[end + 1..];
            } else if let Some(r) = tok.strip_prefix("rep:") {
                let (n, text) = r.split_once(':').unwrap();
                out.push_str(&text.repeat(n.parse().unwrap()));
                rest = &tail[end + 1..];
            } else {
                out.push('{');
                rest = &tail[1..];
            }
        }
        out.push_str(rest);
        out
    }

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("../../scripts/fixtures/attach-names.json")).unwrap()
    }

    #[test]
    fn outgoing_names_follow_the_shared_vectors() {
        let v = vectors();
        let rows = v["outgoing"].as_array().unwrap();
        assert!(rows.len() > 30);
        for row in rows {
            let (input, want) = (expand(row[0].as_str().unwrap()), expand(row[1].as_str().unwrap()));
            assert_eq!(outgoing_name(&input), want, "{:?}", row[0]);
            assert_eq!(outgoing_name(&want), want, "idempotent: {:?}", row[1]);
            let got = outgoing_name(&input);
            assert!(got.chars().count() <= NAME_MAX_CHARS && got.len() <= NAME_MAX_BYTES, "{got}");
        }
        for row in v["duplicates"].as_array().unwrap() {
            let input: Vec<String> = row[0].as_array().unwrap().iter().map(|x| expand(x.as_str().unwrap())).collect();
            let want: Vec<String> = row[1].as_array().unwrap().iter().map(|x| expand(x.as_str().unwrap())).collect();
            assert_eq!(outgoing_names(&input), want, "{:?}", row[0]);
        }
    }

    /// BUG-18, receive side: whatever the name inside a received mail says, the file lands inside the target folder.
    #[test]
    fn a_received_name_cannot_leave_the_download_folder() {
        let dir = Path::new("/downloads");
        for raw in [
            "..\\..\\Windows\\evil.bat", "../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "\\\\host\\share\\x.txt", "....//....//x", "..", ".", "a/../../b", "a\\..\\..\\b",
            "CON", "nul.txt", "x{U+0000}/../y", "{U+202E}fdp.exe", "dir/", "~/.ssh/id_rsa", "%2e%2e%2fx", "{rep:400:a}/{rep:400:b}",
        ] {
            let name = clean_name(&expand(raw));
            assert!(!name.contains(['/', '\\', ':']) && name != ".." && name != "." && !name.is_empty(), "{raw:?} -> {name:?}");
            assert!(name.chars().count() <= NAME_MAX_CHARS && name.len() <= NAME_MAX_BYTES, "{name}");
            let target = unique_path(dir, &name, |_| false);
            assert_eq!(target.parent(), Some(dir), "{raw:?} -> {target:?}");
            assert_eq!(clean_name(&name), name, "idempotent: {raw:?}");
        }
        assert_eq!(clean_name("..\\..\\Windows\\evil.bat"), "evil.bat");
        assert_eq!(clean_name("/etc/passwd"), "passwd");
        assert_eq!(clean_name(&expand("{rep:300:a}.pdf")), format!("{}.pdf", "a".repeat(116)));
        assert_eq!(clean_name(&expand("invoice{U+202E}gpj.exe")), "invoicegpj.exe");
        assert!(is_risky(&clean_name(&expand("invoice{U+202E}gpj.exe"))), "the hidden override does not hide the program");
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
