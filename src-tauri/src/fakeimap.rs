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
    /// every command received, without its tag (`UID MOVE 3 "Archive"`)
    pub log: Vec<String>,
    /// every message stored with APPEND: the folder and the bytes
    pub appended: Vec<(String, Vec<u8>)>,
    deleted: BTreeSet<(String, u32)>,
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
            log: vec![],
            appended: vec![],
            deleted: BTreeSet::new(),
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

/// `10:12,500` -> [10, 11, 12, 500]
fn uid_list(set: &str) -> Vec<u32> {
    let mut out = vec![];
    for part in set.split(',') {
        match part.split_once(':') {
            Some((a, b)) => out.extend(a.parse::<u32>().unwrap_or(0)..=b.parse::<u32>().unwrap_or(0)),
            None => out.extend(part.parse::<u32>().ok()),
        }
    }
    out
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
        if upper.starts_with("LOGIN") {
            out += &format!("{tag} OK logged in\r\n");
        } else if upper.starts_with("CAPABILITY") {
            out += &format!("* CAPABILITY IMAP4rev1{}\r\n{tag} OK done\r\n", if st.no_move { "" } else { " MOVE" });
        } else if upper.starts_with("LIST") {
            for name in st.folders.keys() {
                let special = st.special.get(name).map(|s| format!(" {s}")).unwrap_or_default();
                out += &format!("* LIST (\\HasNoChildren{special}) \"{}\" \"{name}\"\r\n", st.delimiter);
            }
            out += &format!("{tag} OK LIST done\r\n");
        } else if upper.starts_with("SELECT") {
            let (name, _) = arg(&cmd[6..]);
            match st.folders.get(&name) {
                Some(uids) => {
                    out += &format!("* FLAGS (\\Seen \\Deleted)\r\n* {} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n{tag} OK [READ-WRITE] selected\r\n", uids.len());
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
            out += &format!("{tag} OK SUBSCRIBE done\r\n");
        } else if upper.starts_with("APPEND") {
            let (name, rest) = arg(&cmd[6..]);
            let size: usize = rest.rfind('{').and_then(|i| rest[i + 1..].trim_end_matches('}').trim_end_matches('+').parse().ok()).unwrap_or(0);
            if !st.folders.contains_key(&name) {
                out += &format!("{tag} NO [TRYCREATE] no such mailbox\r\n");
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
                st.appended.push((name, bytes));
                out += &format!("{tag} OK [APPENDUID 1 {n}] APPEND done\r\n");
            }
        } else if upper.starts_with("UID SEARCH") {
            let uids = selected.as_ref().and_then(|f| st.folders.get(f)).cloned().unwrap_or_default();
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
            let (set, _) = arg(&cmd[9..]);
            if let Some(src) = selected.clone() {
                let want = uid_list(&set);
                for (i, u) in st.folders[&src].clone().iter().enumerate() {
                    if want.contains(u) {
                        st.deleted.insert((src.clone(), *u));
                        out += &format!("* {} FETCH (UID {u} FLAGS (\\Deleted))\r\n", i + 1);
                    }
                }
            }
            out += &format!("{tag} OK STORE done\r\n");
        } else if upper.starts_with("EXPUNGE") {
            if let Some(src) = selected.clone() {
                let gone: Vec<(usize, u32)> = st.folders[&src].iter().copied().enumerate().filter(|(_, u)| st.deleted.contains(&(src.clone(), *u))).collect();
                for (i, _) in gone.iter().rev() {
                    out += &format!("* {} EXPUNGE\r\n", i + 1);
                }
                let uids: Vec<u32> = gone.iter().map(|g| g.1).collect();
                st.folders.get_mut(&src).unwrap().retain(|u| !uids.contains(u));
            }
            out += &format!("{tag} OK EXPUNGE done\r\n");
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
