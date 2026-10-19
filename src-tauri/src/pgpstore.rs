//! Key store (SQLite), session key cache and the Tauri commands for PGP. Secret keys are stored only in their
//! passphrase-protected form; unlocked copies live in memory (never on disk) and expire.

use crate::db::{err, Account, R};
use crate::openpgp::{self, Algo, KeyInfo, Material, Recipient, Unusable};
use crate::pgpmail::{self, Ctx, LockedKey, Opened};
use crate::smtp::{self, Att, Draft};
use crate::{blocking, lock, now, AppState};
use base64::Engine;
use pgp::composed::{SignedPublicKey, SignedSecretKey};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

/// How long a passphrase entered without "remember" keeps working (long enough to finish sending).
const ONE_SHOT_TTL: Duration = Duration::from_secs(180);
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------------------------
// store

pub struct StoredKey {
    pub info: KeyInfo,
    pub public: SignedPublicKey,
    pub secret: Option<SignedSecretKey>,
    pub verified: bool,
    pub source: String,
    pub emails: Vec<String>,
}

#[derive(Default)]
pub struct Store {
    pub keys: Vec<StoredKey>,
    pub defaults: HashMap<String, String>,
    /// every certificate (for signature checks)
    pub publics: Vec<SignedPublicKey>,
    pub verified: HashSet<String>,
}

static STORE: Mutex<Option<Arc<Store>>> = Mutex::new(None);

fn invalidate() {
    *STORE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

pub fn load_store(c: &Connection) -> R<Arc<Store>> {
    if let Some(s) = STORE.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        return Ok(s.clone());
    }
    let mut st = c
        .prepare("SELECT public_armored, secret_armored, verified, source FROM pgp_keys ORDER BY added_at")
        .map_err(err)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)? != 0, r.get::<_, String>(3)?)))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut store = Store::default();
    for (pubarm, secarm, verified, source) in rows {
        let Ok(public) = openpgp::parse_public(&pubarm) else { continue };
        let secret = secarm.and_then(|s| openpgp::parse_secret(&s).ok());
        let info = openpgp::info(&public, secret.is_some());
        if verified {
            store.verified.insert(info.fingerprint.clone());
        }
        store.publics.push(public.clone());
        let emails = openpgp::emails_of(&info.user_ids);
        store.keys.push(StoredKey { info, public, secret, verified, source, emails });
    }
    let mut st = c.prepare("SELECT account_id, fingerprint FROM pgp_default").map_err(err)?;
    store.defaults = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();
    let arc = Arc::new(store);
    *STORE.lock().unwrap_or_else(|p| p.into_inner()) = Some(arc.clone());
    Ok(arc)
}

impl Store {
    pub fn by_fpr(&self, fpr: &str) -> Option<&StoredKey> {
        self.keys.iter().find(|k| k.info.fingerprint == fpr)
    }

    /// The secret key an account signs with / reads drafts with: its default, else one that carries its address.
    pub fn own_key(&self, acc: &Account) -> Option<&StoredKey> {
        if let Some(f) = self.defaults.get(&acc.id) {
            if let Some(k) = self.by_fpr(f).filter(|k| k.secret.is_some()) {
                return Some(k);
            }
        }
        let email = acc.email.to_lowercase();
        self.keys
            .iter()
            .filter(|k| k.secret.is_some() && !k.info.revoked && k.emails.contains(&email))
            .max_by_key(|k| (!k.info.expired, k.info.created))
    }

    /// Best usable key for an address: verified first, then newest.
    pub fn key_for_email(&self, email: &str) -> (Option<&StoredKey>, Option<Unusable>) {
        let e = email.trim().to_lowercase();
        let mut cands: Vec<&StoredKey> = self.keys.iter().filter(|k| k.emails.contains(&e)).collect();
        cands.sort_by_key(|k| std::cmp::Reverse((k.verified, k.info.created)));
        let mut problem = None;
        for k in cands {
            match openpgp::encryption_key(&k.public, now()) {
                Ok(_) => return (Some(k), None),
                Err(u) => problem = problem.or(Some(u)),
            }
        }
        (None, problem)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// session cache: unlocked secret keys, attempt counters, decrypted views

struct Unlocked {
    key: SignedSecretKey,
    /// `None` = remembered until the app quits
    expires: Option<Instant>,
}

static UNLOCKED: Mutex<Option<HashMap<String, Unlocked>>> = Mutex::new(None);
static ATTEMPTS: Mutex<Option<HashMap<String, (u32, Option<Instant>)>>> = Mutex::new(None);
static VIEWS: Mutex<VecDeque<(String, Arc<Opened>)>> = Mutex::new(VecDeque::new());
const MAX_VIEWS: usize = 64;

fn with_unlocked<T>(f: impl FnOnce(&mut HashMap<String, Unlocked>) -> T) -> T {
    let mut g = UNLOCKED.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let t = Instant::now();
    map.retain(|_, u| u.expires.is_none_or(|e| e > t));
    f(map)
}

pub fn unlocked_keys() -> Vec<SignedSecretKey> {
    with_unlocked(|m| m.values().map(|u| u.key.clone()).collect())
}

fn unlocked_key(fpr: &str) -> Option<SignedSecretKey> {
    with_unlocked(|m| m.get(fpr).map(|u| u.key.clone()))
}

/// (unlocked, remembered until quit)
fn unlock_state(fpr: &str) -> (bool, bool) {
    with_unlocked(|m| m.get(fpr).map(|u| (true, u.expires.is_none())).unwrap_or((false, false)))
}

fn clear_views() {
    VIEWS.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

fn lock_all_now() {
    with_unlocked(|m| m.clear());
    clear_views();
}

fn check_attempts(fpr: &str) -> R<()> {
    let mut g = ATTEMPTS.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if let Some((_, Some(until))) = map.get(fpr) {
        if *until > Instant::now() {
            return Err("PGP_LOCKED_OUT: Too many attempts. Wait 30 seconds.".into());
        }
        map.remove(fpr);
    }
    Ok(())
}

fn record_attempt(fpr: &str, ok: bool) {
    let mut g = ATTEMPTS.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if ok {
        map.remove(fpr);
        return;
    }
    let e = map.entry(fpr.to_string()).or_insert((0, None));
    e.0 += 1;
    if e.0 >= MAX_ATTEMPTS {
        e.1 = Some(Instant::now() + LOCKOUT);
        e.0 = 0;
    }
}

/// Unlock a stored secret key with its passphrase and keep the unlocked copy in memory.
fn unlock_key(store: &Store, fpr: &str, passphrase: &str, remember: bool) -> R<()> {
    check_attempts(fpr)?;
    let k = store.by_fpr(fpr).and_then(|k| k.secret.as_ref()).ok_or("PGP_NO_KEY: That key isn't on this computer.")?;
    match openpgp::unlock_clone(k, passphrase) {
        Ok(open) => {
            record_attempt(fpr, true);
            with_unlocked(|m| {
                m.insert(fpr.to_string(), Unlocked { key: open, expires: if remember { None } else { Some(Instant::now() + ONE_SHOT_TTL) } });
            });
            Ok(())
        }
        Err(e) => {
            record_attempt(fpr, false);
            check_attempts(fpr)?;
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// opening messages

fn label_of(k: &StoredKey) -> String {
    k.emails.first().cloned().or_else(|| k.info.user_ids.first().cloned()).unwrap_or_default()
}

/// The address of the account a stored message belongs to and the addresses it was sent to (To, Cc).
fn mailbox_of(c: &Connection, message_id: &str) -> Option<(String, Vec<String>)> {
    c.query_row(
        "SELECT a.email, m.to_addrs, m.cc_addrs FROM messages m JOIN accounts a ON a.id=m.account_id WHERE m.id=?1",
        [message_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
    )
    .ok()
    .map(|(mailbox, to, cc)| (mailbox, to.split(',').chain(cc.split(',')).map(|a| addr_of(a)).filter(|a| !a.is_empty()).collect()))
}

/// A way to the database that a function can use for a moment: a connection that the caller holds (`Connection`; tests, and callers that
/// already hold the lock for other reasons) or the shared database (`Db`), which is locked for the moment `with` runs and not longer. The
/// functions that decrypt, encrypt or sign take this, so that they can do their slow work with the database free.
pub trait Access {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> T;
}

impl Access for Connection {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(self)
    }
}

impl Access for crate::Db {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&crate::lock(self))
    }
}

/// What opening a message needs from the database.
struct OpenPrep {
    store: Arc<Store>,
    mailbox: Option<(String, Vec<String>)>,
}

/// The opened message of this session, if it was opened (and decrypted) already.
pub fn cached_view(message_id: &str) -> Option<Arc<Opened>> {
    open_cached(message_id)
}

fn open_cached(message_id: &str) -> Option<Arc<Opened>> {
    VIEWS.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(id, _)| id == message_id).map(|v| v.1.clone())
}

fn open_prep(c: &Connection, message_id: &str) -> R<OpenPrep> {
    Ok(OpenPrep { store: load_store(c)?, mailbox: mailbox_of(c, message_id) })
}

/// Open a stored PGP message with the keys currently available. Successful decryptions are cached for the session.
/// The database is used for the key store and the mailbox only; the decryption does not touch it. A caller that has the shared database (`Db`)
/// passes it as it is: the lock is held for those two lookups, not for the decryption (a 20 MB message takes seconds; the folder list waits for
/// the lock on the main thread).
pub fn open_message<A: Access + ?Sized>(a: &A, message_id: &str, raw: &[u8]) -> R<Arc<Opened>> {
    if let Some(v) = open_cached(message_id) {
        return Ok(v);
    }
    let prep = a.with(|c| open_prep(c, message_id))?;
    Ok(open_run(message_id, raw, prep))
}

fn open_run(message_id: &str, raw: &[u8], prep: OpenPrep) -> Arc<Opened> {
    let OpenPrep { store, mailbox } = prep;
    let unlocked = unlocked_keys();
    let have: HashSet<String> = unlocked.iter().map(|k| openpgp::fingerprint(&k.to_public_key())).collect();
    let locked: Vec<LockedKey> = store
        .keys
        .iter()
        .filter(|k| k.secret.is_some() && !have.contains(&k.info.fingerprint))
        .map(|k| LockedKey {
            fingerprint: k.info.fingerprint.clone(),
            key_ids: openpgp::all_key_ids(&k.public),
            label: label_of(k),
            emails: k.emails.iter().map(|e| e.to_ascii_lowercase()).collect(),
        })
        .collect();
    // the unlock prompt names the key of the mailbox the message is in, not whichever key is stored first
    let mut locked = locked;
    if let Some((mailbox, recipients)) = mailbox {
        pgpmail::order_locked(&mut locked, &mailbox, &recipients);
    }
    let ctx = Ctx { unlocked: unlocked.iter().collect(), locked, publics: &store.publics, verified: &store.verified };
    let opened = Arc::new(pgpmail::open(raw, &ctx));
    if opened.plain.is_some() {
        let mut v = VIEWS.lock().unwrap_or_else(|p| p.into_inner());
        v.retain(|(id, _)| id != message_id);
        v.push_back((message_id.to_string(), opened.clone()));
        while v.len() > MAX_VIEWS {
            v.pop_front();
        }
    }
    opened
}

/// Passphrase prompt target for a message that is waiting for a key, if any.
pub fn locked_key_of(opened: &Opened) -> Option<String> {
    opened.security.locked_key.clone()
}

// ---------------------------------------------------------------------------------------------------------------
// sending

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    #[serde(default)]
    pub encrypt: bool,
    #[serde(default)]
    pub sign: bool,
    #[serde(default)]
    pub attach_public_key: bool,
}

fn addr_of(s: &str) -> String {
    let t = s.trim();
    match (t.rfind('<'), t.rfind('>')) {
        (Some(a), Some(b)) if a < b => t[a + 1..b].trim().to_lowercase(),
        _ => t.to_lowercase(),
    }
}

/// Build the final message (signed and/or encrypted). `draft_mode`: for the Drafts folder, encrypt to the
/// account's own key only and never sign (no passphrase needed).
///
/// Two steps, because the second one is slow: `plan_secure` needs the database (the key store) and is quick; `SecurePlan::build` does the
/// work (the MIME, the signature, the encryption, the armor: seconds for a message with big pictures) and needs no database. A caller that
/// shares the database with the rest of the app must not hold its lock during `build`: the commands that wait for the lock (the folder
/// list, run on the main thread) would stop the whole window for as long as the message takes (QA D-025).
pub fn build_secure<A: Access + ?Sized>(a: &A, acc: &Account, d: &Draft, draft_mode: bool) -> R<lettre::Message> {
    a.with(|c| plan_secure(c, acc, d, draft_mode))?.build()
}

/// What `build_secure` found out from the key store: the keys to encrypt to and to sign with, and the draft to build.
pub struct SecurePlan<'a> {
    acc: &'a Account,
    /// the draft as it is built (a copy only when the public key is attached to it)
    d: std::borrow::Cow<'a, Draft>,
    draft_mode: bool,
    encrypt_to: Option<Vec<(SignedPublicKey, bool)>>,
    signer: Option<SignedSecretKey>,
}

/// Test hooks: how long `SecurePlan::build` waits before it starts (milliseconds), to make a slow build whose effect on other commands can be
/// seen, and how many builds have started.
#[cfg(test)]
pub(crate) static BUILD_DELAY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
pub(crate) static BUILDS_STARTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn plan_secure<'a>(c: &Connection, acc: &'a Account, d: &'a Draft, draft_mode: bool) -> R<SecurePlan<'a>> {
    let sec = d.security.clone().unwrap_or_default();
    let store = load_store(c)?;
    let own = store.own_key(acc);
    let no_key = || format!("PGP_NO_KEY: You have no PGP key for {}. Set up encryption in Settings, Encryption (PGP).", acc.email);
    let sign = sec.sign && !draft_mode;
    let mut d2 = std::borrow::Cow::Borrowed(d);
    if sec.attach_public_key && !draft_mode {
        let k = own.ok_or_else(no_key)?;
        let armored = openpgp::armor_public(&k.public)?;
        d2.to_mut().attachments.push(Att {
            filename: "public-key.asc".into(),
            mime: "application/pgp-keys".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(armored.as_bytes()),
        });
    }
    // signing key (unlocked copy)
    let signer: Option<SignedSecretKey> = if sign {
        let k = own.ok_or_else(no_key)?;
        let fpr = k.info.fingerprint.clone();
        match unlocked_key(&fpr) {
            Some(u) => Some(u),
            None if !openpgp::is_protected(k.secret.as_ref().unwrap()) => k.secret.clone(),
            None => return Err(format!("PGP_LOCKED:{fpr}")),
        }
    } else {
        None
    };
    let mut encrypt_to = None;
    if sec.encrypt {
        let own_pub = own.ok_or_else(no_key)?.public.clone();
        let mut certs: Vec<(SignedPublicKey, bool)> = vec![(own_pub, false)];
        if !draft_mode {
            let mut missing: Vec<String> = vec![];
            let mut seen: HashSet<String> = HashSet::new();
            let all = d.to.iter().chain(d.cc.iter()).map(|a| (a, false)).chain(d.bcc.iter().map(|a| (a, true)));
            for (a, hidden) in all {
                let e = addr_of(a);
                if e.is_empty() || !seen.insert(e.clone()) {
                    continue;
                }
                match store.key_for_email(&e).0 {
                    Some(k) => {
                        if !certs.iter().any(|(p, _)| openpgp::fingerprint(p) == k.info.fingerprint) {
                            certs.push((k.public.clone(), hidden));
                        }
                    }
                    None => missing.push(e),
                }
            }
            if !missing.is_empty() {
                return Err(format!("PGP_MISSING_KEYS:{}", missing.join(",")));
            }
        }
        encrypt_to = Some(certs);
    } else if signer.is_none() {
        return Err("PGP_FAILED: nothing to do".into());
    }
    Ok(SecurePlan { acc, d: d2, draft_mode, encrypt_to, signer })
}

impl SecurePlan<'_> {
    /// The slow part: no database, no lock.
    pub fn build(self) -> R<lettre::Message> {
        #[cfg(test)]
        {
            BUILDS_STARTED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let ms = BUILD_DELAY_MS.load(std::sync::atomic::Ordering::SeqCst);
            if ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        }
        let SecurePlan { acc, d, draft_mode, encrypt_to, signer } = self;
        if let Some(certs) = encrypt_to {
            let encrypt_fn = |plain: &[u8]| -> R<String> {
                let recips: Vec<Recipient> = certs.iter().map(|(k, h)| Recipient { key: k, hidden: *h }).collect();
                openpgp::encrypt(plain, &recips, signer.as_ref().map(|s| (s, "")))
            };
            return smtp::build_encrypted(acc, &d, draft_mode, &encrypt_fn);
        }
        let signer = signer.ok_or("PGP_FAILED: nothing to do")?;
        let sign_fn = |data: &[u8]| openpgp::sign_detached(&signer, "", data);
        smtp::build_signed(acc, &d, draft_mode, &sign_fn)
    }
}

/// Key status for the recipient chips in Compose.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnStatus {
    fingerprint: String,
    can_sign: bool,
    can_encrypt: bool,
    unlocked: bool,
    expired: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientStatus {
    address: String,
    /// ok | missing | expired | revoked | signOnly (a stored key that can check signatures but has nothing to encrypt with)
    status: String,
    fingerprint: Option<String>,
    verified: Option<bool>,
    expires: Option<i64>,
}

#[derive(Serialize)]
pub struct RecipientsResult {
    own: Option<OwnStatus>,
    recipients: Vec<RecipientStatus>,
}

#[tauri::command]
pub fn pgp_recipient_status(state: tauri::State<AppState>, account_id: String, addresses: Vec<String>) -> R<RecipientsResult> {
    recipient_status(&lock(&state.db), &account_id, &addresses)
}

fn recipient_status(c: &Connection, account_id: &str, addresses: &[String]) -> R<RecipientsResult> {
    let acc = crate::db::get_account(c, account_id)?;
    let store = load_store(c)?;
    let own = store.own_key(&acc).map(|k| {
        let usable = openpgp::encryption_key(&k.public, now()).is_ok();
        OwnStatus {
            fingerprint: k.info.fingerprint.clone(),
            can_sign: !k.info.expired && !k.info.revoked,
            can_encrypt: usable,
            unlocked: unlock_state(&k.info.fingerprint).0 || k.secret.as_ref().is_some_and(|s| !openpgp::is_protected(s)),
            expired: k.info.expired,
        }
    });
    let recipients = addresses
        .iter()
        .map(|a| {
            let e = addr_of(a);
            let (k, problem) = store.key_for_email(&e);
            match (k, problem) {
                (Some(k), _) => RecipientStatus { address: e, status: "ok".into(), fingerprint: Some(k.info.fingerprint.clone()), verified: Some(k.verified), expires: k.info.expires },
                (None, Some(Unusable::Revoked)) => RecipientStatus { address: e, status: "revoked".into(), fingerprint: None, verified: None, expires: None },
                (None, Some(Unusable::Expired(at))) => RecipientStatus { address: e, status: "expired".into(), fingerprint: None, verified: None, expires: Some(at) },
                (None, Some(Unusable::NoEncryptionKey)) => RecipientStatus { address: e, status: "signOnly".into(), fingerprint: None, verified: None, expires: None },
                (None, _) => RecipientStatus { address: e, status: "missing".into(), fingerprint: None, verified: None, expires: None },
            }
        })
        .collect();
    Ok(RecipientsResult { own, recipients })
}

// ---------------------------------------------------------------------------------------------------------------
// key commands

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PgpKey {
    #[serde(flatten)]
    info: KeyInfo,
    verified: bool,
    source: String,
    passphrase_remembered: bool,
    unlocked: bool,
    default_for: Vec<String>,
    /// secret key is stored passphrase-protected
    protected: bool,
}

fn view(store: &Store, k: &StoredKey) -> PgpKey {
    let (unlocked, remembered) = unlock_state(&k.info.fingerprint);
    PgpKey {
        info: k.info.clone(),
        verified: k.verified,
        source: k.source.clone(),
        passphrase_remembered: remembered,
        unlocked,
        default_for: store.defaults.iter().filter(|(_, f)| **f == k.info.fingerprint).map(|(a, _)| a.clone()).collect(),
        protected: k.secret.as_ref().is_none_or(openpgp::is_protected),
    }
}

fn info_view(info: KeyInfo, protected: bool) -> PgpKey {
    PgpKey { info, verified: false, source: "paste".into(), passphrase_remembered: false, unlocked: false, default_for: vec![], protected }
}

#[tauri::command]
pub fn pgp_list_keys(state: tauri::State<AppState>) -> R<Vec<PgpKey>> {
    let c = lock(&state.db);
    let store = load_store(&c)?;
    Ok(store.keys.iter().map(|k| view(&store, k)).collect())
}

fn save_key(c: &Connection, public: &SignedPublicKey, secret: Option<&SignedSecretKey>, verified: bool, source: &str) -> R<KeyInfo> {
    let info = openpgp::info(public, secret.is_some());
    let existing_secret: Option<String> = c
        .query_row("SELECT secret_armored FROM pgp_keys WHERE fingerprint=?1", [&info.fingerprint], |r| r.get(0))
        .ok()
        .flatten();
    let secret_armored = match secret {
        Some(s) => Some(openpgp::armor_secret(s)?),
        None => existing_secret,
    };
    c.execute(
        "INSERT INTO pgp_keys(fingerprint,key_id,user_ids,emails,algo,created,expires,revoked,public_armored,secret_armored,verified,source,added_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(fingerprint) DO UPDATE SET user_ids=excluded.user_ids, emails=excluded.emails, algo=excluded.algo, created=excluded.created,
           expires=excluded.expires, revoked=excluded.revoked, public_armored=excluded.public_armored, secret_armored=excluded.secret_armored,
           verified=MAX(pgp_keys.verified, excluded.verified)",
        params![
            info.fingerprint,
            info.key_id,
            serde_json::to_string(&info.user_ids).map_err(err)?,
            serde_json::to_string(&openpgp::emails_of(&info.user_ids)).map_err(err)?,
            info.algo,
            info.created,
            info.expires,
            info.revoked as i64,
            openpgp::armor_public(public)?,
            secret_armored,
            verified as i64,
            source,
            now()
        ],
    )
    .map_err(err)?;
    invalidate();
    Ok(info)
}

fn set_default_if_missing(c: &Connection, store_after: &Store, info: &KeyInfo) {
    let emails = openpgp::emails_of(&info.user_ids);
    if let Ok(accounts) = crate::db::list_accounts(c) {
        for a in accounts {
            if emails.contains(&a.email.to_lowercase()) && !store_after.defaults.contains_key(&a.id) {
                let _ = c.execute("INSERT OR IGNORE INTO pgp_default(account_id,fingerprint) VALUES(?1,?2)", params![a.id, info.fingerprint]);
            }
        }
    }
    invalidate();
}

#[tauri::command]
pub async fn pgp_generate_key(
    state: tauri::State<'_, AppState>,
    account_id: String,
    algo: String,
    expires_days: Option<u32>,
    passphrase: String,
    remember: String,
) -> R<PgpKey> {
    let db = state.db.clone();
    blocking(move || {
        if passphrase.chars().count() < 8 {
            return Err("PGP_PASSPHRASE_SHORT: Use at least 8 characters.".into());
        }
        let acc = crate::db::get_account(&lock(&db), &account_id)?;
        let name = if acc.display_name.trim().is_empty() { acc.email.clone() } else { acc.display_name.trim().to_string() };
        let user_id = format!("{name} <{}>", acc.email);
        let sk = openpgp::generate(Algo::parse(&algo)?, &user_id, expires_days, &passphrase)?;
        let pk = sk.to_public_key();
        let c = lock(&db);
        let info = save_key(&c, &pk, Some(&sk), true, "generated")?;
        let store = load_store(&c)?;
        set_default_if_missing(&c, &store, &info);
        if remember != "never" {
            let open = openpgp::unlock_clone(&sk, &passphrase)?;
            with_unlocked(|m| {
                m.insert(info.fingerprint.clone(), Unlocked { key: open, expires: None });
            });
        }
        let store = load_store(&c)?;
        let k = store.by_fpr(&info.fingerprint).ok_or("key was not saved")?;
        Ok(view(&store, k))
    })
    .await
}

const MAX_KEY_FILE: u64 = 4_000_000;

fn read_key_input(armored: Option<String>, path: Option<String>) -> R<Vec<u8>> {
    if let Some(p) = path {
        let meta = std::fs::metadata(&p).map_err(|e| crate::i18n::coded("PGP_FILE_UNREADABLE", &[("detail", &e.to_string())], &format!("Couldn't read that file: {e}")))?;
        if meta.len() > MAX_KEY_FILE {
            return Err("PGP_FILE_TOO_LARGE: That file is too large to be an OpenPGP key.".into());
        }
        return std::fs::read(&p).map_err(|e| crate::i18n::coded("PGP_FILE_UNREADABLE", &[("detail", &e.to_string())], &format!("Couldn't read that file: {e}")));
    }
    let a = armored.unwrap_or_default();
    if a.trim().is_empty() {
        return Err("PGP_NOTHING_TO_IMPORT: Paste an armored key or choose a file.".into());
    }
    Ok(a.into_bytes())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    keys: Vec<PgpKey>,
    is_secret: bool,
    /// a secret key without a passphrase: one must be chosen on import
    needs_new_passphrase: bool,
    already_known: Vec<String>,
}

#[tauri::command]
pub fn pgp_inspect_key(state: tauri::State<AppState>, armored: Option<String>, path: Option<String>) -> R<InspectResult> {
    let data = read_key_input(armored, path)?;
    let mats = openpgp::parse_material(&data)?;
    let c = lock(&state.db);
    let store = load_store(&c)?;
    let mut keys = vec![];
    let (mut is_secret, mut needs) = (false, false);
    let mut known = vec![];
    for m in &mats {
        let pk = m.public();
        let info = openpgp::info(&pk, m.is_secret());
        if store.by_fpr(&info.fingerprint).is_some() {
            known.push(info.fingerprint.clone());
        }
        let mut protected = true;
        if let Material::Secret(s) = m {
            is_secret = true;
            protected = openpgp::is_protected(s);
            needs |= !protected;
        }
        keys.push(info_view(info, protected));
    }
    Ok(InspectResult { keys, is_secret, needs_new_passphrase: needs, already_known: known })
}

fn import_materials(c: &Connection, mats: Vec<Material>, passphrase: &str, verified: bool, source: &str) -> R<Vec<String>> {
    let mut done = vec![];
    for m in mats {
        match m {
            Material::Public(pk) => {
                done.push(save_key(c, &pk, None, verified, source)?.fingerprint);
            }
            Material::Secret(mut sk) => {
                if openpgp::is_protected(&sk) {
                    // must be the right passphrase; the key is stored exactly as it came
                    openpgp::unlock_clone(&sk, passphrase).map_err(|_| "PGP_BAD_PASSPHRASE: Wrong passphrase for this secret key.".to_string())?;
                } else {
                    if passphrase.chars().count() < 8 {
                        return Err("PGP_NEEDS_PASSPHRASE: This secret key has no passphrase. Choose one (at least 8 characters) to store it safely.".into());
                    }
                    openpgp::lock_with(&mut sk, passphrase)?;
                }
                let pk = sk.to_public_key();
                done.push(save_key(c, &pk, Some(&sk), true, source)?.fingerprint);
            }
        }
    }
    let store = load_store(c)?;
    for f in &done {
        if let Some(k) = store.by_fpr(f) {
            if k.secret.is_some() {
                set_default_if_missing(c, &store, &k.info);
            }
        }
    }
    Ok(done)
}

#[tauri::command]
pub fn pgp_import_key(state: tauri::State<AppState>, armored: Option<String>, path: Option<String>, passphrase: Option<String>, verified: bool) -> R<Vec<PgpKey>> {
    let source = if path.is_some() { "file" } else { "paste" };
    let data = read_key_input(armored, path)?;
    let mats = openpgp::parse_material(&data)?;
    let c = lock(&state.db);
    let fprs = import_materials(&c, mats, passphrase.as_deref().unwrap_or(""), verified, source)?;
    let store = load_store(&c)?;
    Ok(fprs.iter().filter_map(|f| store.by_fpr(f)).map(|k| view(&store, k)).collect())
}

#[tauri::command]
pub async fn pgp_import_from_message(state: tauri::State<'_, AppState>, message_id: String, index: usize) -> R<Vec<PgpKey>> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, _) = crate::fetch_view_for(&db, &message_id)?;
        let (_, bytes) = crate::mail::attachment_bytes(&raw, index)?;
        let mats = openpgp::parse_material(&bytes)?;
        if mats.iter().any(|m| m.is_secret()) {
            return Err("PGP_ATT_SECRET_KEY: This attachment contains a secret key. Import it from Settings, Encryption (PGP).".into());
        }
        let c = lock(&db);
        let fprs = import_materials(&c, mats, "", false, "email")?;
        let store = load_store(&c)?;
        Ok(fprs.iter().filter_map(|f| store.by_fpr(f)).map(|k| view(&store, k)).collect())
    })
    .await
}

#[tauri::command]
pub async fn pgp_pick_key_file(app: tauri::AppHandle) -> R<Option<String>> {
    blocking(move || {
        let p = app.dialog().file().set_title(crate::i18n::tr(crate::i18n::K::ChooseKeyFile)).add_filter(crate::i18n::tr(crate::i18n::K::OpenPgpKeys), &["asc", "gpg", "pgp", "key", "txt"]).blocking_pick_file();
        match p {
            Some(f) => Ok(Some(f.into_path().map_err(err)?.to_string_lossy().into_owned())),
            None => Ok(None),
        }
    })
    .await
}

fn safe_file_stem(k: &StoredKey) -> String {
    let base = k.emails.first().cloned().unwrap_or_else(|| k.info.key_id.clone());
    base.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '@' { c } else { '_' }).collect()
}

#[tauri::command]
pub fn pgp_public_armored(state: tauri::State<AppState>, fingerprint: String) -> R<String> {
    let c = lock(&state.db);
    let store = load_store(&c)?;
    openpgp::armor_public(&store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?.public)
}

#[tauri::command]
pub async fn pgp_export_public(app: tauri::AppHandle, state: tauri::State<'_, AppState>, fingerprint: String) -> R<Option<String>> {
    let db = state.db.clone();
    blocking(move || {
        let (armored, name) = {
            let c = lock(&db);
            let store = load_store(&c)?;
            let k = store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?;
            (openpgp::armor_public(&k.public)?, format!("{}-public-key.asc", safe_file_stem(k)))
        };
        save_text(&app, &name, crate::i18n::tr(crate::i18n::K::SavePublicKey), &armored)
    })
    .await
}

fn save_text(app: &tauri::AppHandle, name: &str, title: &str, text: &str) -> R<Option<String>> {
    let Some(p) = app.dialog().file().set_title(title).set_file_name(name).blocking_save_file() else {
        return Ok(None);
    };
    let path = p.into_path().map_err(err)?;
    std::fs::write(&path, text).map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Backup: the passphrase-protected secret key. When a passphrase is given it is checked first.
#[tauri::command]
pub async fn pgp_export_secret(app: tauri::AppHandle, state: tauri::State<'_, AppState>, fingerprint: String, passphrase: Option<String>) -> R<Option<String>> {
    let db = state.db.clone();
    blocking(move || {
        let (armored, name) = {
            let c = lock(&db);
            let store = load_store(&c)?;
            let k = store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?;
            let s = k.secret.as_ref().ok_or("PGP_NO_SECRET_PART: This key has no secret part on this computer.")?;
            if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
                check_attempts(&fingerprint)?;
                openpgp::unlock_clone(s, &p).inspect_err(|_| record_attempt(&fingerprint, false))?;
                record_attempt(&fingerprint, true);
            }
            (openpgp::armor_secret(s)?, format!("{}-secret-key-BACKUP.asc", safe_file_stem(k)))
        };
        save_text(&app, &name, crate::i18n::tr(crate::i18n::K::SaveKeyBackup), &armored)
    })
    .await
}

#[tauri::command]
pub fn pgp_delete_key(state: tauri::State<AppState>, fingerprint: String, include_secret: bool) -> R<()> {
    let c = lock(&state.db);
    let has_secret: Option<String> = c.query_row("SELECT secret_armored FROM pgp_keys WHERE fingerprint=?1", [&fingerprint], |r| r.get(0)).map_err(|_| "PGP_KEY_NOT_FOUND: Key not found.".to_string())?;
    if has_secret.is_some() && !include_secret {
        c.execute("UPDATE pgp_keys SET secret_armored=NULL WHERE fingerprint=?1", [&fingerprint]).map_err(err)?;
    } else {
        c.execute("DELETE FROM pgp_keys WHERE fingerprint=?1", [&fingerprint]).map_err(err)?;
    }
    c.execute("DELETE FROM pgp_default WHERE fingerprint=?1 AND NOT EXISTS (SELECT 1 FROM pgp_keys k WHERE k.fingerprint=?1 AND k.secret_armored IS NOT NULL)", [&fingerprint]).map_err(err)?;
    with_unlocked(|m| {
        m.remove(&fingerprint);
    });
    clear_views();
    invalidate();
    Ok(())
}

#[tauri::command]
pub fn pgp_set_verified(state: tauri::State<AppState>, fingerprint: String, verified: bool) -> R<()> {
    lock(&state.db).execute("UPDATE pgp_keys SET verified=?2 WHERE fingerprint=?1", params![fingerprint, verified as i64]).map_err(err)?;
    clear_views();
    invalidate();
    Ok(())
}

#[tauri::command]
pub fn pgp_set_default(state: tauri::State<AppState>, account_id: String, fingerprint: Option<String>) -> R<()> {
    let c = lock(&state.db);
    // the account has to exist (a default for an unknown account would never be used)
    crate::db::get_account(&c, &account_id)?;
    match fingerprint {
        Some(f) => {
            let store = load_store(&c)?;
            if store.by_fpr(&f).is_none_or(|k| k.secret.is_none()) {
                return Err("PGP_NOT_OWN_KEY: Choose one of your own keys.".into());
            }
            c.execute("INSERT INTO pgp_default(account_id,fingerprint) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET fingerprint=excluded.fingerprint", params![account_id, f]).map_err(err)?;
        }
        None => {
            c.execute("DELETE FROM pgp_default WHERE account_id=?1", [&account_id]).map_err(err)?;
        }
    }
    invalidate();
    Ok(())
}

#[tauri::command]
pub async fn pgp_change_passphrase(state: tauri::State<'_, AppState>, fingerprint: String, old_passphrase: String, new_passphrase: String) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        if new_passphrase.chars().count() < 8 {
            return Err("PGP_PASSPHRASE_SHORT: Use at least 8 characters.".into());
        }
        // the slow key derivation runs without the database lock, so other commands keep working
        let store = load_store(&lock(&db))?;
        let k = store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?;
        let s = k.secret.as_ref().ok_or("PGP_NO_SECRET_PART: This key has no secret part on this computer.")?;
        check_attempts(&fingerprint)?;
        let changed = openpgp::change_passphrase(s, &old_passphrase, &new_passphrase).inspect_err(|_| record_attempt(&fingerprint, false))?;
        record_attempt(&fingerprint, true);
        let c = lock(&db);
        c.execute("UPDATE pgp_keys SET secret_armored=?2 WHERE fingerprint=?1", params![fingerprint, openpgp::armor_secret(&changed)?]).map_err(err)?;
        with_unlocked(|m| {
            m.remove(&fingerprint);
        });
        invalidate();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pgp_set_expiry(state: tauri::State<'_, AppState>, fingerprint: String, passphrase: String, expires_days: Option<u32>) -> R<PgpKey> {
    let db = state.db.clone();
    blocking(move || {
        let store = load_store(&lock(&db))?;
        let k = store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?;
        let mut s = k.secret.clone().ok_or("PGP_EXTEND_OWN_ONLY: Only your own keys can be extended.")?;
        check_attempts(&fingerprint)?;
        openpgp::unlock_clone(&s, &passphrase).inspect_err(|_| record_attempt(&fingerprint, false))?;
        record_attempt(&fingerprint, true);
        openpgp::set_expiry(&mut s, &passphrase, expires_days)?;
        let pk = s.to_public_key();
        let c = lock(&db);
        save_key(&c, &pk, Some(&s), k.verified, &k.source.clone())?;
        clear_views();
        let store = load_store(&c)?;
        Ok(view(&store, store.by_fpr(&fingerprint).ok_or("PGP_KEY_NOT_FOUND: Key not found.")?))
    })
    .await
}

#[tauri::command]
pub async fn pgp_unlock(state: tauri::State<'_, AppState>, fingerprint: String, passphrase: String, remember: bool) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        let store = load_store(&lock(&db))?;
        unlock_key(&store, &fingerprint, &passphrase, remember)
    })
    .await
}

#[tauri::command]
pub fn pgp_lock_all() {
    lock_all_now();
}

/// Decrypt one message, unlocking its key first when a passphrase is given. Returns the message as shown (`light`: without its body, see `get_thread`).
#[tauri::command]
pub async fn pgp_decrypt_message(state: tauri::State<'_, AppState>, message_id: String, passphrase: Option<String>, remember: Option<bool>, light: Option<bool>) -> R<crate::MessageFull> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, _) = crate::fetch_raw_for(&db, &message_id)?;
        if let Some(p) = passphrase.filter(|p| !p.is_empty()) {
            let locked = {
                let opened = open_message(&db, &message_id, &raw)?;
                match locked_key_of(&opened) {
                    Some(f) => Some((f, load_store(&lock(&db))?)),
                    None => None,
                }
            };
            // the slow key derivation runs without the database lock
            if let Some((f, store)) = locked {
                unlock_key(&store, &f, &p, remember.unwrap_or(false))?;
            }
        }
        // (the message is decrypted without the database lock: it can take seconds)
        crate::message_full_in(&db, &message_id, light.unwrap_or(false))
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// schedule-time building (decision 3): the final MIME is made now and stored, so no key is needed later

/// Replace a draft that has been encrypted by a content-free shell around the finished message.
pub fn seal_for_outbox<A: Access + ?Sized>(a: &A, acc: &Account, d: &Draft) -> R<Draft> {
    let sec = d.security.clone().unwrap_or_default();
    if !(sec.encrypt || sec.sign) {
        return Ok(d.clone());
    }
    let msg = a.with(|c| plan_secure(c, acc, d, false))?.build()?;
    let mut out = d.clone();
    out.prebuilt = Some(base64::engine::general_purpose::STANDARD.encode(crate::smtp::wire(&msg)));
    if sec.encrypt {
        // never keep the plaintext next to the ciphertext
        out.html = String::new();
        out.text = "Encrypted message".into();
        out.attachments.clear();
        out.inline.clear();
        // the invitation text holds the message text: keep only the event id (to remove the event if this is cancelled)
        if let Some(c) = out.calendar.as_mut() {
            let uid = crate::ical::parse(&c.ics).ok().and_then(|p| p.events.first().map(|e| e.uid.clone())).unwrap_or_default();
            c.ics = format!("UID:{uid}");
        }
    }
    Ok(out)
}

/// Recover a sealed (encrypted) scheduled message as an editable draft, using the account's key.
pub fn unseal_from_outbox<A: Access + ?Sized>(a: &A, acc: &Account, d: &Draft) -> R<Draft> {
    let Some(pre) = &d.prebuilt else { return Ok(d.clone()) };
    let sec = d.security.clone().unwrap_or_default();
    let mut out = d.clone();
    out.prebuilt = None;
    if !sec.encrypt {
        return Ok(out);
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(pre).map_err(err)?;
    let store = a.with(load_store)?;
    let own = store.own_key(acc).ok_or_else(|| crate::i18n::coded("PGP_NO_KEY", &[("email", &acc.email)], &format!("You have no PGP key for {}.", acc.email)))?;
    if unlocked_key(&own.info.fingerprint).is_none() && own.secret.as_ref().is_some_and(openpgp::is_protected) {
        return Err(format!("PGP_LOCKED:{}", own.info.fingerprint));
    }
    let opened = open_message(a, &format!("outbox:{}", pgpstore_hash(&raw)), &raw)?;
    let plain = opened.plain.as_ref().ok_or("PGP_UNREADABLE: Couldn't read the encrypted message.")?;
    let parsed = crate::mail::parse(0, plain, true, false, 0).ok_or("PGP_UNREADABLE: Couldn't read the encrypted message.")?;
    out.html = parsed.html.unwrap_or_default();
    out.text = parsed.text.unwrap_or_default();
    // attachments and inline pictures come back from the decrypted copy
    out.attachments.clear();
    out.inline.clear();
    for m in &parsed.attachments {
        let (name, bytes) = crate::mail::attachment_bytes(plain, m.index)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        if m.inline && m.referenced {
            if let Some(cid) = &m.cid {
                out.inline.push(smtp::InlineImage { cid: cid.clone(), filename: name, mime: m.mime.clone(), data_base64: b64 });
                continue;
            }
        }
        if m.mime == "application/pgp-keys" && name == "public-key.asc" {
            continue; // re-added on send
        }
        out.attachments.push(Att { filename: name, mime: m.mime.clone(), data_base64: b64 });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c
    }

    fn account(id: &str, email: &str) -> Account {
        Account {
            id: id.into(),
            email: email.into(),
            display_name: "Me".into(),
            imap_host: "h".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "h".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: email.into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
            reply_to: String::new(),
        }
    }

    fn draft(acc: &Account, to: &[&str], bcc: &[&str], enc: bool, sign: bool) -> Draft {
        Draft {
            account_id: acc.id.clone(),
            to: to.iter().map(|s| s.to_string()).collect(),
            cc: vec![],
            bcc: bcc.iter().map(|s| s.to_string()).collect(),
            subject: "Plan".into(),
            html: "<p>the secret plan</p>".into(),
            text: "the secret plan".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            inline: vec![],
            security: Some(Security { encrypt: enc, sign, attach_public_key: false }),
            prebuilt: None,
            meeting: None,
            calendar: None,
            confidential: false,
            importance: Default::default(),
            recovery_id: None,
            meeting_form: None, answers: None,
        }
    }

    /// serialises tests that use the process-wide key cache
    static GUARD: Mutex<()> = Mutex::new(());

    fn setup() -> (Connection, Account, std::sync::MutexGuard<'static, ()>) {
        let g = GUARD.lock().unwrap_or_else(|p| p.into_inner());
        lock_all_now();
        invalidate();
        let c = db();
        let acc = account("a1", "me@example.com");
        crate::db::insert_account(&c, &acc).unwrap();
        (c, acc, g)
    }

    fn add_own(c: &Connection, email: &str, pw: &str) -> String {
        let sk = openpgp::generate(Algo::Cv25519, &format!("Me <{email}>"), None, pw).unwrap();
        let info = save_key(c, &sk.to_public_key(), Some(&sk), true, "generated").unwrap();
        let store = load_store(c).unwrap();
        set_default_if_missing(c, &store, &info);
        info.fingerprint
    }

    fn add_contact(c: &Connection, email: &str) -> (SignedSecretKey, String) {
        let sk = openpgp::generate(Algo::Cv25519, &format!("Bob <{email}>"), None, "bob-pass-1234").unwrap();
        let open = openpgp::unlock_clone(&sk, "bob-pass-1234").unwrap();
        let info = save_key(c, &sk.to_public_key(), None, false, "paste").unwrap();
        (open, info.fingerprint)
    }

    #[test]
    fn key_store_roundtrip_defaults_and_lookup() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        let store = load_store(&c).unwrap();
        assert_eq!(store.defaults.get("a1"), Some(&fpr), "own key becomes the account default");
        assert_eq!(store.own_key(&acc).unwrap().info.fingerprint, fpr);
        let (_, bob_fpr) = add_contact(&c, "bob@example.com");
        let store = load_store(&c).unwrap();
        assert_eq!(store.key_for_email("BOB@example.com").0.unwrap().info.fingerprint, bob_fpr);
        assert!(store.key_for_email("nobody@example.com").0.is_none());
        assert!(store.by_fpr(&bob_fpr).unwrap().secret.is_none());
        // the stored secret key is passphrase protected
        let secret_armored: String = c.query_row("SELECT secret_armored FROM pgp_keys WHERE fingerprint=?1", [&fpr], |r| r.get(0)).unwrap();
        assert!(openpgp::is_protected(&openpgp::parse_secret(&secret_armored).unwrap()));
    }

    #[test]
    fn missing_keys_are_reported_before_anything_is_built() {
        let (c, acc, _g) = setup();
        add_own(&c, "me@example.com", "my-pass-1234");
        add_contact(&c, "bob@example.com");
        let e = build_secure(&c, &acc, &draft(&acc, &["bob@example.com", "carol@example.com"], &["dave@example.com"], true, false), false).unwrap_err();
        assert_eq!(e, "PGP_MISSING_KEYS:carol@example.com,dave@example.com");
        assert!(build_secure(&c, &acc, &draft(&acc, &["bob@example.com"], &[], true, false), false).is_ok());
    }

    #[test]
    fn no_own_key_is_a_clear_error() {
        let (c, acc, _g) = setup();
        let e = build_secure(&c, &acc, &draft(&acc, &["bob@example.com"], &[], true, false), false).unwrap_err();
        assert!(e.starts_with("PGP_NO_KEY"), "{e}");
    }

    #[test]
    fn signing_needs_the_unlocked_key_and_limits_attempts() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        let d = draft(&acc, &["bob@example.com"], &[], false, true);
        assert_eq!(build_secure(&c, &acc, &d, false).unwrap_err(), format!("PGP_LOCKED:{fpr}"));
        let store = load_store(&c).unwrap();
        for _ in 0..4 {
            assert!(unlock_key(&store, &fpr, "wrong", false).unwrap_err().starts_with("PGP_BAD_PASSPHRASE"));
        }
        // the fifth failure locks the key out, even for the right passphrase
        assert!(unlock_key(&store, &fpr, "wrong", false).unwrap_err().starts_with("PGP_LOCKED_OUT"));
        assert!(unlock_key(&store, &fpr, "my-pass-1234", false).unwrap_err().starts_with("PGP_LOCKED_OUT"));
        ATTEMPTS.lock().unwrap().as_mut().unwrap().clear();
        unlock_key(&store, &fpr, "my-pass-1234", false).unwrap();
        assert_eq!(unlock_state(&fpr), (true, false));
        let msg = build_secure(&c, &acc, &d, false).unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(raw.contains("multipart/signed"), "{raw}");
        assert!(raw.contains("protocol=\"application/pgp-signature\""));
        assert!(raw.contains("micalg=\"pgp-sha256\"") || raw.contains("micalg=pgp-sha256"));
        assert!(raw.contains("BEGIN PGP SIGNATURE"));
        lock_all_now();
        assert_eq!(unlock_state(&fpr), (false, false));
        unlock_key(&store, &fpr, "my-pass-1234", true).unwrap();
        assert_eq!(unlock_state(&fpr), (true, true), "remembered until quit");
    }

    #[test]
    fn signed_message_verifies_on_the_other_side() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        unlock_key(&load_store(&c).unwrap(), &fpr, "my-pass-1234", false).unwrap();
        let msg = build_secure(&c, &acc, &draft(&acc, &["bob@example.com"], &[], false, true), false).unwrap();
        let raw = msg.formatted();
        let store = load_store(&c).unwrap();
        let verified = HashSet::new();
        let ctx = Ctx { unlocked: vec![], locked: vec![], publics: &store.publics, verified: &verified };
        let o = pgpmail::open(&raw, &ctx);
        let s = o.security.signature.expect("signature found");
        assert_eq!(s.status, "valid", "{raw:?}");
        // a single changed byte in the signed part breaks it
        let tampered = String::from_utf8(raw).unwrap().replacen("the secret plan", "the secret plam", 1);
        let o = pgpmail::open(tampered.as_bytes(), &ctx);
        assert_eq!(o.security.signature.unwrap().status, "invalid");
    }

    #[test]
    fn encrypted_message_is_readable_by_recipient_bcc_and_sender_only() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        let store0 = load_store(&c).unwrap();
        unlock_key(&store0, &fpr, "my-pass-1234", false).unwrap();
        let (bob, _) = add_contact(&c, "bob@example.com");
        let (dave, _) = add_contact(&c, "dave@example.com");
        let (eve, _) = {
            let sk = openpgp::generate(Algo::Cv25519, "Eve <eve@example.com>", None, "eve-pass-1234").unwrap();
            (openpgp::unlock_clone(&sk, "eve-pass-1234").unwrap(), ())
        };
        let mut d = draft(&acc, &["bob@example.com"], &["dave@example.com"], true, true);
        d.attachments.push(Att { filename: "plan.txt".into(), mime: "text/plain".into(), data_base64: "aGVsbG8=".into() });
        let msg = build_secure(&c, &acc, &d, false).unwrap();
        let raw = msg.formatted();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.contains("multipart/encrypted"));
        assert!(text.contains("protocol=\"application/pgp-encrypted\""));
        assert!(text.contains("Version: 1"));
        assert!(text.contains("BEGIN PGP MESSAGE"));
        assert!(!text.contains("secret plan"), "no plaintext on the wire");
        assert!(!text.contains("dave@example.com"), "Bcc is not revealed: {text}");
        assert!(!text.contains("plan.txt"));
        assert!(text.contains("Subject: Plan"), "subject stays visible");
        let store = load_store(&c).unwrap();
        let verified = HashSet::new();
        let own = unlocked_keys();
        for (who, key) in [("bob", &bob), ("dave (bcc)", &dave), ("me (sent copy)", &own[0])] {
            let ctx = Ctx { unlocked: vec![key], locked: vec![], publics: &store.publics, verified: &verified };
            let o = pgpmail::open(&raw, &ctx);
            assert_eq!(o.security.decryption, "ok", "{who}: {:?}", o.security);
            assert_eq!(o.security.signature.as_ref().map(|s| s.status.as_str()), Some("valid"), "{who}");
            let p = crate::mail::parse(1, o.plain.as_ref().unwrap(), true, false, 0).unwrap();
            assert!(p.text.unwrap().contains("the secret plan"));
            assert_eq!(p.attachments.len(), 1);
        }
        let ctx = Ctx { unlocked: vec![&eve], locked: vec![], publics: &store.publics, verified: &verified };
        assert_eq!(pgpmail::open(&raw, &ctx).security.decryption, "no_key");
    }

    #[test]
    fn encrypted_invitation_keeps_its_calendar_part_inside_the_encryption() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        let store0 = load_store(&c).unwrap();
        unlock_key(&store0, &fpr, "my-pass-1234", false).unwrap();
        let (bob, _) = add_contact(&c, "bob@example.com");
        let ev = crate::ical::IcsEvent {
            uid: "enc-1@heylook".into(),
            summary: "Secret review".into(),
            start: 1_792_000_000,
            end: 1_792_003_600,
            status: "confirmed".into(),
            organizer: Some(crate::ical::Person { email: "me@example.com".into(), name: None }),
            ..Default::default()
        };
        let mut d = draft(&acc, &["bob@example.com"], &[], true, false);
        d.calendar = Some(crate::smtp::CalendarPart { method: "REQUEST".into(), ics: crate::ical::to_ics(Some("REQUEST"), &[ev]) });
        let raw = build_secure(&c, &acc, &d, false).unwrap().formatted();
        let wire = String::from_utf8_lossy(&raw).to_string();
        assert!(wire.contains("multipart/encrypted") && !wire.contains("Secret review") && !wire.to_lowercase().contains("text/calendar"), "the invitation is not visible on the wire");
        // the stored message carries no calendar text (nothing is readable without the key) ...
        let at_sync = crate::mail::parse(1, &raw, false, false, 0).unwrap();
        assert!(at_sync.ics.is_none());
        // ... and the decrypted content yields it for the invite card
        let store = load_store(&c).unwrap();
        let verified = HashSet::new();
        let ctx = Ctx { unlocked: vec![&bob], locked: vec![], publics: &store.publics, verified: &verified };
        let o = pgpmail::open(&raw, &ctx);
        assert_eq!(o.security.decryption, "ok");
        let p = crate::mail::parse(0, o.plain.as_ref().unwrap(), true, false, 0).unwrap();
        assert_eq!(p.cal_method.as_deref(), Some("request"));
        assert_eq!(crate::ical::parse(p.ics.as_deref().unwrap()).unwrap().events[0].summary, "Secret review");
    }

    #[test]
    fn drafts_are_encrypted_to_self_without_any_passphrase() {
        let (c, acc, _g) = setup();
        add_own(&c, "me@example.com", "my-pass-1234");
        let d = draft(&acc, &["unknown@example.com"], &[], true, true);
        let msg = build_secure(&c, &acc, &d, true).expect("draft mode ignores missing recipient keys and signing");
        let text = String::from_utf8(msg.formatted()).unwrap();
        assert!(text.contains("BEGIN PGP MESSAGE") && !text.contains("secret plan"));
        assert!(!text.contains("BEGIN PGP SIGNATURE"));
    }

    // ---- 1.0.7 W2.4: whom is a stored draft encrypted to? (investigation, then the permanent tests)

    /// The armored PGP message inside a multipart/encrypted draft.
    fn pgp_block(raw: &[u8]) -> Vec<u8> {
        let t = String::from_utf8_lossy(raw);
        let a = t.find("-----BEGIN PGP MESSAGE-----").expect("an encrypted draft has a PGP message");
        let end = "-----END PGP MESSAGE-----";
        let b = t.find(end).expect("end of the PGP message") + end.len();
        t[a..b].as_bytes().to_vec()
    }

    fn share(c: Connection) -> crate::Db {
        Arc::new(Mutex::new(c))
    }

    /// The key ids of the encryption keys of a stored certificate (its subkeys; the primary key of a Cv25519 key only signs).
    fn subkey_ids(db: &crate::Db, fpr: &str) -> Vec<String> {
        let store = load_store(&lock(db)).unwrap();
        openpgp::all_key_ids(&store.by_fpr(fpr).unwrap().public)[1..].to_vec()
    }

    /// Step 1: a draft with Encrypt on, one recipient without a key (ann) and one with (bob): what the APPEND carries is encrypted to the account's own
    /// key and to nobody else, whatever the recipients; the strip's "no public key for ann" is about sending.
    #[test]
    fn an_encrypted_draft_is_for_the_own_key_only() {
        crate::test_guard::within(60, || {
            let (c, acc, _g) = setup();
            let own = add_own(&c, "me@example.com", "my-pass-1234");
            let (_, bob) = add_contact(&c, "bob@example.com");
            let db = share(c);
            let d = draft(&acc, &["ann@example.com", "bob@example.com"], &["carl@example.com"], true, false);
            // the recipient status the strip is built from: ann has no key, bob has one
            let store = load_store(&lock(&db)).unwrap();
            assert!(store.key_for_email("ann@example.com").0.is_none());
            assert!(store.key_for_email("bob@example.com").0.is_some());
            // what Save draft / the autosave / the quit save append: the bytes `save_draft_on` puts into Drafts
            let fake = crate::fakeimap::Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
            crate::db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","drafts":"Drafts"}"#).unwrap();
            let raw = crate::draft_bytes(&db, &acc, &d).unwrap();
            let mut s = fake.connect();
            crate::save_draft_on(&db, &acc, &mut s, &raw, None).unwrap();
            let _ = s.logout();
            let appended = fake.state.lock().unwrap().appended.clone();
            assert_eq!(appended.len(), 1);
            let wire = String::from_utf8_lossy(&appended[0].1).to_string();
            assert!(wire.contains("multipart/encrypted") && wire.contains("BEGIN PGP MESSAGE") && !wire.contains("secret plan"), "{wire}");
            let ids = openpgp::encrypted_for(&pgp_block(&appended[0].1)).unwrap();
            assert_eq!(ids, subkey_ids(&db, &own), "exactly the own encryption subkey, no recipient: {ids:?}");
            assert!(!ids.iter().any(|i| subkey_ids(&db, &bob).contains(i)), "bob's key is not in the draft");
            // the Bcc recipient is in the headers of a draft (it is the person's own copy) but never in the encryption
            assert!(!wire.contains("secret plan"));
        });
    }

    /// D-025 (Mac QA, 329b41b): the encode of a big encrypted draft ran with the database locked, and the folder list (a command that runs on the main
    /// thread) waited for the lock: the whole app stopped. A slow encode (a delay is injected) and the append to the server run while the commands
    /// that need the database answer at once; so do the commands that seal, open and edit a scheduled message.
    #[test]
    fn a_slow_draft_encode_does_not_block_the_commands_that_need_the_database() {
        crate::test_guard::within(60, || {
            let (c, acc, _g) = setup();
            add_own(&c, "me@example.com", "my-pass-1234");
            add_contact(&c, "bob@example.com");
            let db = share(c);
            let fake = crate::fakeimap::Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
            crate::db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","drafts":"Drafts"}"#).unwrap();
            let d = draft(&acc, &["bob@example.com"], &[], true, false);
            let started = BUILDS_STARTED.load(std::sync::atomic::Ordering::SeqCst);
            BUILD_DELAY_MS.store(900, std::sync::atomic::Ordering::SeqCst);
            std::thread::scope(|sc| {
                let saver = sc.spawn(|| {
                    let raw = crate::draft_bytes(&db, &acc, &d).unwrap();
                    let mut s = fake.connect();
                    crate::save_draft_on(&db, &acc, &mut s, &raw, None).unwrap();
                    let _ = s.logout();
                });
                // the encode is running (it is waiting inside the build, where the lock used to be held)
                while BUILDS_STARTED.load(std::sync::atomic::Ordering::SeqCst) == started {
                    std::thread::sleep(Duration::from_millis(5));
                }
                let t0 = Instant::now();
                let folders = crate::folder_infos(&lock(&db)).unwrap();
                let accounts = crate::db::list_accounts(&lock(&db)).unwrap();
                let took = t0.elapsed();
                assert!(!folders.is_empty() && accounts.len() == 1);
                assert!(!saver.is_finished(), "the save was still running while the folder list was read");
                assert!(took < Duration::from_millis(450), "the folder list waited {took:?} for the save");
                BUILD_DELAY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
                saver.join().unwrap();
            });
            BUILD_DELAY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(fake.state.lock().unwrap().appended.len(), 1);
            // the same for sealing a message that is scheduled (another thread's lock use is the folder list again)
            BUILD_DELAY_MS.store(700, std::sync::atomic::Ordering::SeqCst);
            let started = BUILDS_STARTED.load(std::sync::atomic::Ordering::SeqCst);
            std::thread::scope(|sc| {
                let sealer = sc.spawn(|| seal_for_outbox(&db, &acc, &draft(&acc, &["bob@example.com"], &[], true, false)));
                while BUILDS_STARTED.load(std::sync::atomic::Ordering::SeqCst) == started {
                    std::thread::sleep(Duration::from_millis(5));
                }
                let t0 = Instant::now();
                let _ = crate::folder_infos(&lock(&db)).unwrap();
                assert!(t0.elapsed() < Duration::from_millis(350), "the folder list waited {:?} for the seal", t0.elapsed());
                assert!(!sealer.is_finished());
                BUILD_DELAY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
                assert!(sealer.join().unwrap().unwrap().prebuilt.is_some());
            });
            BUILD_DELAY_MS.store(0, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// Step 2: Encrypt on, "Encrypt drafts" off: the page sends the draft WITHOUT security (Compose.saveDraft: `keepPrivate ? {encrypt...} : undefined`),
    /// so the backend appends a plain draft; the backend never decides this itself (a draft that does carry `encrypt` is always encrypted).
    #[test]
    fn a_draft_without_security_is_stored_plain_and_one_with_it_is_encrypted() {
        let (c, acc, _g) = setup();
        add_own(&c, "me@example.com", "my-pass-1234");
        let db = share(c);
        let mut d = draft(&acc, &["ann@example.com"], &[], true, false);
        d.security = None; // what the page sends when "Encrypt drafts" is off
        let plain = String::from_utf8_lossy(&crate::draft_bytes(&db, &acc, &d).unwrap()).to_string();
        assert!(!plain.contains("BEGIN PGP MESSAGE") && plain.contains("secret plan"), "{plain}");
        d.security = Some(Security { encrypt: true, sign: false, attach_public_key: false }); // what it sends when it is on
        let enc = String::from_utf8_lossy(&crate::draft_bytes(&db, &acc, &d).unwrap()).to_string();
        assert!(enc.contains("BEGIN PGP MESSAGE") && !enc.contains("secret plan"));
        // a draft is never signed, and Sign alone stores a plain draft
        d.security = Some(Security { encrypt: false, sign: true, attach_public_key: true });
        let signed = String::from_utf8_lossy(&crate::draft_bytes(&db, &acc, &d).unwrap()).to_string();
        assert!(!signed.contains("BEGIN PGP") && signed.contains("secret plan"));
    }

    /// Step 3: "Move to Drafts" of a scheduled message that was sealed (encrypted to bob and to the account at schedule time): the stored draft must be
    /// for the own key only, like every other draft.
    #[test]
    fn a_moved_scheduled_message_is_stored_for_the_own_key_only() {
        crate::test_guard::within(60, || {
            let (c, acc, _g) = setup();
            let own = add_own(&c, "me@example.com", "my-pass-1234");
            unlock_key(&load_store(&c).unwrap(), &own, "my-pass-1234", false).unwrap();
            let (_, bob) = add_contact(&c, "bob@example.com");
            let db = share(c);
            let sealed = seal_for_outbox(&db, &acc, &draft(&acc, &["bob@example.com"], &[], true, false)).unwrap();
            // (what the outbox holds: the message for bob and for the account)
            let at_schedule = openpgp::encrypted_for(&pgp_block(&base64::engine::general_purpose::STANDARD.decode(sealed.prebuilt.as_ref().unwrap()).unwrap())).unwrap();
            assert!(at_schedule.iter().any(|i| subkey_ids(&db, &bob).contains(i)), "the sealed message is for bob: {at_schedule:?}");
            let raw = crate::draft_bytes(&db, &acc, &sealed).unwrap();
            let ids = openpgp::encrypted_for(&pgp_block(&raw)).unwrap();
            assert_eq!(ids, subkey_ids(&db, &own), "the moved draft is for the own key only: {ids:?}");
            // and it opens again with the own key and holds the text
            let store = load_store(&lock(&db)).unwrap();
            let verified = HashSet::new();
            let key = unlocked_keys();
            let ctx = Ctx { unlocked: key.iter().collect(), locked: vec![], publics: &store.publics, verified: &verified };
            let o = pgpmail::open(&raw, &ctx);
            assert_eq!(o.security.decryption, "ok", "{:?}", o.security);
            let p = crate::mail::parse(1, o.plain.as_ref().unwrap(), true, false, 0).unwrap();
            assert!(p.text.unwrap().contains("the secret plan"));
            // a locked key asks for the passphrase instead of storing something unreadable or too open
            lock_all_now();
            assert_eq!(crate::draft_bytes(&db, &acc, &sealed).unwrap_err(), format!("PGP_LOCKED:{own}"));
        });
    }

    /// 1.0.7 W2.22 CF-24: a signed or encrypted message that was built when it was scheduled goes out with the date of the send; the signature stays valid,
    /// the encrypted one still decrypts, and the Sent copy (the same bytes) has the same date.
    #[test]
    fn a_scheduled_signed_message_is_dated_when_it_is_sent() {
        crate::test_guard::within(60, || {
            let (c, acc, _g) = setup();
            let own = add_own(&c, "me@example.com", "my-pass-1234");
            unlock_key(&load_store(&c).unwrap(), &own, "my-pass-1234", false).unwrap();
            let (bob, _) = add_contact(&c, "bob@example.com");
            let signed = seal_for_outbox(&c, &acc, &draft(&acc, &["bob@example.com"], &[], false, true)).unwrap();
            let encrypted = seal_for_outbox(&c, &acc, &draft(&acc, &["bob@example.com"], &[], true, false)).unwrap();
            let db = share(c);
            let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
            let date_of = |raw: &[u8]| {
                let (h, _) = pgpmail::parse_headers(raw);
                chrono::DateTime::parse_from_rfc2822(pgpmail::header(&h, "Date").unwrap()).unwrap().timestamp()
            };
            // the headers without the Date line, and the part below them
            let without_date = |raw: &[u8]| String::from_utf8_lossy(raw).split("\r\n").filter(|l| !l.starts_with("Date: ")).collect::<Vec<_>>().join("\r\n");
            for (name, sealed) in [("signed", &signed), ("encrypted", &encrypted)] {
                // built "on Monday": the date of the build is long past by the time the send happens
                let built = base64::engine::general_purpose::STANDARD.decode(sealed.prebuilt.as_ref().unwrap()).unwrap();
                let monday = chrono::DateTime::parse_from_rfc2822("Mon, 12 Oct 2026 09:00:00 +0000").unwrap();
                let built = smtp::restamp_date(&built, monday);
                assert_eq!(date_of(&built), monday.timestamp(), "{name}: the test message is old");
                let mut d = sealed.clone();
                d.prebuilt = Some(b64(&built));
                let before = chrono::Utc::now().timestamp();
                let (sent, _env) = crate::finished_message(&db, &acc, &d).unwrap();
                let after = chrono::Utc::now().timestamp();
                let stamped = date_of(&sent);
                assert!(stamped >= before - 1 && stamped <= after + 1, "{name}: Date is the send time ({stamped} not in {before}..{after})");
                assert_eq!(without_date(&sent), without_date(&built), "{name}: nothing but the Date line changed (headers, signature part, ciphertext)");
                // what a reader makes of it
                let store = load_store(&lock(&db)).unwrap();
                let verified = HashSet::new();
                let ctx = if name == "signed" {
                    Ctx { unlocked: vec![], locked: vec![], publics: &store.publics, verified: &verified }
                } else {
                    Ctx { unlocked: vec![&bob], locked: vec![], publics: &store.publics, verified: &verified }
                };
                let o = pgpmail::open(&sent, &ctx);
                if name == "signed" {
                    assert_eq!(o.security.signature.as_ref().map(|s| s.status.as_str()), Some("valid"), "the signature still verifies: {:?}", o.security);
                } else {
                    assert_eq!(o.security.decryption, "ok", "{:?}", o.security);
                }
            }
            // a plain scheduled message is built when it is sent (the date is the send time without any help)
            let plain = draft(&acc, &["bob@example.com"], &[], false, false);
            let (sent, _) = crate::finished_message(&db, &acc, &plain).unwrap();
            assert!((date_of(&sent) - chrono::Utc::now().timestamp()).abs() < 60);
        });
    }

    /// 1.0.7 W2.9: the part headers of a signed message are folded before it is signed, so the signature of the finished (folded) message verifies;
    /// an encrypted message decrypts to parts whose headers are folded too, and the attachment names arrive unchanged.
    #[test]
    fn a_signed_or_encrypted_message_with_long_part_headers_still_verifies_and_decrypts() {
        crate::test_guard::within(60, || {
            let (c, acc, _g) = setup();
            let own = add_own(&c, "me@example.com", "my-pass-1234");
            unlock_key(&load_store(&c).unwrap(), &own, "my-pass-1234", false).unwrap();
            let (bob, _) = add_contact(&c, "bob@example.com");
            let name = "Báo cáo tài chính quý bốn năm hai nghìn hai mươi sáu của công ty 東京支店 売上報告書 最終版 すべてのデータ.pdf";
            let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
            let mut d = draft(&acc, &["bob@example.com"], &[], false, true);
            d.attachments = vec![
                Att { filename: name.into(), mime: "application/pdf".into(), data_base64: b64(b"%PDF") },
                Att { filename: "Quarterly figures.docx".into(), mime: docx.into(), data_base64: b64(b"PK") },
            ];
            let physical_lines_fit = |raw: &[u8]| {
                let text = String::from_utf8_lossy(raw).into_owned();
                let head = text.split("

").next().unwrap().to_string();
                // every line before a blank line that follows a boundary or the start is a header line; the bodies here are base64 or armored text
                head.split("
").all(|l| l.len() <= 78) && !text.lines().any(|l| l.starts_with("Content-Type: application/vnd"))
            };
            let store = load_store(&c).unwrap();
            let verified = HashSet::new();
            // signed
            let signed = smtp::wire(&build_secure(&c, &acc, &d, false).unwrap());
            assert!(physical_lines_fit(&signed), "{}", String::from_utf8_lossy(&signed));
            let ctx = Ctx { unlocked: vec![], locked: vec![], publics: &store.publics, verified: &verified };
            let o = pgpmail::open(&signed, &ctx);
            assert_eq!(o.security.signature.as_ref().map(|s| s.status.as_str()), Some("valid"), "{:?}", o.security);
            let names: Vec<String> = crate::mail::parse(1, &signed, true, false, 0).unwrap().attachments.iter().map(|a| a.name.clone()).collect();
            assert!(names.iter().any(|n| n == name) && names.iter().any(|n| n == "Quarterly figures.docx"), "{names:?}");
            // encrypted
            d.security = Some(Security { encrypt: true, sign: false, attach_public_key: false });
            let enc = smtp::wire(&build_secure(&c, &acc, &d, false).unwrap());
            let ctx = Ctx { unlocked: vec![&bob], locked: vec![], publics: &store.publics, verified: &verified };
            let o = pgpmail::open(&enc, &ctx);
            assert_eq!(o.security.decryption, "ok", "{:?}", o.security);
            let plain = o.plain.expect("decrypted");
            let inner = String::from_utf8_lossy(&plain).into_owned();
            assert!(!inner.lines().any(|l| l.starts_with("Content-Type: application/vnd")), "the media type is folded inside the encrypted entity: {inner}");
            let names: Vec<String> = crate::mail::parse(2, &plain, true, false, 0).unwrap().attachments.iter().map(|a| a.name.clone()).collect();
            assert!(names.iter().any(|n| n == name), "{names:?}");
        });
    }

    /// Synthetic draft of `mb` MB of inline pictures (14 of them), random bytes so nothing compresses.
    fn big_draft(acc: &Account, mb: usize, enc: bool) -> Draft {
        use rand08::RngCore;
        let mut d = draft(acc, &["bob@example.com"], &[], enc, false);
        let mut rng = rand08::thread_rng();
        let each = mb * 1024 * 1024 / 14;
        let mut html = String::from("<p>pictures</p>\n");
        for i in 0..14 {
            let mut b = vec![0u8; each];
            rng.fill_bytes(&mut b);
            let cid = format!("img{i}@x");
            html.push_str(&format!("<p><img src=\"cid:{cid}\"></p>\n"));
            d.inline.push(smtp::InlineImage { cid, filename: format!("p{i}.png"), mime: "image/png".into(), data_base64: base64::engine::general_purpose::STANDARD.encode(&b) });
        }
        d.html = html;
        d
    }

    #[test]
    #[ignore]
    fn perf_big_draft() {
        let mb: usize = std::env::var("PERF_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
        let (c, acc, _g) = setup();
        add_own(&c, "me@example.com", "my-pass-1234");
        let t = |name: &str, f: &mut dyn FnMut() -> usize| {
            let t0 = std::time::Instant::now();
            let n = f();
            eprintln!("PERF {mb} MB {name}: {:.3} s ({n} bytes)", t0.elapsed().as_secs_f64());
        };
        let plain = big_draft(&acc, mb, false);
        t("plain build+wire", &mut || smtp::wire(&smtp::build_draft(&acc, &plain).unwrap()).len());
        let wire_plain = smtp::wire(&smtp::build_draft(&acc, &plain).unwrap());
        t("openpgp::encrypt alone (armored)", &mut || {
            let store = load_store(&c).unwrap();
            let own = store.own_key(&acc).unwrap();
            let r = [Recipient { key: &own.public, hidden: false }];
            openpgp::encrypt(&wire_plain, &r, None).unwrap().len()
        });
        let encd = big_draft(&acc, mb, true);
        // what the command bridge does with the draft on the main thread before the command runs (the body of the invoke is parsed from JSON)
        let json = serde_json::to_string(&encd).unwrap();
        t("serde_json::from_str::<Draft> (the IPC argument)", &mut || serde_json::from_str::<Draft>(&json).unwrap().inline.len());
        drop(json);
        let mut enc_wire = vec![];
        t("encrypted build_secure(draft)+wire", &mut || {
            enc_wire = smtp::wire(&build_secure(&c, &acc, &encd, true).unwrap());
            enc_wire.len()
        });
        // what save_draft_on does with the bytes after the append, besides the network
        t("draft_thread_id(plain)", &mut || crate::draft_thread_id("a1", &wire_plain).map_or(0, |s| s.len()));
        t("draft_thread_id(encrypted)", &mut || crate::draft_thread_id("a1", &enc_wire).map_or(0, |s| s.len()));
        t("draft_ref(encrypted)", &mut || crate::draftmail::draft_ref("a1", &enc_wire).map_or(0, |s| s.len()));
        // the page asks for the whole path in one go: draft_bytes (plain and encrypted, as the commands do it)
        let db = share(c);
        t("draft_bytes(encrypted)", &mut || crate::draft_bytes(&db, &acc, &encd).unwrap().len());
        t("draft_bytes(plain, security none)", &mut || {
            let mut p = plain.clone();
            p.security = None;
            crate::draft_bytes(&db, &acc, &p).unwrap().len()
        });
        // one picture pasted as a data: URI in the html (no cid part)
        let mut dataurl = draft(&acc, &["bob@example.com"], &[], false, false);
        dataurl.html = format!("<p>x</p>\n<img src=\"data:image/png;base64,{}\">\n", "QUJD".repeat(mb * 1024 * 1024 / 3));
        t("html with a data: uri of the size (plain)", &mut || smtp::wire(&smtp::build_draft(&acc, &dataurl).unwrap()).len());
    }

    /// 1.0.7 W2.6: a recipient whose only key cannot encrypt is told apart from one with no key at all (the chip and the strip say so).
    #[test]
    fn a_key_that_can_only_sign_is_reported_as_sign_only() {
        let (c, _acc, _g) = setup();
        add_own(&c, "me@example.com", "my-pass-1234");
        let only_signing = |email: &str| {
            let sk = openpgp::generate(Algo::Cv25519, &format!("Sign <{email}>"), None, "x-pass-12345").unwrap();
            let mut pk = sk.to_public_key();
            pk.public_subkeys.clear(); // a certificate without an encryption subkey
            save_key(&c, &pk, None, false, "paste").unwrap();
        };
        only_signing("sign@example.com");
        only_signing("both@example.com");
        add_contact(&c, "both@example.com"); // the same address also has a key that can encrypt: that one wins
        add_contact(&c, "bob@example.com");
        let ask = |list: &[&str]| -> Vec<(String, String)> {
            let list: Vec<String> = list.iter().map(|a| a.to_string()).collect();
            recipient_status(&c, "a1", &list).unwrap().recipients.into_iter().map(|r| (r.address, r.status)).collect()
        };
        let got = ask(&["sign@example.com", "nobody@example.com", "bob@example.com", "both@example.com", "SIGN@Example.com"]);
        let status = |a: &str| got.iter().find(|(x, _)| x == a).map(|(_, s)| s.as_str());
        assert_eq!(status("sign@example.com"), Some("signOnly"));
        assert_eq!(status("nobody@example.com"), Some("missing"), "no key at all is still 'no public key'");
        assert_eq!(status("bob@example.com"), Some("ok"));
        assert_eq!(status("both@example.com"), Some("ok"), "another usable key for the address wins");
        assert_eq!(got.last().map(|(_, s)| s.as_str()), Some("signOnly"), "the address is matched without regard to case");
    }

    #[test]
    fn attach_public_key_adds_a_key_attachment() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        let mut d = draft(&acc, &["bob@example.com"], &[], false, true);
        unlock_key(&load_store(&c).unwrap(), &fpr, "my-pass-1234", false).unwrap();
        d.security.as_mut().unwrap().attach_public_key = true;
        let raw = build_secure(&c, &acc, &d, false).unwrap().formatted();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.contains("application/pgp-keys") && text.contains("public-key.asc"), "{text}");
    }

    #[test]
    fn scheduling_seals_encrypted_drafts_and_opens_them_again() {
        let (c, acc, _g) = setup();
        let fpr = add_own(&c, "me@example.com", "my-pass-1234");
        unlock_key(&load_store(&c).unwrap(), &fpr, "my-pass-1234", false).unwrap();
        add_contact(&c, "bob@example.com");
        let mut d = draft(&acc, &["bob@example.com"], &[], true, true);
        d.attachments.push(Att { filename: "plan.txt".into(), mime: "text/plain".into(), data_base64: "aGVsbG8=".into() });
        let sealed = seal_for_outbox(&c, &acc, &d).unwrap();
        let json = serde_json::to_string(&sealed).unwrap();
        assert!(!json.contains("secret plan"), "no plaintext in the outbox payload");
        assert!(sealed.prebuilt.is_some() && sealed.attachments.is_empty());
        let back = unseal_from_outbox(&c, &acc, &sealed).unwrap();
        assert!(back.html.contains("the secret plan"));
        assert_eq!(back.attachments.len(), 1);
        assert!(back.prebuilt.is_none());
        // locked key: asks for the passphrase instead of failing obscurely
        lock_all_now();
        assert_eq!(unseal_from_outbox(&c, &acc, &sealed).unwrap_err(), format!("PGP_LOCKED:{fpr}"));
        // signed only: content stays, a ready message is stored
        let signed = seal_for_outbox(&c, &acc, &draft(&acc, &["bob@example.com"], &[], false, true));
        assert!(signed.is_err(), "locked key cannot sign at schedule time");
        unlock_key(&load_store(&c).unwrap(), &fpr, "my-pass-1234", false).unwrap();
        let signed = seal_for_outbox(&c, &acc, &draft(&acc, &["bob@example.com"], &[], false, true)).unwrap();
        assert!(signed.prebuilt.is_some() && signed.html.contains("secret plan"));
    }

    #[test]
    fn import_rules_for_secret_keys() {
        let (c, _acc, _g) = setup();
        let sk = openpgp::generate(Algo::Cv25519, "Imp <imp@example.com>", None, "imp-pass-1234").unwrap();
        let armored = openpgp::armor_secret(&sk).unwrap();
        let mats = || openpgp::parse_material(armored.as_bytes()).unwrap();
        assert!(import_materials(&c, mats(), "wrong-pass-1", true, "paste").unwrap_err().starts_with("PGP_BAD_PASSPHRASE"));
        let done = import_materials(&c, mats(), "imp-pass-1234", true, "paste").unwrap();
        assert_eq!(done.len(), 1);
        assert!(load_store(&c).unwrap().by_fpr(&done[0]).unwrap().secret.is_some());
        // unprotected secret key must get a passphrase on import
        let open = openpgp::unlock_clone(&sk, "imp-pass-1234").unwrap();
        let plain = openpgp::armor_secret(&open).unwrap();
        let m = || openpgp::parse_material(plain.as_bytes()).unwrap();
        assert!(import_materials(&c, m(), "", true, "paste").unwrap_err().starts_with("PGP_NEEDS_PASSPHRASE"));
        import_materials(&c, m(), "new-pass-5678", true, "paste").unwrap();
        let s = load_store(&c).unwrap();
        assert!(openpgp::is_protected(s.by_fpr(&done[0]).unwrap().secret.as_ref().unwrap()));
    }

    #[test]
    fn stored_message_asks_for_the_key_of_its_own_mailbox() {
        // two accounts of the app, both with a locked key; a message from the first to the second is encrypted to both keys
        let (c, acc_a, _g) = setup();
        let acc_b = account("b2", "other@example.com");
        crate::db::insert_account(&c, &acc_b).unwrap();
        let fpr_a = add_own(&c, "me@example.com", "my-pass-1234");
        let fpr_b = add_own(&c, "other@example.com", "other-pass-1234");
        let mut d = draft(&acc_a, &["other@example.com"], &[], true, false);
        d.security = Some(Security { encrypt: true, sign: false, attach_public_key: false });
        let raw = build_secure(&c, &acc_a, &d, false).unwrap().formatted();
        for (id, account, to) in [("in-b", "b2", "other@example.com"), ("in-a-copy", "a1", "other@example.com")] {
            c.execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,pgp) VALUES(?1,?2,'inbox',(SELECT COUNT(*)+1 FROM messages),'t','s','n','me@example.com',?3,'',0,'',1)",
                params![id, account, to],
            )
            .unwrap();
        }
        invalidate();
        let opened_b = open_message(&c, "in-b", &raw).unwrap();
        assert_eq!(opened_b.security.decryption, "locked");
        assert_eq!(opened_b.security.locked_key.as_deref(), Some(fpr_b.as_str()), "the mailbox's own key, not the sender's");
        assert_eq!(opened_b.security.locked_label.as_deref(), Some("other@example.com"));
        let opened_a = open_message(&c, "in-a-copy", &raw).unwrap();
        assert_eq!(opened_a.security.locked_key.as_deref(), Some(fpr_a.as_str()));
        assert_eq!(opened_a.security.locked_label.as_deref(), Some("me@example.com"));
    }
}

fn pgpstore_hash(b: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}
