//! What counts as "new mail" (1.0.7 W13.2, REQ-13.2.1 / 13.2.2). One definition for the highlight in the side menu (`mail-arrived`), the
//! notification and, later, the sound: a message found by a sync that is not the first sync of its folder, is unseen, lives in the Inbox or in
//! a folder the person made, and is neither mail the person sent (its From is the address of one of the mailboxes) nor mail that was moved
//! (its Message-ID was already stored in another folder of the mailbox, or the app moved it a moment ago).
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Sent, Drafts, Archive, Junk and Deleted Items never count (REQ-13.2.1).
pub fn folder_counts(role: &str) -> bool {
    role == "inbox" || role.starts_with("f:")
}

/// The lowercase addresses of all mailboxes (mail from one of them is the person's own).
pub fn own_set<'a>(emails: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    emails.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect()
}

/// REQ-13.2.1: is this message new mail? `moved` = its Message-ID is known in another folder of the mailbox (or was just moved by the app).
pub fn counts_as_new(role: &str, first_sync: bool, seen: bool, from_email: &str, own: &HashSet<String>, moved: bool) -> bool {
    folder_counts(role) && !first_sync && !seen && !moved && !own.contains(&from_email.trim().to_lowercase())
}

/// One folder's arrivals in the payload of `mail-arrived`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FolderArrivals {
    pub folder: String,
    pub threads: Vec<String>,
}

/// `{ accountId, folders: [{ folder, threads }] }`: arrivals (folder key, thread id) grouped by folder, in the order the folders first appear, no thread twice.
pub fn group(arrivals: &[(String, String)]) -> Vec<FolderArrivals> {
    let mut out: Vec<FolderArrivals> = vec![];
    for (folder, tid) in arrivals {
        match out.iter_mut().find(|f| &f.folder == folder) {
            Some(f) => {
                if !f.threads.contains(tid) {
                    f.threads.push(tid.clone());
                }
            }
            None => out.push(FolderArrivals { folder: folder.clone(), threads: vec![tid.clone()] }),
        }
    }
    out
}

/// How long the app remembers a move it made itself (the sync that finds the moved copy may come minutes later, after an IDLE-less poll).
const MOVED_FOR: Duration = Duration::from_secs(2 * 60 * 60);
const MOVED_CAP: usize = 5000;

static MOVED: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

/// The app moved this message (the person's own move, a filter's move): the copy a later sync finds in the target folder is not new mail.
pub fn note_moved(account_id: &str, message_id: &str) {
    if message_id.is_empty() {
        return;
    }
    let mut g = MOVED.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if map.len() >= MOVED_CAP {
        map.retain(|_, t| t.elapsed() < MOVED_FOR);
        if map.len() >= MOVED_CAP {
            map.clear();
        }
    }
    map.insert((account_id.to_string(), message_id.to_string()), Instant::now());
}

/// Was this message moved by the app a short while ago?
pub fn was_moved(account_id: &str, message_id: &str) -> bool {
    let g = MOVED.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref().and_then(|m| m.get(&(account_id.to_string(), message_id.to_string()))).map_or(false, |t| t.elapsed() < MOVED_FOR)
}

/// A per-sync tally of what the sync found: arrivals per folder, and the Message-IDs of rows the sync removed (a message that left one folder and
/// shows up in another folder of the same sync was moved, whatever the order of the folders).
#[derive(Default)]
pub struct Tally {
    pub arrivals: Vec<(String, String)>,
    removed_ids: HashSet<String>,
}

impl Tally {
    pub fn removed(&mut self, message_id: &str) {
        if !message_id.is_empty() {
            self.removed_ids.insert(message_id.to_string());
        }
    }
    pub fn was_removed(&self, message_id: &str) -> bool {
        self.removed_ids.contains(message_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn own() -> HashSet<String> {
        own_set(["me@example.com", "Work@Example.com"])
    }

    #[test]
    fn new_mail_is_reported_per_folder_without_own_or_moved_mail() {
        let o = own();
        // the first sync of a folder is only a taste: nothing is new
        assert!(!counts_as_new("inbox", true, false, "a@x.org", &o, false));
        // an unseen mail in the Inbox and in a folder the person made
        assert!(counts_as_new("inbox", false, false, "a@x.org", &o, false));
        assert!(counts_as_new("f:Projects", false, false, "a@x.org", &o, false));
        // seen: not
        assert!(!counts_as_new("inbox", false, true, "a@x.org", &o, false));
        // the person's own address (any mailbox, any case): not
        assert!(!counts_as_new("inbox", false, false, "ME@example.com", &o, false));
        assert!(!counts_as_new("f:Projects", false, false, " work@example.com ", &o, false));
        // moved (its Message-ID is known elsewhere): not
        assert!(!counts_as_new("f:Projects", false, false, "a@x.org", &o, true));
        // standard folders other than the Inbox never count
        for r in ["sent", "drafts", "archive", "trash", "junk"] {
            assert!(!counts_as_new(r, false, false, "a@x.org", &o, false), "{r}");
        }
    }

    #[test]
    fn arrivals_are_grouped_by_folder_without_repeats() {
        let a = vec![
            ("inbox".to_string(), "t1".to_string()),
            ("f:Projects".to_string(), "t2".to_string()),
            ("inbox".to_string(), "t3".to_string()),
            ("inbox".to_string(), "t1".to_string()),
        ];
        let g = group(&a);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0], FolderArrivals { folder: "inbox".into(), threads: vec!["t1".into(), "t3".into()] });
        assert_eq!(g[1].folder, "f:Projects");
        assert!(group(&[]).is_empty());
        let json = serde_json::to_string(&g).unwrap();
        assert_eq!(json, r#"[{"folder":"inbox","threads":["t1","t3"]},{"folder":"f:Projects","threads":["t2"]}]"#);
    }

    /// The sync cannot run against the small fake server (it has no flags and no STARTTLS), so the wiring is checked in the source: one definition of new mail, applied to the
    /// notification list as well as to the `mail-arrived` payload, with the moved-mail checks before the row is written.
    #[test]
    fn sync_uses_the_one_definition_of_new_mail() {
        let src = include_str!("lib.rs");
        let sync = &src[src.find("fn sync_impl(").unwrap()..src.find("/// What running the rules over new mail came to").unwrap()];
        assert!(sync.contains("newmail::counts_as_new(&role, max_uid == 0, p.seen, &p.from_email, &own, moved)"), "the decision");
        let moved = sync.find("let moved =").unwrap();
        let insert = sync.find("let tid = insert_parsed(").unwrap();
        assert!(moved < insert, "moved mail is looked for before the row is written");
        assert!(sync.contains("tally.was_removed(mid)") && sync.contains("newmail::was_moved(account_id, mid)") && sync.contains("message_id=?2 AND folder<>?3"), "the three moved-mail checks");
        let flat: String = sync.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(flat.contains("if is_new { result.new_inbox.push("), "the notification list uses the same decision");
        assert!(sync.contains("tally.removed(&mid)"), "rows removed by this sync are noted");
        assert!(sync.contains("outcome.moved_to"), "a filter move is new mail in the target folder");
        let run = &src[src.find("fn run_sync_inner(").unwrap()..];
        assert!(run.contains("\"mail-arrived\"") && run.contains("newmail::group(&r.arrivals)"), "the main window is told");
        let act = &src[src.find("fn act_on_session").unwrap()..];
        assert!(act.contains("newmail::note_moved(&acc.id, &mid)"), "a move the app makes is remembered");
    }

    #[test]
    fn a_move_the_app_made_is_remembered_and_a_removed_row_marks_a_move() {
        note_moved("acc-newmail-test", "<m1@x>");
        assert!(was_moved("acc-newmail-test", "<m1@x>"));
        assert!(!was_moved("acc-newmail-test", "<other@x>"));
        assert!(!was_moved("acc-other", "<m1@x>"));
        note_moved("acc-newmail-test", "");
        assert!(!was_moved("acc-newmail-test", ""));
        let mut t = Tally::default();
        t.removed("<gone@x>");
        t.removed("");
        assert!(t.was_removed("<gone@x>"));
        assert!(!t.was_removed(""));
    }
}
