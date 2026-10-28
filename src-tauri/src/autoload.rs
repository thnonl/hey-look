//! Pictures that show without a click (1.0.10, spec ba-v1010-written-to-and-placeholders.md): the mail of people you have written to (rule A) and of well-known services
//! (rule C), each only when the sender check proves the mail is from that domain (`authres::Evidence`). The rule is decided here, where the data is; the page only gets the
//! reason (`"wrote"` / `"service"` / none) and applies the exclusions it knows about (Junk, encrypted, a failed check, the senders the person turned it off for).
//!
//! The list of services is ONE sorted constant (`SERVICE_DOMAINS`) with its tests: the owner may still edit it, and a change is a one-line diff. Free mailbox domains and
//! domains anyone can send from are never in it (`NEVER_LISTED`, a test).
use crate::authres::Evidence;
use rusqlite::{params, Connection};
use std::collections::HashSet;

/// Raise when the list below changes.
#[cfg(test)] // (read by the test that keeps it in step with the list; the app does not need it)
pub const SERVICE_LIST_VERSION: u32 = 1;

/// Well-known services: a From domain that equals one of these or is a subdomain of it, with a passing check for that domain. Lower case, sorted, one entry per line.
pub const SERVICE_DOMAINS: &[&str] = &[
    "adobe.com",
    "airbnb.com",
    "amazon.ca",
    "amazon.co.jp",
    "amazon.co.uk",
    "amazon.com",
    "amazon.com.au",
    "amazon.de",
    "amazon.es",
    "amazon.fr",
    "amazon.in",
    "amazon.it",
    "amazon.sg",
    "apple.com",
    "asana.com",
    "atlassian.com",
    "booking.com",
    "canva.com",
    "discord.com",
    "dropbox.com",
    "dropboxmail.com",
    "facebook.com",
    "facebookmail.com",
    "figma.com",
    "github.com",
    "google.com",
    "grab.com",
    "instagram.com",
    "itunes.com",
    "lazada.com",
    "lazada.vn",
    "linkedin.com",
    "medium.com",
    "meta.com",
    "microsoft.com",
    "microsoftonline.com",
    "momo.vn",
    "netflix.com",
    "notion.so",
    "office.com",
    "office365.com",
    "paypal.com",
    "pinterest.com",
    "reddit.com",
    "redditmail.com",
    "shopee.com",
    "shopee.vn",
    "shopify.com",
    "skype.com",
    "slack.com",
    "spotify.com",
    "steampowered.com",
    "stripe.com",
    "telegram.org",
    "tiki.vn",
    "tiktok.com",
    "trello.com",
    "twitter.com",
    "uber.com",
    "whatsapp.com",
    "x.com",
    "xbox.com",
    "youtube.com",
    "zoom.us",
];

/// Subdomains of the list that are NOT the service speaking (messages between buyers and sellers, third-party content).
pub const SERVICE_EXCLUDE: &[&str] = &[
    "marketplace.amazon.ca",
    "marketplace.amazon.co.jp",
    "marketplace.amazon.co.uk",
    "marketplace.amazon.com",
    "marketplace.amazon.com.au",
    "marketplace.amazon.de",
    "marketplace.amazon.es",
    "marketplace.amazon.fr",
    "marketplace.amazon.in",
    "marketplace.amazon.it",
    "marketplace.amazon.sg",
];

/// The lower-case domain of an address (after the last `@`), without a trailing dot.
pub fn domain_of(email: &str) -> String {
    email.rsplit('@').next().unwrap_or("").trim().trim_end_matches('.').to_ascii_lowercase()
}

/// `d` is `parent` or a subdomain of it (by labels: `accounts.google.com` is under `google.com`, `evilgoogle.com` and `google.com.evil.example` are not).
pub fn under(d: &str, parent: &str) -> bool {
    !parent.is_empty() && (d == parent || (d.len() > parent.len() && d.ends_with(parent) && d.as_bytes()[d.len() - parent.len() - 1] == b'.'))
}

/// The list entry the From domain belongs to (not for an excluded subdomain).
pub fn service_match(from_domain: &str) -> Option<&'static str> {
    if SERVICE_EXCLUDE.iter().any(|e| under(from_domain, e)) {
        return None;
    }
    SERVICE_DOMAINS.iter().copied().find(|s| under(from_domain, s))
}

/// The local part of a "do not answer" address: no-reply / noreply / do-not-reply / donotreply (with `-`, `_` or `.` between the words), mailer-daemon, postmaster,
/// bounce(s); an optional `+tag` / `-...` / `_...` / `.…` tail. Not `noreplyfan`.
pub fn is_noreply(local: &str) -> bool {
    let l = local.to_ascii_lowercase();
    for head in ["noreply", "no-reply", "no_reply", "no.reply", "donotreply", "do-not-reply", "do_not_reply", "do.not.reply", "mailer-daemon", "postmaster", "bounce", "bounces"] {
        if let Some(rest) = l.strip_prefix(head) {
            if rest.is_empty() || rest.starts_with(['-', '+', '_', '.']) {
                return true;
            }
        }
    }
    false
}

impl Evidence {
    /// Rule A: the check ties the mail to the From domain: a passing DMARC for it (or without a stated domain), or a passing DKIM signature of a domain that belongs with it
    /// (the same, the From domain is under the signing domain, or the signing domain is under the From domain). SPF alone is not evidence.
    pub fn ties_to(&self, from_domain: &str) -> bool {
        if from_domain.is_empty() {
            return false;
        }
        (self.dmarc_pass && self.dmarc_from.as_deref().map_or(true, |f| f == from_domain)) || self.dkim_d.iter().any(|d| under(from_domain, d) || under(d, from_domain))
    }

    /// Rule C: a passing DMARC for the From domain, or a passing DKIM signature of the service's own domain (or one under it). The signature of a sending service
    /// (sendgrid.net, amazonses.com ...) does not count.
    pub fn ties_to_service(&self, from_domain: &str, service: &str) -> bool {
        (self.dmarc_pass && self.dmarc_from.as_deref().map_or(true, |f| f == from_domain)) || self.dkim_d.iter().any(|d| under(d, service))
    }
}

/// Everything the rule looks at about one message.
pub struct Input<'a> {
    pub from_email: &'a str,
    pub folder: &'a str,
    pub encrypted: bool,
    pub auth_result: Option<&'a str>,
    pub auth_ev: Option<&'a str>,
    pub list_hdr: bool,
    pub list_unsub: bool,
    /// the From address is in `written_to`
    pub written: bool,
    /// lower-case addresses of the person's own mailboxes (and their Reply-To addresses)
    pub own_addrs: &'a HashSet<String>,
    /// lower-case domains of the person's own mailboxes
    pub own_domains: &'a HashSet<String>,
}

/// Why the pictures of this message may show without a click: `"wrote"`, `"service"` or none. Pure. (The page adds: not the senders turned off, and the global switch.)
pub fn reason(i: &Input) -> Option<&'static str> {
    if i.folder == "junk" || i.encrypted || i.auth_result == Some("fail") {
        return None;
    }
    let ev = Evidence::from_db(i.auth_ev)?;
    let from = i.from_email.trim().to_ascii_lowercase();
    let (local, domain) = from.rsplit_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    if i.written && !i.list_hdr && !i.list_unsub && !is_noreply(local) && !i.own_addrs.contains(&from) && ev.ties_to(domain) {
        return Some("wrote");
    }
    if !i.own_domains.contains(domain) {
        if let Some(service) = service_match(domain) {
            if ev.ties_to_service(domain, service) {
                return Some("service");
            }
        }
    }
    None
}

// ---- the addresses the person has written to ----

/// (the table `written_to` is made with the others in db.rs `migrate`)
/// The addresses of a `to_addrs` / `cc_addrs` text (bare addresses joined by `,`), lower case, valid ones only.
pub fn addresses(joined: &str) -> Vec<String> {
    joined
        .split(',')
        .filter_map(|p| match (p.find('<'), p.rfind('>')) {
            (Some(a), Some(b)) if a < b => crate::remote_ok::normalize(&p[a + 1..b]),
            _ => crate::remote_ok::normalize(p),
        })
        .collect()
}

/// Remember the To and Cc addresses of a sent message.
pub fn note_written(c: &Connection, account_id: &str, to: &str, cc: &str) {
    for e in addresses(to).into_iter().chain(addresses(cc)) {
        let _ = c.execute("INSERT OR IGNORE INTO written_to(email, account_id) VALUES(?1, ?2)", params![e, account_id]);
    }
}

/// Whether any mailbox of the app has sent mail to this address.
pub fn was_written(c: &Connection, email: &str) -> bool {
    c.query_row("SELECT 1 FROM written_to WHERE email=?1 LIMIT 1", [email.trim().to_ascii_lowercase()], |_| Ok(())).is_ok()
}

pub fn forget_account(c: &Connection, account_id: &str) {
    let _ = c.execute("DELETE FROM written_to WHERE account_id=?1", [account_id]);
    let _ = c.execute("DELETE FROM settings WHERE key=?1", [backfill_key(account_id)]);
}

fn backfill_key(account_id: &str) -> String {
    format!("written_to_v1:{account_id}")
}

/// One-time fill from the Sent folder of each mailbox (a mailbox that was synced before this version has no `written_to` rows): walks one mail file at a time (a view has no
/// rowid), 200 rows per short transaction, a flag per account in `settings`; run again it changes nothing. Returns the number of address rows added.
pub fn backfill(c: &Connection) -> Result<usize, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let todo: HashSet<String> = {
        let mut st = c.prepare("SELECT id FROM accounts").map_err(e)?;
        let ids = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?.collect::<Result<Vec<String>, _>>().map_err(e)?;
        ids.into_iter().filter(|id| c.query_row("SELECT 1 FROM settings WHERE key=?1", [backfill_key(id)], |_| Ok(())).is_err()).collect()
    };
    if todo.is_empty() {
        return Ok(0);
    }
    let mut added = 0usize;
    for schema in crate::shard::message_schemas(c) {
        let table = format!("{schema}.messages");
        let mut last = 0i64;
        loop {
            let batch: Vec<(i64, String, String, String)> = {
                let mut st = c
                    .prepare(&format!("SELECT rowid, account_id, to_addrs, cc_addrs FROM {table} WHERE folder='sent' AND rowid>?1 ORDER BY rowid LIMIT 200"))
                    .map_err(e)?;
                let rows = st.query_map([last], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
                rows
            };
            let Some(&(max, ..)) = batch.last() else { break };
            let tx = c.unchecked_transaction().map_err(e)?;
            for (_, acc, to, cc) in &batch {
                if !todo.contains(acc) {
                    continue;
                }
                let count = |t: &Connection| t.query_row("SELECT COUNT(*) FROM written_to", [], |r| r.get::<_, i64>(0)).unwrap_or(0);
                let before = count(&tx);
                note_written(&tx, acc, to, cc);
                added += (count(&tx) - before).max(0) as usize;
            }
            tx.commit().map_err(e)?;
            last = max;
        }
    }
    for id in &todo {
        c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')", [backfill_key(id)]).map_err(e)?;
    }
    Ok(added)
}

/// The own addresses (mailbox address and Reply-To) and own domains of every mailbox.
pub fn own_sets(c: &Connection) -> (HashSet<String>, HashSet<String>) {
    let mut addrs = HashSet::new();
    let mut domains = HashSet::new();
    if let Ok(mut st) = c.prepare("SELECT email, reply_to FROM accounts") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (email, reply) in rows.flatten() {
                for a in [email, reply] {
                    let a = a.trim().to_ascii_lowercase();
                    if a.contains('@') {
                        domains.insert(domain_of(&a));
                        addrs.insert(a);
                    }
                }
            }
        }
    }
    (addrs, domains)
}

/// The reason for one stored message (reads `written_to` and the mailboxes).
pub fn reason_for(c: &Connection, from_email: &str, folder: &str, encrypted: bool, auth_result: Option<&str>, auth_ev: Option<&str>, list_hdr: bool, list_unsub: bool) -> Option<&'static str> {
    auth_ev?;
    let (own_addrs, own_domains) = own_sets(c);
    let written = was_written(c, from_email);
    reason(&Input { from_email, folder, encrypted, auth_result, auth_ev, list_hdr, list_unsub, written, own_addrs: &own_addrs, own_domains: &own_domains })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authres::Evidence;

    fn ev(dmarc: bool, from: Option<&str>, dkim: &[&str]) -> Option<String> {
        Evidence { dmarc_pass: dmarc, dmarc_from: from.map(String::from), dkim_d: dkim.iter().map(|d| d.to_string()).collect() }.to_db()
    }

    fn input<'a>(from: &'a str, ev: Option<&'a str>, written: bool, own: &'a (HashSet<String>, HashSet<String>)) -> Input<'a> {
        Input { from_email: from, folder: "inbox", encrypted: false, auth_result: Some("pass"), auth_ev: ev, list_hdr: false, list_unsub: false, written, own_addrs: &own.0, own_domains: &own.1 }
    }

    fn own() -> (HashSet<String>, HashSet<String>) {
        (["me@mine.example".to_string(), "reply@alias.example".to_string()].into_iter().collect(), ["mine.example".to_string(), "alias.example".to_string()].into_iter().collect())
    }

    /// T-R7: the list is data a person edits: sorted, unique, lower case, plain domains, never a free mailbox or a domain anyone can send from.
    #[test]
    fn the_service_list_is_sorted_clean_and_never_holds_a_mailbox_domain() {
        for list in [SERVICE_DOMAINS, SERVICE_EXCLUDE] {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted, list, "sorted, no duplicates");
            for d in list {
                assert_eq!(*d, d.to_ascii_lowercase());
                assert!(d.contains('.') && !d.contains('*') && !d.contains('@') && !d.contains(' ') && !d.starts_with('.') && !d.ends_with('.'), "{d}");
            }
        }
        const NEVER: &[&str] = &[
            "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
            "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.ru", "yandex.ru", "yandex.com", "qq.com", "163.com", "126.com", "zoho.com", "zohomail.com", "fastmail.com", "tutanota.com", "hey.com",
            "googlegroups.com", "groups.io", "freelists.org", "substack.com", "atlassian.net", "sharepointonline.com", "docusign.net", "typeform.com", "jotform.com", "surveymonkey.com", "calendly.com",
            "eventbrite.com", "mcsv.net", "mcdlv.net", "sendgrid.net", "amazonses.com", "gitlab.com", "zalo.me", "vng.com.vn", "vietcombank.com.vn", "techcombank.com.vn",
        ];
        for n in NEVER {
            assert!(service_match(n).is_none(), "{n} must not match the service list");
            assert!(service_match(&format!("mail.{n}")).is_none(), "mail.{n}");
            for s in SERVICE_DOMAINS {
                assert!(!under(s, n), "{s} is under {n}");
            }
        }
        for e in SERVICE_EXCLUDE {
            assert!(SERVICE_DOMAINS.iter().any(|s| under(e, s) && *e != *s), "{e} is a subdomain of an entry");
        }
        assert_eq!(SERVICE_LIST_VERSION, 1, "raise it with the list");
        assert!(SERVICE_DOMAINS.len() >= 60, "the list of the spec (Appendix A.1) is there: {}", SERVICE_DOMAINS.len());
    }

    #[test]
    fn services_match_by_label_not_by_text() {
        assert_eq!(service_match("google.com"), Some("google.com"));
        assert_eq!(service_match("accounts.google.com"), Some("google.com"));
        assert_eq!(service_match("a.b.accounts.google.com"), Some("google.com"));
        assert_eq!(service_match("google.com.evil.example"), None);
        assert_eq!(service_match("evilgoogle.com"), None);
        assert_eq!(service_match("google.co"), None);
        assert_eq!(service_match("amazon.com"), Some("amazon.com"));
        assert_eq!(service_match("marketplace.amazon.com"), None, "excluded");
        assert_eq!(service_match("x.marketplace.amazon.de"), None, "excluded, deeper");
        assert_eq!(service_match("github.com"), Some("github.com"));
        assert_eq!(service_match("notgithub.com"), None);
        assert_eq!(service_match(""), None);
    }

    #[test]
    fn noreply_forms_are_recognised_and_only_those() {
        for l in ["noreply", "no-reply", "No_Reply", "no.reply", "donotreply", "do-not-reply", "do_not_reply", "do.not.reply", "mailer-daemon", "postmaster", "bounce", "bounces", "noreply+x", "no-reply-alerts", "bounces.abc", "noreply_news"] {
            assert!(is_noreply(l), "{l}");
        }
        for l in ["noreplyfan", "reply", "nora", "anne", "bouncer", "postmasters", "no", "info", "do-not-replyto", "x-noreply"] {
            assert!(!is_noreply(l), "{l}");
        }
    }

    /// T-R2: rule A.
    #[test]
    fn people_you_wrote_to_show_pictures_only_with_a_check_that_ties_the_mail_to_their_domain() {
        let o = own();
        let strong = ev(true, Some("example.org"), &["example.org"]);
        assert_eq!(reason(&input("x@example.org", strong.as_deref(), true, &o)), Some("wrote"));
        assert_eq!(reason(&input("X@Example.ORG", strong.as_deref(), true, &o)), Some("wrote"), "without case");
        assert_eq!(reason(&input("x@example.org", strong.as_deref(), false, &o)), None, "not written to");
        // the check
        assert_eq!(reason(&input("x@example.org", None, true, &o)), None, "no evidence: SPF only, no header, or a message stored before");
        assert_eq!(reason(&input("x@example.org", ev(false, None, &["evil.example"]).as_deref(), true, &o)), None, "forged: the signature is of another domain");
        assert_eq!(reason(&input("x@example.org", ev(false, None, &["sendgrid.net"]).as_deref(), true, &o)), None, "a sending service's signature");
        assert_eq!(reason(&input("x@example.org", ev(true, Some("other.example"), &[]).as_deref(), true, &o)), None, "DMARC for another domain");
        assert_eq!(reason(&input("x@example.org", ev(true, None, &[]).as_deref(), true, &o)), Some("wrote"), "DMARC pass, header.from not stated");
        assert_eq!(reason(&input("x@news.example.org", ev(false, None, &["example.org"]).as_deref(), true, &o)), Some("wrote"), "From under the signing domain");
        assert_eq!(reason(&input("x@example.org", ev(false, None, &["mail.example.org"]).as_deref(), true, &o)), Some("wrote"), "signing domain under the From domain");
        assert_eq!(reason(&input("x@example.org", ev(false, None, &["notexample.org"]).as_deref(), true, &o)), None, "not by labels");
        // exclusions
        let mut i = input("x@example.org", strong.as_deref(), true, &o);
        i.list_hdr = true;
        assert_eq!(reason(&i), None, "List-Id / List-Post");
        i.list_hdr = false;
        i.list_unsub = true;
        assert_eq!(reason(&i), None, "List-Unsubscribe");
        i.list_unsub = false;
        i.folder = "junk";
        assert_eq!(reason(&i), None, "Junk");
        i.folder = "inbox";
        i.encrypted = true;
        assert_eq!(reason(&i), None, "encrypted");
        i.encrypted = false;
        i.auth_result = Some("fail");
        assert_eq!(reason(&i), None, "a failed check");
        for from in ["noreply@example.org", "no-reply@example.org", "donotreply@example.org", "mailer-daemon@example.org", "bounces+abc@example.org"] {
            assert_eq!(reason(&input(from, strong.as_deref(), true, &o)), None, "{from}");
        }
        assert_eq!(reason(&input("noreplyfan@example.org", strong.as_deref(), true, &o)), Some("wrote"), "only the do-not-answer forms");
        let own_strong = ev(true, Some("mine.example"), &["mine.example"]);
        assert_eq!(reason(&input("me@mine.example", own_strong.as_deref(), true, &o)), None, "your own address");
        let reply_strong = ev(true, Some("alias.example"), &["alias.example"]);
        assert_eq!(reason(&input("reply@alias.example", reply_strong.as_deref(), true, &o)), None, "your Reply-To address");
        assert_eq!(reason(&input("colleague@mine.example", own_strong.as_deref(), true, &o)), Some("wrote"), "a colleague you wrote to");
        assert_eq!(reason(&input("not-an-address", strong.as_deref(), true, &o)), None);
        assert_eq!(reason(&input("@example.org", strong.as_deref(), true, &o)), None);
    }

    /// T-R3: rule C.
    #[test]
    fn well_known_services_show_pictures_only_when_the_check_is_theirs() {
        let o = own();
        let g = ev(true, Some("accounts.google.com"), &["accounts.google.com"]);
        assert_eq!(reason(&input("no-reply@accounts.google.com", g.as_deref(), false, &o)), Some("service"));
        assert_eq!(reason(&input("a@google.com", ev(false, None, &["google.com"]).as_deref(), false, &o)), Some("service"), "DKIM of the service");
        assert_eq!(reason(&input("a@google.com", ev(false, None, &["sendgrid.net"]).as_deref(), false, &o)), None, "DKIM of a sending service, no DMARC");
        assert_eq!(reason(&input("a@google.com", ev(false, None, &["amazonses.com"]).as_deref(), false, &o)), None);
        assert_eq!(reason(&input("a@google.com", ev(true, Some("google.com"), &["sendgrid.net"]).as_deref(), false, &o)), Some("service"), "DMARC passes for the service domain");
        assert_eq!(reason(&input("a@google.com", ev(true, Some("other.example"), &[]).as_deref(), false, &o)), None, "DMARC for another domain");
        assert_eq!(reason(&input("a@google.com", None, false, &o)), None, "SPF only / nothing");
        for from in ["a@google.com.evil.example", "a@evilgoogle.com", "a@google.co", "a@marketplace.amazon.com", "a@gmail.com"] {
            let all = ev(true, None, &["google.com", "gmail.com", "marketplace.amazon.com", "evilgoogle.com", "google.com.evil.example"]);
            assert_eq!(reason(&input(from, all.as_deref(), false, &o)), None, "{from}");
        }
        // junk, encrypted, failed
        let gh = ev(true, None, &["github.com"]);
        let mut i = input("a@github.com", gh.as_deref(), false, &o);
        assert_eq!(reason(&i), Some("service"));
        i.folder = "junk";
        assert_eq!(reason(&i), None);
        i.folder = "inbox";
        i.encrypted = true;
        assert_eq!(reason(&i), None);
        i.encrypted = false;
        i.auth_result = Some("fail");
        assert_eq!(reason(&i), None);
        // a list header does not stop a service (GitHub and Spotify send them), your own account's domain does
        i.auth_result = Some("pass");
        i.list_hdr = true;
        i.list_unsub = true;
        assert_eq!(reason(&i), Some("service"));
        let mut mine = own();
        mine.1.insert("microsoft.com".to_string());
        assert_eq!(reason(&input("colleague@microsoft.com", ev(true, None, &["microsoft.com"]).as_deref(), false, &mine)), None, "your own domain is not a service");
        // both rules: the reason is "wrote"
        assert_eq!(reason(&input("a@github.com", ev(true, Some("github.com"), &["github.com"]).as_deref(), true, &o)), Some("wrote"));
    }

    fn db() -> Connection {
        let c = crate::db::test_conn(&["a1", "a2"]);
        for (id, email) in [("a1", "me@mine.example"), ("a2", "me2@mine.example")] {
            c.execute(
                "INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username) VALUES(?1,?2,'M','h',993,1,'h',587,'starttls','u')",
                params![id, email],
            )
            .unwrap();
        }
        c
    }

    fn put(c: &Connection, acc: &str, id: &str, folder: &str, to: &str, cc: &str) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,?3,(SELECT COUNT(*)+1 FROM messages),'t','s','n','e',?4,?5,1,'')",
            params![id, acc, folder, to, cc],
        )
        .unwrap();
    }

    /// T-R4: the addresses written to.
    #[test]
    fn written_to_is_filled_from_sent_mail_without_case_and_only_once() {
        let c = db();
        put(&c, "a1", "1", "sent", "Alice@Example.org,bob@x.org", "carol@x.org");
        put(&c, "a1", "2", "inbox", "spam@x.org", "");
        put(&c, "a2", "3", "sent", "dave@x.org", "alice@example.ORG");
        put(&c, "a1", "4", "sent", "broken,,not an address", "");
        assert!(!was_written(&c, "alice@example.org"));
        let n = backfill(&c).unwrap();
        assert_eq!(n, 5, "alice, bob, carol (a1), dave and alice again (a2)");
        for e in ["alice@example.org", "ALICE@example.org", "bob@x.org", "carol@x.org", "dave@x.org"] {
            assert!(was_written(&c, e), "{e}");
        }
        assert!(!was_written(&c, "spam@x.org"), "not from the Inbox");
        assert!(!was_written(&c, "broken"));
        assert_eq!(backfill(&c).unwrap(), 0, "once");
        // a new sent mail is added at once, a second time changes nothing
        note_written(&c, "a1", "New@X.org", "");
        note_written(&c, "a1", "new@x.org", "");
        assert!(was_written(&c, "new@x.org"));
        assert_eq!(c.query_row("SELECT COUNT(*) FROM written_to WHERE email='new@x.org'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        // deleting the account takes its rows (and its flag), the other account's stay
        forget_account(&c, "a1");
        assert!(!was_written(&c, "bob@x.org") && !was_written(&c, "new@x.org"));
        assert!(was_written(&c, "dave@x.org") && was_written(&c, "alice@example.org"), "a2 wrote to them too");
    }

    #[test]
    fn the_backfill_works_in_batches() {
        let c = db();
        for i in 0..450 {
            put(&c, "a1", &format!("m{i}"), "sent", &format!("u{i}@x.org"), "");
        }
        assert_eq!(backfill(&c).unwrap(), 450);
        assert!(was_written(&c, "u449@x.org") && was_written(&c, "u0@x.org"));
    }

    #[test]
    fn the_rule_reads_the_written_to_table_and_the_mailboxes() {
        let c = db();
        note_written(&c, "a1", "x@example.org", "");
        let ev = Evidence { dmarc_pass: true, dmarc_from: Some("example.org".into()), dkim_d: vec!["example.org".into()] }.to_db();
        assert_eq!(reason_for(&c, "x@example.org", "inbox", false, Some("pass"), ev.as_deref(), false, false), Some("wrote"));
        assert_eq!(reason_for(&c, "y@example.org", "inbox", false, Some("pass"), ev.as_deref(), false, false), None, "not written to");
        assert_eq!(reason_for(&c, "x@example.org", "inbox", false, Some("pass"), None, false, false), None, "no evidence");
        let me = Evidence { dmarc_pass: true, dmarc_from: Some("mine.example".into()), dkim_d: vec![] }.to_db();
        note_written(&c, "a1", "me@mine.example", "");
        assert_eq!(reason_for(&c, "me@mine.example", "inbox", false, Some("pass"), me.as_deref(), false, false), None, "your own address");
    }

    /// 1.0.11 (owner report on 1.0.10: many mails of accounts.google.com and microsoft.com were not shown): the whole way from the RAW header of real providers to the reason, so a format
    /// the parser does not read shows up here and not in a mailbox.
    #[test]
    fn real_provider_headers_end_in_the_reason_of_a_service() {
        let own: (HashSet<String>, HashSet<String>) = (["me@mine.example".to_string()].into_iter().collect(), ["mine.example".to_string()].into_iter().collect());
        let reason_of = |from: &str, headers: &str, list_unsub: bool| {
            let raw = format!("{headers}
From: {from}
Subject: s

body
");
            let ev = crate::authres::evidence(raw.as_bytes()).to_db();
            let auth = crate::authres::verdict(raw.as_bytes()).to_db();
            reason(&Input { from_email: from.rsplit(['<', ' ']).next().unwrap_or(from).trim_end_matches('>'), folder: "inbox", encrypted: false, auth_result: auth, auth_ev: ev.as_deref(), list_hdr: false, list_unsub, written: false, own_addrs: &own.0, own_domains: &own.1 })
        };
        // Gmail, as the owner's example
        let gmail = "Authentication-Results: mx.google.com;
       dkim=pass header.i=@accounts.google.com header.s=20230601 header.b=abc;
       spf=pass (google.com: domain of 3xyz@accounts.google.com designates 209.85.220.69 as permitted sender) smtp.mailfrom=3xyz@accounts.google.com;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=accounts.google.com";
        assert_eq!(reason_of("no-reply@accounts.google.com", gmail, false), Some("service"), "Gmail: folded, DKIM by header.i, DMARC with a comment");
        assert_eq!(reason_of("no-reply@accounts.google.com", gmail, true), Some("service"), "a List-Unsubscribe does not stop a service");
        // Microsoft 365 / Outlook.com
        let m365 = "Authentication-Results: spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=email.microsoft.com; dkim=pass (signature was verified) header.d=microsoft.com;dmarc=pass action=none header.from=microsoft.com;compauth=pass reason=100";
        assert_eq!(reason_of("Microsoft <microsoft@microsoft.com>", m365, false), Some("service"), "Microsoft: no space after the semicolons");
        assert_eq!(reason_of("Microsoft account team <account-security-noreply@accountprotection.microsoft.com>", "Authentication-Results: spf=pass smtp.mailfrom=accountprotection.microsoft.com; dkim=pass header.d=accountprotection.microsoft.com; dmarc=pass action=none header.from=accountprotection.microsoft.com", false), Some("service"), "a subdomain of microsoft.com signing for itself");
        // DKIM only, the signing domain under the service; header.d missing, header.i present
        assert_eq!(reason_of("no-reply@accounts.google.com", "Authentication-Results: mx.example; dkim=pass header.i=@accounts.google.com", false), Some("service"), "header.i alone");
        assert_eq!(reason_of("noreply@github.com", "Authentication-Results: mx.example; dkim=pass header.d=github.com header.i=@github.com; spf=pass", false), Some("service"));
        // upper case everywhere
        assert_eq!(reason_of("no-reply@accounts.google.com", "Authentication-Results: MX.GOOGLE.COM; DKIM=PASS HEADER.D=ACCOUNTS.GOOGLE.COM; DMARC=PASS HEADER.FROM=ACCOUNTS.GOOGLE.COM", false), Some("service"));
        // the result glued to a comment
        assert_eq!(reason_of("no-reply@accounts.google.com", "Authentication-Results: mx.example; dmarc=pass(p=reject) header.from=accounts.google.com", false), Some("service"));
        // two Authentication-Results headers: the topmost counts (the receiving server's own), an older one below is not read
        let two = format!("{m365}
Authentication-Results: mx.old; dkim=pass header.d=evil.example");
        assert_eq!(reason_of("Microsoft <microsoft@microsoft.com>", &two, false), Some("service"));
        let forged_top = "Authentication-Results: mx.forged; dkim=pass header.d=evil.example
Authentication-Results: mx.real; dkim=pass header.d=microsoft.com; dmarc=pass header.from=microsoft.com";
        assert_eq!(reason_of("Microsoft <microsoft@microsoft.com>", forged_top, false), None, "the top header is the one that counts, even when a lower one would pass");
        // ARC is a different header and is not read
        assert_eq!(reason_of("no-reply@accounts.google.com", "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass header.i=@accounts.google.com; dmarc=pass header.from=accounts.google.com", false), None);
        // the From domain is the DMARC domain, and a look-alike is not
        assert_eq!(reason_of("no-reply@accounts.google.com", "Authentication-Results: mx; dmarc=pass header.from=evil.example", false), None);
        assert_eq!(reason_of("no-reply@accounts.google.com.evil.example", gmail, false), None);
    }
}
