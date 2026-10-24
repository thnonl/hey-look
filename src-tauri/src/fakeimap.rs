//! A small in-memory IMAP server for tests: plain TCP on 127.0.0.1, one thread per connection, folders holding message UIDs.
//! It speaks just enough IMAP for the folder and move code (LOGIN, LIST, SELECT, CREATE, SUBSCRIBE, UID MOVE / COPY / STORE /
//! SEARCH, APPEND, EXPUNGE, LOGOUT) and logs every command, so a test can also check what was NOT sent.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

pub struct State {
    /// folder name -> UIDs of its messages (ascending). `INBOX` is a folder like the others.
    pub folders: BTreeMap<String, Vec<u32>>,
    /// folder name -> the SPECIAL-USE attribute LIST shows for it (`\Archive`, `\Trash` ...)
    pub special: BTreeMap<String, String>,
    pub delimiter: String,
    /// `CREATE` answers `NO` (a server that does not let this user make folders)
    pub refuse_create: bool,
    /// `UID MOVE` answers `BAD` (a server without the MOVE extension: the client falls back to COPY + STORE + EXPUNGE)
    pub no_move: bool,
    /// `UID MOVE` and `UID COPY` answer `NO` (a full mailbox, no permission)
    pub fail_moves: bool,
    /// `APPEND` answers `NO` (a full mailbox, no permission) although the folder exists
    pub fail_append: bool,
    /// `UID FETCH` answers `NO` (a server that cannot give the headers back: nothing can be verified)
    pub fail_fetch: bool,
    /// every command received, without its tag (`UID MOVE 3 "Archive"`)
    pub log: Vec<String>,
    /// every message stored with APPEND: the folder and the bytes
    pub appended: Vec<(String, Vec<u8>)>,
    /// what `UID SEARCH` answers (default: every message of the selected folder, the fake does not keep message text)
    pub search_hits: Option<Vec<u32>>,
    /// message text by (folder, uid): what APPEND stores and `put_message` adds. `UID FETCH ... BODY[HEADER]` / `BODY[]` answer from it, and a
    /// `HEADER <name> "<text>"` search looks into it (unless `search_ignores_header`)
    pub messages: BTreeMap<(String, u32), Vec<u8>>,
    /// a server whose SEARCH does not look at HEADER: it answers with every message of the folder
    pub search_ignores_header: bool,
    pub deleted: BTreeSet<(String, u32)>,
    /// UIDVALIDITY per folder (1 when a folder has none here); `Fake::renumber` raises it
    pub validity: BTreeMap<String, u32>,
    /// CAPABILITY lists UIDPLUS and `UID EXPUNGE <set>` works (W6.1); without it only a plain `EXPUNGE` does
    pub uidplus: bool,
    /// folders LIST shows with `\Noinferiors` (they cannot have children)
    pub noinferiors: Vec<String>,
    /// folders that exist but LIST leaves out (another client made them a moment ago, or a server that lists late)
    pub hide_from_list: Vec<String>,
    /// the folders SUBSCRIBE was sent for
    pub subscribed: BTreeSet<String>,
    next_uid: u32,
}

pub struct Fake {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<State>>,
}

impl Fake {
    /// A server with the given folders and the UIDs in them (`INBOX` is added when missing).
    pub fn start(folders: &[(&str, &[u32])]) -> Fake {
        let mut st = State {
            folders: BTreeMap::new(),
            special: BTreeMap::new(),
            delimiter: "/".into(),
            refuse_create: false,
            no_move: false,
            fail_moves: false,
            fail_fetch: false,
            fail_append: false,
            log: vec![],
            appended: vec![],
            search_hits: None,
            messages: BTreeMap::new(),
            search_ignores_header: false,
            deleted: BTreeSet::new(),
            validity: BTreeMap::new(),
            uidplus: false,
            noinferiors: vec![],
            hide_from_list: vec![],
            subscribed: BTreeSet::new(),
            next_uid: 1000,
        };
        st.folders.entry("INBOX".into()).or_default();
        for (name, uids) in folders {
            st.folders.insert((*name).to_string(), uids.to_vec());
        }
        let state = Arc::new(Mutex::new(st));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let shared = state.clone();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let shared = shared.clone();
                std::thread::spawn(move || serve(c, shared));
            }
        });
        Fake { addr, state }
    }

    /// A logged-in client session on a plain connection.
    pub fn connect(&self) -> imap::Session<TcpStream> {
        let mut c = imap::Client::new(TcpStream::connect(self.addr).unwrap());
        c.read_greeting().unwrap();
        c.login("u", "p").map_err(|e| e.0).unwrap()
    }

    pub fn uids(&self, folder: &str) -> Option<Vec<u32>> {
        self.state.lock().unwrap().folders.get(folder).cloned()
    }

    pub fn has_folder(&self, folder: &str) -> bool {
        self.state.lock().unwrap().folders.contains_key(folder)
    }

    pub fn put_folder(&self, folder: &str, uids: &[u32]) {
        self.state.lock().unwrap().folders.insert(folder.to_string(), uids.to_vec());
    }

    /// A message with text in a folder (its uid is added to the folder).
    pub fn put_message(&self, folder: &str, uid: u32, raw: &[u8]) {
        let mut st = self.state.lock().unwrap();
        let f = st.folders.entry(folder.to_string()).or_default();
        if !f.contains(&uid) {
            f.push(uid);
        }
        st.messages.insert((folder.to_string(), uid), raw.to_vec());
    }

    /// Another program marked the message Deleted and did not expunge it (it still answers a SEARCH that does not say UNDELETED).
    pub fn flag_deleted(&self, folder: &str, uid: u32) {
        self.state.lock().unwrap().deleted.insert((folder.to_string(), uid));
    }

    /// The server renumbered the folder (a provider migration, the folder deleted and made again): a new UIDVALIDITY, and the messages get the UIDs 1..n in the
    /// reverse of their old order, so an old UID names another message. Returns the new UIDVALIDITY.
    pub fn renumber(&self, folder: &str) -> u32 {
        let mut st = self.state.lock().unwrap();
        let v = st.validity.get(folder).copied().unwrap_or(1) + 1;
        st.validity.insert(folder.to_string(), v);
        let mut old: Vec<u32> = st.folders.get(folder).cloned().unwrap_or_default();
        old.sort_unstable();
        let n = old.len() as u32;
        // old[i] becomes n - i
        let map: BTreeMap<u32, u32> = old.iter().enumerate().map(|(i, u)| (*u, n - i as u32)).collect();
        let msgs: Vec<((String, u32), Vec<u8>)> = st.messages.iter().filter(|((f, _), _)| f == folder).map(|(k, v)| (k.clone(), v.clone())).collect();
        for (k, _) in &msgs {
            st.messages.remove(k);
        }
        for ((f, u), bytes) in msgs {
            if let Some(nu) = map.get(&u) {
                st.messages.insert((f, *nu), bytes);
            }
        }
        let dels: Vec<(String, u32)> = st.deleted.iter().filter(|(f, _)| f == folder).cloned().collect();
        for d in &dels {
            st.deleted.remove(d);
        }
        for (f, u) in dels {
            if let Some(nu) = map.get(&u) {
                st.deleted.insert((f, *nu));
            }
        }
        let mut renumbered: Vec<u32> = map.values().copied().collect();
        renumbered.sort_unstable();
        st.folders.insert(folder.to_string(), renumbered);
        v
    }

    /// The message is gone from the server (expunged by another program).
    pub fn remove_message(&self, folder: &str, uid: u32) {
        let mut st = self.state.lock().unwrap();
        if let Some(f) = st.folders.get_mut(folder) {
            f.retain(|u| *u != uid);
        }
        st.messages.remove(&(folder.to_string(), uid));
    }

    /// The folders SUBSCRIBE was sent for.
    pub fn subscribed(&self) -> Vec<String> {
        self.state.lock().unwrap().subscribed.iter().cloned().collect()
    }

    pub fn commands(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }
}

/// The first argument of a command line: `"quoted name"` or a bare word; and what follows it.
fn arg(s: &str) -> (String, &str) {
    let s = s.trim_start();
    if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"').unwrap_or(rest.len());
        return (rest[..end].to_string(), rest.get(end + 1..).unwrap_or(""));
    }
    let end = s.find(' ').unwrap_or(s.len());
    (s[..end].to_string(), &s[end..])
}

/// A set of numbers as IMAP writes it: `10:12,500`, `7:*` (`*` is the largest number there is).
struct UidSet(Vec<(u32, u32)>);

impl UidSet {
    fn contains(&self, n: &u32) -> bool {
        self.0.iter().any(|(a, b)| a <= n && n <= b)
    }
}

fn uid_list(set: &str) -> UidSet {
    let num = |t: &str| if t == "*" { Some(u32::MAX) } else { t.parse::<u32>().ok() };
    let mut out = vec![];
    for part in set.split(',') {
        match part.split_once(':') {
            Some((a, b)) => {
                if let (Some(a), Some(b)) = (num(a), num(b)) {
                    out.push((a.min(b), a.max(b)));
                }
            }
            None => out.extend(num(part).map(|n| (n, n))),
        }
    }
    UidSet(out)
}

fn serve(c: TcpStream, shared: Arc<Mutex<State>>) {
    let mut w = c.try_clone().unwrap();
    let mut r = BufReader::new(c);
    let _ = w.write_all(b"* OK fake ready\r\n");
    let mut selected: Option<String> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let text = line.trim_end().to_string();
        let (tag, cmd) = text.split_once(' ').unwrap_or((&text, ""));
        let upper = cmd.to_uppercase();
        let mut st = shared.lock().unwrap();
        st.log.push(cmd.to_string());
        let mut out = String::new();
        if st.fail_fetch && (upper.starts_with("UID FETCH") || upper.starts_with("FETCH")) {
            out += &format!("{tag} NO [SERVERBUG] fetch failed\r\n");
        } else if upper.starts_with("LOGIN") {
            out += &format!("{tag} OK logged in\r\n");
        } else if upper.starts_with("CAPABILITY") {
            out += &format!("* CAPABILITY IMAP4rev1{}{}\r\n{tag} OK done\r\n", if st.no_move { "" } else { " MOVE" }, if st.uidplus { " UIDPLUS" } else { "" });
        } else if upper.starts_with("LIST") {
            for name in st.folders.keys().filter(|n| !st.hide_from_list.contains(n)) {
                let special = st.special.get(name).map(|s| format!(" {s}")).unwrap_or_default();
                let kind = if st.noinferiors.contains(name) { "\\Noinferiors" } else { "\\HasNoChildren" };
                out += &format!("* LIST ({kind}{special}) \"{}\" \"{name}\"\r\n", st.delimiter);
            }
            out += &format!("{tag} OK LIST done\r\n");
        } else if upper.starts_with("SELECT") {
            let (name, _) = arg(&cmd[6..]);
            match st.folders.get(&name) {
                Some(uids) => {
                    out += &format!("* FLAGS (\\Seen \\Deleted)\r\n* {} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY {}] ok\r\n{tag} OK [READ-WRITE] selected\r\n", uids.len(), st.validity.get(&name).copied().unwrap_or(1));
                    selected = Some(name);
                }
                None => out += &format!("{tag} NO [NONEXISTENT] no such mailbox\r\n"),
            }
        } else if upper.starts_with("CREATE") {
            let (name, _) = arg(&cmd[6..]);
            if st.refuse_create {
                out += &format!("{tag} NO [CANNOT] creating folders is not allowed\r\n");
            } else if st.folders.contains_key(&name) {
                out += &format!("{tag} NO [ALREADYEXISTS] mailbox already exists\r\n");
            } else {
                st.folders.insert(name, vec![]);
                out += &format!("{tag} OK CREATE done\r\n");
            }
        } else if upper.starts_with("SUBSCRIBE") {
            let (name, _) = arg(&cmd[9..]);
            st.subscribed.insert(name);
            out += &format!("{tag} OK SUBSCRIBE done\r\n");
        } else if upper.starts_with("APPEND") {
            let (name, rest) = arg(&cmd[6..]);
            let size: usize = rest.rfind('{').and_then(|i| rest[i + 1..].trim_end_matches('}').trim_end_matches('+').parse().ok()).unwrap_or(0);
            if !st.folders.contains_key(&name) {
                out += &format!("{tag} NO [TRYCREATE] no such mailbox\r\n");
            } else if st.fail_append {
                out += &format!("{tag} NO [OVERQUOTA] quota exceeded\r\n");
            } else {
                // continuation request, then the literal and the end of its line
                if w.write_all(b"+ go ahead\r\n").is_err() {
                    return;
                }
                let mut bytes = vec![0u8; size];
                if std::io::Read::read_exact(&mut r, &mut bytes).is_err() {
                    return;
                }
                let mut tail = String::new();
                let _ = r.read_line(&mut tail);
                st.next_uid += 1;
                let n = st.next_uid;
                st.folders.get_mut(&name).unwrap().push(n);
                st.messages.insert((name.clone(), n), bytes.clone());
                st.appended.push((name, bytes));
                out += &format!("{tag} OK [APPENDUID 1 {n}] APPEND done\r\n");
            }
        } else if upper.starts_with("UID FETCH") || upper.starts_with("FETCH") {
            // (FETCH names messages by their place in the folder, UID FETCH by UID)
            let by_uid = upper.starts_with("UID FETCH");
            let (set, rest) = arg(&cmd[if by_uid { 9 } else { 5 }..]);
            let want = uid_list(&set);
            let whole = rest.to_uppercase().contains("BODY.PEEK[]") || rest.to_uppercase().contains("BODY[]");
            if let Some(src) = selected.clone() {
                let mut in_order = st.folders[&src].clone();
                in_order.sort_unstable();
                for (i, u) in in_order.iter().enumerate() {
                    let key = if by_uid { *u } else { i as u32 + 1 };
                    let Some(raw) = st.messages.get(&(src.clone(), *u)).filter(|_| want.contains(&key)) else { continue };
                    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(raw.len());
                    let (section, bytes) = if whole { ("BODY[]", &raw[..]) } else { ("BODY[HEADER]", &raw[..head_end]) };
                    out += &format!("* {} FETCH (UID {u} {section} {{{}}}\r\n", i + 1, bytes.len());
                    out += &String::from_utf8_lossy(bytes);
                    out += ")\r\n";
                }
            }
            out += &format!("{tag} OK FETCH done\r\n");
        } else if upper.starts_with("UID SEARCH") {
            let header_text = upper.find("HEADER ").and_then(|_| cmd.split('"').nth(1)).map(str::to_string);
            let in_folder = selected.as_ref().and_then(|f| st.folders.get(f)).cloned().unwrap_or_default();
            let looked = match (&header_text, &selected) {
                (Some(text), Some(f)) if !st.search_ignores_header && st.messages.keys().any(|(mf, _)| mf == f) => Some(
                    in_folder.iter().copied().filter(|u| st.messages.get(&(f.clone(), *u)).is_some_and(|m| String::from_utf8_lossy(m).contains(text.as_str()))).collect::<Vec<u32>>(),
                ),
                _ => None,
            };
            let mut uids = st.search_hits.clone().or(looked).unwrap_or(in_folder);
            if upper.contains("DELETED") && !upper.contains("UNDELETED") {
                if let Some(f) = &selected {
                    uids.retain(|u| st.deleted.contains(&(f.clone(), *u)));
                }
            }
            if upper.contains("UNDELETED") {
                if let Some(f) = &selected {
                    uids.retain(|u| !st.deleted.contains(&(f.clone(), *u)));
                }
            }
            out += &format!("* SEARCH{}\r\n{tag} OK SEARCH done\r\n", uids.iter().map(|u| format!(" {u}")).collect::<String>());
        } else if upper.starts_with("UID MOVE") || upper.starts_with("UID COPY") {
            let mv = upper.starts_with("UID MOVE");
            let (set, rest) = arg(&cmd[8..]);
            let (dst, _) = arg(rest);
            if mv && st.no_move {
                out += &format!("{tag} BAD unknown command\r\n");
            } else if st.fail_moves {
                out += &format!("{tag} NO [OVERQUOTA] quota exceeded\r\n");
            } else if !st.folders.contains_key(&dst) {
                out += &format!("{tag} NO [TRYCREATE] no such mailbox\r\n");
            } else if let Some(src) = selected.clone() {
                let want = uid_list(&set);
                let have: Vec<u32> = st.folders[&src].iter().copied().filter(|u| want.contains(u)).collect();
                for _ in &have {
                    st.next_uid += 1;
                    let n = st.next_uid;
                    st.folders.get_mut(&dst).unwrap().push(n);
                }
                if mv {
                    st.folders.get_mut(&src).unwrap().retain(|u| !have.contains(u));
                }
                out += &format!("{tag} OK {} done\r\n", if mv { "MOVE" } else { "COPY" });
            } else {
                out += &format!("{tag} BAD no mailbox selected\r\n");
            }
        } else if upper.starts_with("UID STORE") {
            let (set, rest) = arg(&cmd[9..]);
            let rest_u = rest.to_uppercase();
            let silent = rest_u.contains(".SILENT");
            let adds = !rest_u.trim_start().starts_with("-FLAGS");
            let about_deleted = rest_u.contains("\\DELETED");
            if let Some(src) = selected.clone() {
                let want = uid_list(&set);
                for (i, u) in st.folders[&src].clone().iter().enumerate() {
                    if want.contains(u) {
                        if about_deleted {
                            if adds {
                                st.deleted.insert((src.clone(), *u));
                            } else {
                                st.deleted.remove(&(src.clone(), *u));
                            }
                        }
                        if !silent {
                            let flags = if st.deleted.contains(&(src.clone(), *u)) { "\\Deleted" } else { "" };
                            out += &format!("* {} FETCH (UID {u} FLAGS ({flags}))\r\n", i + 1);
                        }
                    }
                }
            }
            out += &format!("{tag} OK STORE done\r\n");
        } else if upper.starts_with("EXPUNGE") || upper.starts_with("UID EXPUNGE") {
            // UID EXPUNGE <set> removes only the \Deleted messages inside the set (UIDPLUS); a plain EXPUNGE removes every \Deleted message of the folder
            let only: Option<UidSet> = upper.starts_with("UID EXPUNGE").then(|| uid_list(arg(&cmd[11..]).0.as_str()));
            if only.is_some() && !st.uidplus {
                out += &format!("{tag} BAD unknown command\r\n");
            } else if let Some(src) = selected.clone() {
                let gone: Vec<(usize, u32)> = st.folders[&src]
                    .iter()
                    .copied()
                    .enumerate()
                    .filter(|(_, u)| st.deleted.contains(&(src.clone(), *u)) && only.as_ref().is_none_or(|o| o.contains(u)))
                    .collect();
                for (i, _) in gone.iter().rev() {
                    out += &format!("* {} EXPUNGE\r\n", i + 1);
                }
                let uids: Vec<u32> = gone.iter().map(|g| g.1).collect();
                st.folders.get_mut(&src).unwrap().retain(|u| !uids.contains(u));
                for u in &uids {
                    st.deleted.remove(&(src.clone(), *u));
                    st.messages.remove(&(src.clone(), *u));
                }
                out += &format!("{tag} OK EXPUNGE done\r\n");
            } else {
                out += &format!("{tag} OK EXPUNGE done\r\n");
            }
        } else if upper.starts_with("LOGOUT") {
            let _ = w.write_all(format!("* BYE bye\r\n{tag} OK LOGOUT done\r\n").as_bytes());
            return;
        } else {
            out += &format!("{tag} BAD unexpected\r\n");
        }
        drop(st);
        if w.write_all(out.as_bytes()).is_err() {
            return;
        }
    }
}
