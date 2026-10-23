//! Folders of a mailbox as a tree, and creating one (1.0.7 W13.10, REQ-13.10.1 to 13.10.8).
//!
//! The server's hierarchy delimiter, the personal namespace prefix (`INBOX.` / `INBOX/`) and the folders that cannot have children are saved with the folder map (`fmeta:<account>`,
//! written wherever the saved list `fmap:<account>` is rewritten from a LIST). With them `folder_infos` tells the side menu, for every folder of the person, its label (the last part of
//! the name, decoded from modified UTF-7), its depth and its parent, so "Release v1.0" is one folder and `INBOX.Clients.Acme` is "Acme" under "Clients" (the page used to guess from `/` and `.`).
//! Creating a folder (`create_on_session`) checks the name, builds the full name (prefix + parent + delimiter + the encoded name), CREATEs and SUBSCRIBEs, reads the exact name back with a
//! LIST and saves the new list.
use crate::{db, i18n, mail, Account, Db, R};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Read, Write};

/// A name of at most this many characters (REQ-13.10.5).
pub const MAX_NAME_CHARS: usize = 100;

/// What the folder tree needs to know about a mailbox, saved as `fmeta:<account>`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct FolderMeta {
    /// the hierarchy delimiter of the server (`/`, `.`); None = not known (data from before 1.0.7 until the next sync)
    pub delimiter: Option<String>,
    /// `INBOX.` / `INBOX/` when the server keeps every folder of the person under INBOX, else empty
    pub prefix: String,
    /// folders that cannot have children (LIST attribute `\Noinferiors`), by their server name
    #[serde(default)]
    pub noinferiors: Vec<String>,
}

impl FolderMeta {
    pub fn from_listing(l: &mail::Listing) -> Self {
        FolderMeta { delimiter: l.delimiter.clone(), prefix: l.prefix.clone(), noinferiors: l.noinferiors.clone() }
    }

    /// Mailboxes whose meta was never saved (the folder list is older than 1.0.7): `/` when some folder name has one, else nothing is split. The next sync saves the real values.
    pub fn guessed<'a>(names: impl IntoIterator<Item = &'a String>) -> Self {
        let slash = names.into_iter().any(|n| n.contains('/'));
        FolderMeta { delimiter: slash.then(|| "/".to_string()), prefix: String::new(), noinferiors: vec![] }
    }

    fn delimiter(&self) -> Option<&str> {
        self.delimiter.as_deref().filter(|d| !d.is_empty())
    }
}

/// The saved meta of a mailbox, if there is one.
pub fn saved_meta(c: &rusqlite::Connection, account_id: &str) -> Option<FolderMeta> {
    db::get_setting(c, &format!("fmeta:{account_id}")).and_then(|s| serde_json::from_str(&s).ok())
}

/// Where a folder of the person sits in the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    /// key (`f:<name>`) of the parent folder when the server lists it, else None
    pub parent: Option<String>,
    /// 0 = top level (after the namespace prefix)
    pub depth: u32,
    /// the last part of the name, decoded from modified UTF-7
    pub label: String,
    /// "New subfolder…" may be offered: a top-level folder of the person that can have children (REQ-13.10.3)
    pub can_nest: bool,
}

/// The parts of a server name after the namespace prefix, split by the delimiter.
fn parts<'a>(name: &'a str, meta: &FolderMeta) -> Vec<&'a str> {
    let rest = if !meta.prefix.is_empty() && name.len() > meta.prefix.len() && name.is_char_boundary(meta.prefix.len()) && name[..meta.prefix.len()].eq_ignore_ascii_case(&meta.prefix) {
        &name[meta.prefix.len()..]
    } else {
        name
    };
    match meta.delimiter() {
        Some(d) => rest.split(d).collect(),
        None => vec![rest],
    }
}

/// The place of the folder `key` (named `name` on the server). `custom` = the server names of all the folders of the person (keys `f:...`), to find the parent among them.
pub fn place(key: &str, name: &str, meta: &FolderMeta, custom: &HashSet<&str>) -> Place {
    let ps = parts(name, meta);
    let last = ps.last().copied().unwrap_or(name);
    let label = mail::decode_imap_utf7(if last.is_empty() { name } else { last });
    if !key.starts_with("f:") {
        return Place { parent: None, depth: 0, label, can_nest: false };
    }
    let depth = ps.len().saturating_sub(1) as u32;
    let parent = (depth > 0)
        .then(|| {
            let d = meta.delimiter()?;
            let cut = name.len() - last.len() - d.len();
            let pname = &name[..cut];
            custom.contains(pname).then(|| format!("f:{pname}"))
        })
        .flatten();
    let first = ps.first().copied().unwrap_or("").to_lowercase();
    let gmail = first.starts_with("[gmail]") || first.starts_with("[google mail]");
    Place { parent, depth, label, can_nest: depth == 0 && !gmail && !meta.noinferiors.iter().any(|n| n == name) }
}

/// Why a name for a new folder is refused (REQ-13.10.5). The page checks the same rules while the person types; this is the check of the backend.
#[derive(Debug, PartialEq, Eq)]
pub enum NameError {
    Empty,
    TooLong,
    /// the characters found, each once
    Chars(String),
    Reserved,
    Exists,
}

/// The name as it will be created (leading and trailing spaces removed) or the reason it cannot be. `siblings` = the labels of the folders at the same level, standard folders included.
pub fn check_name(raw: &str, delimiter: Option<&str>, siblings: &[String]) -> Result<String, NameError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(NameError::Empty);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(NameError::TooLong);
    }
    let mut bad = String::new();
    for c in name.chars() {
        let hit = c.is_control() || matches!(c, '*' | '%' | '"' | '\\') || delimiter.is_some_and(|d| !d.is_empty() && d.chars().count() == 1 && d.starts_with(c));
        if hit && !bad.contains(c) {
            if !bad.is_empty() {
                bad.push(' ');
            }
            bad.push(c);
        }
    }
    if !bad.is_empty() {
        return Err(NameError::Chars(bad));
    }
    if name.eq_ignore_ascii_case("inbox") || name == "." || name == ".." {
        return Err(NameError::Reserved);
    }
    let lower = name.to_lowercase();
    if siblings.iter().any(|s| s.to_lowercase() == lower) {
        return Err(NameError::Exists);
    }
    Ok(name.to_string())
}

/// A refusal for the New folder dialog: the code, its values and the English text (the dialog says it with its own words, `mail.folder.err*`, so no `backend.*` entry exists for these codes).
fn refusal(code: &str, params: &[(&str, &str)], english: &str) -> String {
    i18n::coded(code, params, english)
}

fn name_error(e: NameError) -> String {
    match e {
        NameError::Empty => refusal("FOLDER_NAME", &[("reason", "empty")], "Enter a folder name."),
        NameError::TooLong => refusal("FOLDER_NAME", &[("reason", "long")], "Use 100 characters or fewer."),
        NameError::Chars(c) => refusal("FOLDER_NAME", &[("reason", "chars"), ("chars", &c)], &format!("A folder name can’t contain {c}.")),
        NameError::Reserved => refusal("FOLDER_NAME", &[("reason", "reserved")], "This name is reserved. Choose another one."),
        NameError::Exists => refusal("FOLDER_EXISTS", &[], "A folder with this name already exists here."),
    }
}

/// What the server's refusal of CREATE means (REQ-13.10.6): "already exists", "no permission", or anything else (the server's own words).
pub fn create_failure(why: &str) -> String {
    let l = why.to_lowercase();
    if l.contains("alreadyexists") || l.contains("already exist") || l.contains("exists") {
        refusal("FOLDER_EXISTS", &[], "A folder with this name already exists here.")
    } else if l.contains("noperm") || l.contains("cannot") || l.contains("permission") || l.contains("not allowed") {
        refusal("FOLDER_NOPERM", &[], "The server doesn’t let you create a folder here.")
    } else {
        why.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
    }
}

/// The key of the new folder in the saved list: the entry whose server name is `full`.
fn key_of(map: &std::collections::HashMap<String, String>, full: &str) -> Option<String> {
    let mut keys: Vec<&String> = map.iter().filter(|(_, v)| v.as_str() == full).map(|(k, _)| k).collect();
    keys.sort_by_key(|k| !k.starts_with("f:"));
    keys.first().map(|k| (*k).clone())
}

/// CREATE (and SUBSCRIBE) a folder named `name` at the top level of the mailbox (`parent_key` None) or under its folder `parent_key`; the saved list is refreshed. Returns the key of the new folder.
pub fn create_on_session<T: Read + Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, parent_key: Option<&str>, name: &str) -> R<String> {
    let listing = mail::list_folders(s)?;
    crate::save_listing(db, &acc.id, &listing)?;
    let meta = FolderMeta::from_listing(&listing);
    let delimiter = meta.delimiter.clone().unwrap_or_else(|| "/".to_string());
    let custom: HashSet<&str> = listing.map.iter().filter(|(k, _)| k.starts_with("f:")).map(|(_, v)| v.as_str()).collect();
    // the folders at the level of the new one, by label: for the top level also the standard folders (by their server name and the English name of their role)
    let (parent_name, siblings): (Option<String>, Vec<String>) = match parent_key {
        Some(k) => {
            let pname = listing.map.get(k).filter(|_| k.starts_with("f:")).cloned().ok_or_else(|| refusal("FOLDER_PARENT", &[], "The folder is not there any more."))?;
            if !place(k, &pname, &meta, &custom).can_nest {
                return Err(refusal("FOLDER_PARENT", &[], "A subfolder can’t be made here."));
            }
            let kids = listing
                .map
                .iter()
                .filter(|(k2, v)| k2.starts_with("f:") && place(k2, v, &meta, &custom).parent.as_deref() == Some(k))
                .map(|(k2, v)| place(k2, v, &meta, &custom).label)
                .collect();
            (Some(pname), kids)
        }
        None => {
            let mut v: Vec<String> = listing.map.iter().filter(|(k, v)| place(k, v, &meta, &custom).depth == 0).map(|(k, v)| place(k, v, &meta, &custom).label).collect();
            v.extend(["Inbox", "Drafts", "Sent", "Archive", "Junk", "Trash"].map(String::from).into_iter().filter(|r| listing.map.contains_key(&r.to_lowercase())));
            (None, v)
        }
    };
    let clean = check_name(name, Some(&delimiter), &siblings).map_err(name_error)?;
    let encoded = mail::encode_imap_utf7(&clean);
    let full = match &parent_name {
        Some(p) => format!("{p}{delimiter}{encoded}"),
        None => format!("{}{encoded}", meta.prefix),
    };
    s.create(&full).map_err(|e| create_failure(&e.to_string()))?;
    let _ = s.subscribe(&full);
    // the exact name as the server lists it; when the LIST does not show it yet the name that was sent stands (the sync that follows shows it)
    match mail::list_folders(s) {
        Ok(after) => {
            let mut map = after.map.clone();
            if key_of(&map, &full).is_none() {
                map.insert(format!("f:{full}"), full.clone());
            }
            crate::save_listing(db, &acc.id, &mail::Listing { map: map.clone(), ..after })?;
            key_of(&map, &full).ok_or_else(|| "the folder is not in the list".to_string())
        }
        Err(_) => {
            let mut map = listing.map.clone();
            map.insert(format!("f:{full}"), full.clone());
            crate::save_fmap(db, &acc.id, &map)?;
            Ok(format!("f:{full}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakeimap::Fake;
    use crate::{lock, quit_tests, test_guard};

    fn meta(delim: &str, prefix: &str) -> FolderMeta {
        FolderMeta { delimiter: Some(delim.into()), prefix: prefix.into(), noinferiors: vec![] }
    }

    fn account() -> Account {
        Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        }
    }

    fn setup(tag: &str) -> (Db, Account) {
        let db = quit_tests::test_db(tag);
        let acc = account();
        db::insert_account(&lock(&db), &acc).unwrap();
        (db, acc)
    }

    #[test]
    fn folder_names_round_trip_through_modified_utf7() {
        for (plain, wire) in [
            ("Projects", "Projects"),
            ("Report & Plans", "Report &- Plans"),
            ("Báo cáo 報告", "B&AOE-o c&AOE-o &WDFUSg-"),
            ("Entwürfe", "Entw&APw-rfe"),
            ("日本語", "&ZeVnLIqe-"),
            ("😀 party", "&2D3eAA- party"),
        ] {
            assert_eq!(mail::encode_imap_utf7(plain), wire, "{plain}");
            assert_eq!(mail::decode_imap_utf7(wire), plain, "{wire}");
        }
        // a run of / in the base64 is written with a comma
        let tricky = "\u{fbff}\u{fbff}";
        let wire = mail::encode_imap_utf7(tricky);
        assert!(!wire.contains('/') && mail::decode_imap_utf7(&wire) == tricky, "{wire}");
        // what a server sends and the decoder reads is what the encoder writes
        for s in ["", "a", "&", "a&b&c", "ünï", "x\u{0}y", "tab\there"] {
            assert_eq!(mail::decode_imap_utf7(&mail::encode_imap_utf7(s)), s, "{s:?}");
        }
    }

    #[test]
    fn the_name_rules_are_the_ones_of_the_dialog() {
        let sib = vec!["Projects".to_string(), "Archive".to_string(), "Sent Items".to_string()];
        assert_eq!(check_name("  Clients  ", Some("/"), &sib), Ok("Clients".into()), "leading and trailing spaces go silently");
        assert_eq!(check_name("   ", Some("/"), &sib), Err(NameError::Empty));
        assert_eq!(check_name(&"x".repeat(101), Some("/"), &sib), Err(NameError::TooLong));
        assert!(check_name(&"x".repeat(100), Some("/"), &sib).is_ok());
        assert_eq!(check_name("a/b", Some("/"), &sib), Err(NameError::Chars("/".into())));
        assert_eq!(check_name("a.b", Some("."), &sib), Err(NameError::Chars(".".into())), "the delimiter of the server");
        assert!(check_name("a.b", Some("/"), &sib).is_ok(), "a dot is fine on a slash server: Release v1.0");
        assert_eq!(check_name("a*b%c\"d\\e*", Some("/"), &sib), Err(NameError::Chars("* % \" \\".into())), "each once, separated by spaces");
        assert_eq!(check_name("a\u{7}b", Some("/"), &sib), Err(NameError::Chars("\u{7}".into())));
        for r in ["INBOX", "inbox", "Inbox", ".", ".."] {
            assert_eq!(check_name(r, Some("/"), &sib), Err(NameError::Reserved), "{r}");
        }
        assert_eq!(check_name("projects", Some("/"), &sib), Err(NameError::Exists), "ignoring case");
        assert_eq!(check_name("sent items", Some("/"), &sib), Err(NameError::Exists), "a standard folder by its name");
        assert_eq!(check_name("Báo cáo 報告", Some("/"), &sib), Ok("Báo cáo 報告".into()), "any Unicode");
    }

    #[test]
    fn the_folder_list_knows_parents_depths_and_labels() {
        let names: Vec<(&str, &str)> = vec![
            ("f:Projects", "Projects"),
            ("f:Projects/2026", "Projects/2026"),
            ("f:Release v1.0", "Release v1.0"),
            ("f:[Gmail]/Important", "[Gmail]/Important"),
            ("f:Orphan/Child", "Orphan/Child"),
            ("sent", "Sent"),
        ];
        let custom: HashSet<&str> = names.iter().filter(|(k, _)| k.starts_with("f:")).map(|(_, v)| *v).collect();
        let m = meta("/", "");
        let p = |k: &str, n: &str| place(k, n, &m, &custom);
        assert_eq!(p("f:Projects", "Projects"), Place { parent: None, depth: 0, label: "Projects".into(), can_nest: true });
        assert_eq!(p("f:Projects/2026", "Projects/2026"), Place { parent: Some("f:Projects".into()), depth: 1, label: "2026".into(), can_nest: false });
        assert_eq!(p("f:Release v1.0", "Release v1.0"), Place { parent: None, depth: 0, label: "Release v1.0".into(), can_nest: true }, "one folder named Release v1.0, not 'Release v1' under '0'");
        let g = p("f:[Gmail]/Important", "[Gmail]/Important");
        assert_eq!((g.depth, g.label.as_str(), g.parent, g.can_nest), (1, "Important", None, false), "nothing is made under [Gmail]");
        let o = p("f:Orphan/Child", "Orphan/Child");
        assert_eq!((o.depth, o.parent), (1, None), "a parent the server does not list: shown by its depth, no parent");
        assert_eq!(p("sent", "Sent").depth, 0);
        // a "." server with the INBOX namespace
        let dot_names = ["INBOX.Clients", "INBOX.Clients.Acme", "INBOX.Sent"];
        let custom2: HashSet<&str> = dot_names.iter().copied().collect();
        let m2 = meta(".", "INBOX.");
        let c = place("f:INBOX.Clients", "INBOX.Clients", &m2, &custom2);
        assert_eq!((c.depth, c.label.as_str(), c.parent.clone(), c.can_nest), (0, "Clients", None, true));
        let a = place("f:INBOX.Clients.Acme", "INBOX.Clients.Acme", &m2, &custom2);
        assert_eq!((a.depth, a.label.as_str(), a.parent, a.can_nest), (1, "Acme", Some("f:INBOX.Clients".into()), false));
        // \Noinferiors and a label in modified UTF-7
        let mut m3 = meta("/", "");
        m3.noinferiors = vec!["Flat".into()];
        let custom3: HashSet<&str> = ["Flat", "B&AOE-o c&AOE-o"].into_iter().collect();
        assert!(!place("f:Flat", "Flat", &m3, &custom3).can_nest, "a folder that cannot have children");
        assert_eq!(place("f:B&AOE-o c&AOE-o", "B&AOE-o c&AOE-o", &m3, &custom3).label, "Báo cáo");
        // no delimiter known: nothing is split
        let none = FolderMeta::default();
        assert_eq!(place("f:A/B", "A/B", &none, &HashSet::new()).depth, 0);
        assert_eq!(FolderMeta::guessed([&"A/B".to_string()]).delimiter.as_deref(), Some("/"));
        assert_eq!(FolderMeta::guessed([&"Release v1.0".to_string()]).delimiter, None);
    }

    #[test]
    fn the_namespace_prefix_is_found_from_the_names() {
        let n = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(mail::namespace_prefix(&n(&["INBOX", "INBOX.Sent", "INBOX.Clients"]), Some(".")), "INBOX.");
        assert_eq!(mail::namespace_prefix(&n(&["INBOX", "inbox/Sent"]), Some("/")), "INBOX/", "any case, always written INBOX");
        assert_eq!(mail::namespace_prefix(&n(&["INBOX", "Sent", "Clients"]), Some("/")), "");
        assert_eq!(mail::namespace_prefix(&n(&["INBOX.Sent"]), None), "");
    }

    #[test]
    fn a_folder_and_a_subfolder_are_created_and_subscribed() {
        test_guard::within(60, || {
            let (db, acc) = setup("w1310-create");
            let fake = Fake::start(&[("INBOX", &[1]), ("Sent", &[])]);
            let mut s = fake.connect();
            let key = create_on_session(&db, &acc, &mut s, None, "  Projects ").unwrap();
            assert_eq!(key, "f:Projects");
            assert!(fake.has_folder("Projects"));
            assert!(fake.commands().iter().any(|c| c.starts_with("CREATE") && c.contains("\"Projects\"")), "{:?}", fake.commands());
            assert!(fake.subscribed().contains(&"Projects".to_string()), "subscribed");
            assert_eq!(crate::fmap(&db, "a1").get("f:Projects").map(String::as_str), Some("Projects"), "the saved list has it at once");
            let meta = saved_meta(&lock(&db), "a1").unwrap();
            assert_eq!((meta.delimiter.as_deref(), meta.prefix.as_str()), (Some("/"), ""));
            // a subfolder under it
            let sub = create_on_session(&db, &acc, &mut s, Some("f:Projects"), "2026").unwrap();
            assert_eq!(sub, "f:Projects/2026");
            assert!(fake.has_folder("Projects/2026"));
            assert!(fake.subscribed().contains(&"Projects/2026".to_string()));
            // the tree knows it
            let info = crate::folder_infos(&lock(&db)).unwrap();
            let child = info.iter().find(|f| f.key == "f:Projects/2026").unwrap();
            assert_eq!((child.depth, child.label.as_str(), child.parent.as_deref(), child.can_nest), (1, "2026", Some("f:Projects"), false));
            let top = info.iter().find(|f| f.key == "f:Projects").unwrap();
            assert_eq!((top.depth, top.label.as_str(), top.parent.as_deref(), top.can_nest), (0, "Projects", None, true));
            // no subfolder of a subfolder, none under a standard folder, none under a folder that is not there
            for k in ["f:Projects/2026", "inbox", "f:Nowhere"] {
                let e = create_on_session(&db, &acc, &mut s, Some(k), "x").unwrap_err();
                assert!(e.starts_with("FOLDER_PARENT"), "{k}: {e}");
            }
            // a name with a Unicode letter goes to the server in modified UTF-7 and comes back as it was
            let uni = create_on_session(&db, &acc, &mut s, None, "Báo cáo 報告").unwrap();
            assert!(fake.has_folder("B&AOE-o c&AOE-o &WDFUSg-"), "{:?}", fake.commands());
            let info = crate::folder_infos(&lock(&db)).unwrap();
            assert_eq!(info.iter().find(|f| f.key == uni).unwrap().label, "Báo cáo 報告");
            let _ = s.logout();
        });
    }

    #[test]
    fn a_dot_server_with_the_inbox_namespace_gets_inbox_dot_names() {
        test_guard::within(60, || {
            let (db, acc) = setup("w1310-dot");
            let fake = Fake::start(&[("INBOX", &[1]), ("INBOX.Sent", &[])]);
            fake.state.lock().unwrap().delimiter = ".".into();
            let mut s = fake.connect();
            let key = create_on_session(&db, &acc, &mut s, None, "Clients").unwrap();
            assert!(fake.has_folder("INBOX.Clients"), "CREATE INBOX.Clients: {:?}", fake.commands());
            assert_eq!(key, "f:INBOX.Clients");
            let sub = create_on_session(&db, &acc, &mut s, Some(&key), "Acme").unwrap();
            assert!(fake.has_folder("INBOX.Clients.Acme"), "{:?}", fake.commands());
            let info = crate::folder_infos(&lock(&db)).unwrap();
            let c = info.iter().find(|f| f.key == key).unwrap();
            assert_eq!((c.depth, c.label.as_str(), c.can_nest), (0, "Clients", true), "shown at the top level as Clients");
            let a = info.iter().find(|f| f.key == sub).unwrap();
            assert_eq!((a.depth, a.label.as_str(), a.parent.as_deref()), (1, "Acme", Some("f:INBOX.Clients")));
            // the delimiter of the server may not be in a name
            let e = create_on_session(&db, &acc, &mut s, None, "a.b").unwrap_err();
            assert!(e.starts_with("FOLDER_NAME|reason=chars"), "{e}");
            let _ = s.logout();
        });
    }

    #[test]
    fn an_existing_name_and_a_refusal_are_reported() {
        test_guard::within(60, || {
            let (db, acc) = setup("w1310-refuse");
            let fake = Fake::start(&[("INBOX", &[1]), ("Sent", &[]), ("Projects", &[])]);
            let mut s = fake.connect();
            // the same name (ignoring case) is refused before anything is sent, a standard folder too
            for n in ["projects", "Projects", "sent"] {
                let before = fake.commands().iter().filter(|c| c.starts_with("CREATE")).count();
                let e = create_on_session(&db, &acc, &mut s, None, n).unwrap_err();
                assert!(e.starts_with("FOLDER_EXISTS"), "{n}: {e}");
                assert_eq!(fake.commands().iter().filter(|c| c.starts_with("CREATE")).count(), before, "no CREATE for {n}");
            }
            for (n, why) in [("", "empty"), ("inbox", "reserved"), ("a/b", "chars")] {
                let e = create_on_session(&db, &acc, &mut s, None, n).unwrap_err();
                assert!(e.starts_with(&format!("FOLDER_NAME|reason={why}")), "{n}: {e}");
            }
            // another client made it a moment ago: the server answers ALREADYEXISTS
            fake.state.lock().unwrap().hide_from_list.push("Hidden".into());
            fake.put_folder("Hidden", &[]);
            let e = create_on_session(&db, &acc, &mut s, None, "Hidden").unwrap_err();
            assert!(e.starts_with("FOLDER_EXISTS"), "{e}");
            // a server that does not let this user make folders
            fake.state.lock().unwrap().refuse_create = true;
            let e = create_on_session(&db, &acc, &mut s, None, "Brand new").unwrap_err();
            assert!(e.starts_with("FOLDER_NOPERM"), "{e}");
            assert!(!fake.has_folder("Brand new"));
            // anything else is the server's own words
            assert_eq!(create_failure("No Response: [OVERQUOTA] mailbox is full"), "No Response: [OVERQUOTA] mailbox is full");
            let _ = s.logout();
        });
    }

    #[test]
    fn a_folder_that_cannot_have_children_gets_no_subfolder_and_a_server_that_lists_it_late_is_still_created() {
        test_guard::within(60, || {
            let (db, acc) = setup("w1310-noinf");
            let fake = Fake::start(&[("INBOX", &[1]), ("Flat", &[]), ("Deep", &[])]);
            fake.state.lock().unwrap().noinferiors.push("Flat".into());
            let mut s = fake.connect();
            let e = create_on_session(&db, &acc, &mut s, Some("f:Flat"), "x").unwrap_err();
            assert!(e.starts_with("FOLDER_PARENT"), "{e}");
            assert!(create_on_session(&db, &acc, &mut s, Some("f:Deep"), "x").is_ok());
            // CREATE worked but the LIST that follows does not show it: the name that was sent stands
            fake.state.lock().unwrap().hide_from_list.push("Late".into());
            let key = create_on_session(&db, &acc, &mut s, None, "Late").unwrap();
            assert_eq!(key, "f:Late");
            assert_eq!(crate::fmap(&db, "a1").get("f:Late").map(String::as_str), Some("Late"));
            let _ = s.logout();
        });
    }
}
