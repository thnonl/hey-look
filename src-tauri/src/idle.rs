//! IMAP IDLE push (RFC 2177) for the Inbox, with the poller of `sync_worker` kept as the safety net.
//!
//! One supervisor thread (`start`) looks every few seconds at which accounts should have a push session: the account has had its first
//! sync, and the `pushMail` pref (per account, default on) is not off. For each one a worker thread keeps one extra connection to the
//! INBOX open and sits in IDLE. When the server reports a change the worker waits a moment (debounce), then runs the same sync as the
//! poller (`Host::changed` = `run_sync` + the `mail-synced` event, so notifications, filters, badge and backfill behave as before).
//!
//! The pure parts (`Timing`, `Tracker`, `Pacer`, the watchdog) take `Instant`s as arguments, so their tests use a fake clock.
//!
//! State per account: `push` (IDLE is running) or `polling` (no IDLE on the server, the pref is off, or the connection keeps failing).
//! `sync_worker` asks `poll_minutes_for`: while the account is in `push` the poll interval is at least `healthy_poll_min` minutes,
//! otherwise it is the configured one (2 minutes by default).
//!
//! Stopping: the supervisor stops a worker when its account is removed or the pref is turned off, and `shutdown` (called on exit)
//! stops all. A stop sets a flag (every wait is interruptible) and shuts the socket down, so a read that blocks returns at once.
//! A thread blocked in a read cannot be woken from outside on Windows when the peer is silent (`shutdown` only helps when the peer
//! answers the FIN), and the imap crate clears the read timeout after an IDLE wait and then reads the answer to DONE without one. So the
//! IDLE wait is cut into slices of `Timing::poll` (`wait_interruptible`, an addition to the vendored crate): the stop flag is looked at
//! after each slice, and the read timeout stays `Timing::finish` for the answer to DONE. The supervisor's watchdog (shutdown of the
//! socket when the wait plus a grace period is over) is a second line that works wherever `shutdown` wakes a read.
use crate::db::{err, Account, R};
use crate::{db, mail, startup, AppState, Db};
use std::collections::HashMap;
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// ---------- timing (pure) ----------

/// Every duration of the machine in one place; tests use short ones.
#[derive(Clone, Debug)]
pub struct Timing {
    /// IDLE is ended and started again this often (servers drop an IDLE at 29-30 minutes, NAT entries may be shorter).
    pub keepalive: Duration,
    /// Allowed on top of `keepalive` for the server to answer DONE before the watchdog shuts the socket down.
    pub grace: Duration,
    /// The IDLE read is cut into slices of this length; the stop flag is looked at after each (so a stop takes at most this long).
    pub poll: Duration,
    /// Read timeout for the answer to DONE after an IDLE wait.
    pub finish: Duration,
    /// After the server reports a change: wait this long (a burst of mail is one sync).
    pub debounce: Duration,
    /// At least this long between the end of one push-triggered sync and the start of the next.
    pub min_gap: Duration,
    /// Wait before reconnect after the 1st, 2nd, ... failure in a row; the last value repeats.
    pub backoff: Vec<Duration>,
    /// A session that stayed in IDLE this long counts as healthy: the failure count starts again.
    pub stable_after: Duration,
    /// This many failures in a row turn the state to `polling`.
    pub polling_after_failures: u32,
    /// While IDLE is healthy the poller runs at most this often (minutes).
    pub healthy_poll_min: u64,
    /// A server without IDLE is asked again after this long.
    pub unsupported_retry: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            keepalive: Duration::from_secs(25 * 60),
            grace: Duration::from_secs(30),
            poll: Duration::from_secs(2),
            finish: Duration::from_secs(30),
            debounce: Duration::from_secs(2),
            min_gap: Duration::from_secs(5),
            backoff: [30, 60, 120, 300].iter().map(|s| Duration::from_secs(*s)).collect(),
            stable_after: Duration::from_secs(120),
            polling_after_failures: 2,
            healthy_poll_min: 10,
            unsupported_retry: Duration::from_secs(60 * 60),
        }
    }
}

impl Timing {
    /// Delay before the reconnect that follows the `failures`-th failure in a row (1-based).
    pub fn backoff_for(&self, failures: u32) -> Duration {
        let i = (failures.max(1) as usize - 1).min(self.backoff.len().saturating_sub(1));
        self.backoff.get(i).copied().unwrap_or(Duration::from_secs(300))
    }

    /// The moment the watchdog gives up on an IDLE wait that began at `idle_started`.
    pub fn watchdog_deadline(&self, idle_started: Instant) -> Instant {
        idle_started + self.keepalive + self.grace
    }
}

/// Where an account's push session stands.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Push {
    /// Not decided yet (just started, or not connected so far): counts as polling.
    Starting,
    /// IDLE is running.
    On,
    /// No IDLE on the server, or the connection keeps failing.
    Polling,
}

impl Push {
    /// The word the UI shows.
    pub fn label(self) -> &'static str {
        if self == Push::On { "push" } else { "polling" }
    }
}

/// What a failed session leads to.
#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
    pub retry_in: Duration,
    /// The session had reached IDLE before it failed: mail may have arrived unseen, so a catch-up sync follows the next IDLE.
    pub was_up: bool,
    pub change: Option<Push>,
}

/// The state machine of one account: counts failures, decides `push` / `polling`.
#[derive(Debug)]
pub struct Tracker {
    pub state: Push,
    failures: u32,
    up_since: Option<Instant>,
}

impl Tracker {
    pub fn new() -> Self {
        Tracker { state: Push::Starting, failures: 0, up_since: None }
    }

    fn set(&mut self, s: Push) -> Option<Push> {
        if self.state == s {
            None
        } else {
            self.state = s;
            Some(s)
        }
    }

    /// The server accepted IDLE. Returns the new state when it changed.
    pub fn idle_ok(&mut self, now: Instant) -> Option<Push> {
        self.up_since.get_or_insert(now);
        self.set(Push::On)
    }

    /// The session ended with an error at `now`.
    pub fn failed(&mut self, now: Instant, t: &Timing) -> Failure {
        let was_up = self.up_since.is_some();
        if let Some(since) = self.up_since.take() {
            if now.saturating_duration_since(since) >= t.stable_after {
                self.failures = 0;
            }
        }
        self.failures += 1;
        let change = if self.failures >= t.polling_after_failures { self.set(Push::Polling) } else { None };
        Failure { retry_in: t.backoff_for(self.failures), was_up, change }
    }

    /// The server does not offer IDLE.
    pub fn unsupported(&mut self) -> Option<Push> {
        self.up_since = None;
        self.set(Push::Polling)
    }
}

/// When a push-triggered sync may run: `debounce` after the change, and `min_gap` after the previous one.
#[derive(Default, Debug)]
pub struct Pacer {
    last_sync: Option<Instant>,
}

impl Pacer {
    pub fn due(&self, changed_at: Instant, t: &Timing) -> Instant {
        let d = changed_at + t.debounce;
        match self.last_sync {
            Some(l) => d.max(l + t.min_gap),
            None => d,
        }
    }

    pub fn synced(&mut self, at: Instant) {
        self.last_sync = Some(at);
    }
}

/// Minutes between polls of an account in `state` whose configured interval is `configured`.
pub fn poll_minutes(state: Push, configured: u64, t: &Timing) -> u64 {
    if state == Push::On { configured.max(t.healthy_poll_min) } else { configured }
}

// ---------- shared handles ----------

/// A flag with a condition variable: waits that stop at once when it is set (no polling loops, no long sleeps that delay a quit).
pub struct Stop {
    flag: Mutex<bool>,
    cv: Condvar,
}

impl Stop {
    pub fn new() -> Self {
        Stop { flag: Mutex::new(false), cv: Condvar::new() }
    }

    pub fn stop(&self) {
        *self.flag.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.cv.notify_all();
    }

    pub fn is_stopped(&self) -> bool {
        *self.flag.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Sleeps up to `d`. `true` = stopped (before or during the sleep).
    pub fn sleep(&self, d: Duration) -> bool {
        let g = self.flag.lock().unwrap_or_else(|p| p.into_inner());
        let (g, _) = self.cv.wait_timeout_while(g, d, |s| !*s).unwrap_or_else(|p| p.into_inner());
        *g
    }
}

/// What the supervisor and one worker thread share.
pub struct Shared {
    pub stop: Stop,
    sock: Mutex<Option<TcpStream>>,
    deadline: Mutex<Option<Instant>>,
}

impl Shared {
    pub fn new() -> Arc<Self> {
        Arc::new(Shared { stop: Stop::new(), sock: Mutex::new(None), deadline: Mutex::new(None) })
    }

    /// Remember the socket of the running session. Stopped already: the socket is shut down at once.
    fn attach(&self, sock: &TcpStream) {
        let mut g = self.sock.lock().unwrap_or_else(|p| p.into_inner());
        if self.stop.is_stopped() {
            let _ = sock.shutdown(Shutdown::Both);
        }
        *g = sock.try_clone().ok();
    }

    fn detach(&self) {
        *self.sock.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.deadline.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn kill_socket(&self) {
        if let Some(s) = self.sock.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }

    /// Ends the worker: flag first, then the socket (a blocked read returns).
    pub fn stop_now(&self) {
        self.stop.stop();
        self.kill_socket();
    }

    fn set_deadline(&self, d: Option<Instant>) {
        *self.deadline.lock().unwrap_or_else(|p| p.into_inner()) = d;
    }

    /// Called by the supervisor every tick: an IDLE wait that is past its deadline has a silent peer, so its socket is shut down
    /// and the worker reconnects. Returns whether it did.
    pub fn watchdog(&self, now: Instant) -> bool {
        let expired = self.deadline.lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|d| now >= d);
        if expired {
            self.set_deadline(None);
            self.kill_socket();
        }
        expired
    }
}

/// What the worker needs from the app; the tests bring their own.
pub trait Host: Send + Sync {
    /// The account as it is now, and the password or a fresh OAuth access token (asked again for every connection).
    fn account(&self) -> R<(Account, String)>;
    /// The server reported a change (or a catch-up is due): run the same sync as the poller.
    fn changed(&self);
    /// The state of the account changed.
    fn state(&self, s: Push);
    fn log(&self, what: &str);
    /// IDLE was ended and started again (the keepalive).
    fn renewed(&self) {}
    /// Tests only: connect to this plain TCP address instead of the account's server over TLS.
    #[cfg(test)]
    fn plain_addr(&self) -> Option<std::net::SocketAddr> {
        None
    }
}

// ---------- the worker ----------

enum End {
    Stopped,
    Unsupported,
}

struct Run {
    tracker: Tracker,
    pacer: Pacer,
    /// A session was lost after it had been up: one sync runs as soon as the next IDLE is up.
    catch_up: bool,
}

/// Runs until the stop flag is set: connect, IDLE, sync on change, renew, reconnect after errors with backoff. `catch_up`: one sync
/// runs as soon as the first IDLE is up (the worker replaces one that was lost, for instance in a sleep).
pub fn run_account(sh: &Shared, host: &dyn Host, t: &Timing, catch_up: bool) {
    let mut run = Run { tracker: Tracker::new(), pacer: Pacer::default(), catch_up };
    while !sh.stop.is_stopped() {
        match session(sh, host, t, &mut run) {
            Ok(End::Stopped) => break,
            Ok(End::Unsupported) => {
                sh.detach();
                if let Some(s) = run.tracker.unsupported() {
                    host.state(s);
                    host.log("server has no IDLE, polling");
                }
                if sh.stop.sleep(t.unsupported_retry) {
                    break;
                }
            }
            Err(e) => {
                sh.detach();
                if sh.stop.is_stopped() {
                    break;
                }
                let f = run.tracker.failed(Instant::now(), t);
                run.catch_up |= f.was_up;
                if let Some(s) = f.change {
                    host.state(s);
                    host.log("polling");
                }
                host.log(&format!("reconnect in {} s: {e}", f.retry_in.as_secs()));
                if sh.stop.sleep(f.retry_in) {
                    break;
                }
            }
        }
    }
    sh.detach();
    host.log("stopped");
}

/// Whether the server said anything new about the mailbox since the last command.
fn drain<T: std::io::Read + std::io::Write>(s: &imap::Session<T>) -> bool {
    use imap::types::UnsolicitedResponse as U;
    let mut any = false;
    while let Ok(u) = s.unsolicited_responses.try_recv() {
        any |= !matches!(u, U::Recent(_));
    }
    any
}

/// Debounce, then the sync. `false` = stopped meanwhile.
fn sync_after_change(sh: &Shared, host: &dyn Host, t: &Timing, run: &mut Run) -> bool {
    let now = Instant::now();
    let due = run.pacer.due(now, t);
    if sh.stop.sleep(due.saturating_duration_since(now)) {
        return false;
    }
    host.changed();
    run.pacer.synced(Instant::now());
    !sh.stop.is_stopped()
}

/// One connection: until it fails (`Err`), the worker is stopped, or the server has no IDLE.
fn session(sh: &Shared, host: &dyn Host, t: &Timing, run: &mut Run) -> R<End> {
    let (acc, secret) = host.account()?;
    // test seam: a plain TCP server instead of TLS (a fake server that answers IDLE wrongly needs no certificate)
    #[cfg(test)]
    if let Some(addr) = host.plain_addr() {
        let sock = TcpStream::connect(addr).map_err(err)?;
        sock.set_read_timeout(Some(mail::IO_TIMEOUT)).map_err(err)?;
        let handle = sock.try_clone().map_err(err)?;
        let mut c = imap::Client::new(sock);
        c.read_greeting().map_err(err)?;
        let s = c.login(&acc.username, &secret).map_err(|e| format!("IMAP login failed: {}", e.0))?;
        return serve(sh, host, t, run, s, handle);
    }
    let (s, sock) = mail::connect_with_socket(&acc, &secret)?;
    serve(sh, host, t, run, s, sock)
}

/// The session on a connected, logged-in transport (TLS in the app).
fn serve<T: std::io::Read + std::io::Write + imap::extensions::idle::SetReadTimeout>(
    sh: &Shared,
    host: &dyn Host,
    t: &Timing,
    run: &mut Run,
    mut s: imap::Session<T>,
    sock: TcpStream,
) -> R<End> {
    sh.attach(&sock);
    if sh.stop.is_stopped() {
        return Ok(End::Stopped);
    }
    let has_idle = {
        let caps = s.capabilities().map_err(err)?;
        caps.has_str("IDLE") || caps.has_str("idle")
    };
    if !has_idle {
        let _ = s.logout();
        return Ok(End::Unsupported);
    }
    // read-only: the push connection never changes a flag
    s.examine("INBOX").map_err(err)?;
    loop {
        // what the server said since the last command (also what arrived while a sync ran)
        s.noop().map_err(err)?;
        let mut changed = drain(&s);
        if sh.stop.is_stopped() {
            return Ok(End::Stopped);
        }
        if std::mem::take(&mut run.catch_up) {
            changed = true;
        }
        if changed {
            if !sync_after_change(sh, host, t, run) {
                return Ok(End::Stopped);
            }
            continue;
        }
        let started = Instant::now();
        sh.set_deadline(Some(t.watchdog_deadline(started)));
        let h = s.idle().map_err(err)?;
        if let Some(st) = run.tracker.idle_ok(started) {
            host.state(st);
            host.log("push on");
        }
        // returns with IDLE ended (DONE sent and answered)
        let outcome = h.wait_interruptible(t.keepalive, t.poll, t.finish, &|| sh.stop.is_stopped());
        sh.set_deadline(None);
        // the commands that follow (NOOP) must not block for good either: a peer that went silent shows here at the latest
        let _ = sock.set_read_timeout(Some(t.finish));
        if sh.stop.is_stopped() {
            return Ok(End::Stopped);
        }
        match outcome.map_err(err)? {
            imap::extensions::idle::WaitOutcome::TimedOut => host.renewed(),
            imap::extensions::idle::WaitOutcome::MailboxChanged => {
                if !sync_after_change(sh, host, t, run) {
                    return Ok(End::Stopped);
                }
            }
        }
    }
}

// ---------- the app side ----------

/// State of every account that has a worker; read by the poller and by the UI.
static STATES: Mutex<Option<HashMap<String, Push>>> = Mutex::new(None);

fn set_state(id: &str, s: Option<Push>) {
    let mut g = STATES.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    match s {
        Some(s) => m.insert(id.to_string(), s),
        None => m.remove(id),
    };
}

fn state_of(id: &str) -> Push {
    STATES.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|m| m.get(id).copied()).unwrap_or(Push::Starting)
}

/// Poll interval for `sync_worker`: longer while the account is in push mode.
pub(crate) fn poll_minutes_for(account_id: &str, configured: u64) -> u64 {
    poll_minutes(state_of(account_id), configured, &Timing::default())
}

/// `push` or `polling` for each account that has a worker (an account without one is polled).
#[tauri::command]
pub fn idle_states() -> HashMap<String, String> {
    STATES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.label().to_string())).collect())
        .unwrap_or_default()
}

struct AppHost {
    app: tauri::AppHandle,
    db: Db,
    id: String,
}

impl Host for AppHost {
    fn account(&self) -> R<(Account, String)> {
        let acc = db::get_account(&crate::lock(&self.db), &self.id)?;
        let secret = crate::secret(&self.db, &acc)?;
        Ok((acc, secret))
    }

    fn changed(&self) {
        match crate::run_sync(&self.app, &self.db, &self.id) {
            Ok(_) => {
                let _ = self.app.emit("mail-synced", ());
            }
            Err(e) => startup::line("idle", &format!("{}: sync after a push event failed: {e}", self.id)),
        }
    }

    fn state(&self, s: Push) {
        set_state(&self.id, Some(s));
        let _ = self.app.emit("idle-state", serde_json::json!({ "accountId": self.id, "state": s.label() }));
    }

    fn log(&self, what: &str) {
        startup::line("idle", &format!("{}: {what}", self.id));
    }
}

struct Running {
    shared: Arc<Shared>,
    thread: JoinHandle<()>,
    /// The connection settings the worker was started with: a change restarts it.
    fingerprint: String,
}

fn fingerprint(a: &Account) -> String {
    format!("{}|{}|{}|{}|{}|{}", a.imap_host, a.imap_port, a.imap_ssl, a.username, a.auth, a.tls_insecure)
}

/// The accounts that should have a push session now.
fn wanted(db: &Db) -> HashMap<String, Account> {
    let accounts = db::list_accounts(&crate::lock(db)).unwrap_or_default();
    let p = crate::shell::prefs(db);
    accounts
        .into_iter()
        .filter(|a| crate::shell::eff(&p, &a.id, "pushMail").and_then(|v| v.as_bool()).unwrap_or(true))
        // after the account's first sync (it stores its folder map): the first sync is not made slower by a second connection
        .filter(|a| db::get_setting(&crate::lock(db), &format!("fmap:{}", a.id)).is_some())
        .map(|a| (a.id.clone(), a))
        .collect()
}

const TICK: Duration = Duration::from_secs(10);
/// A worker that ended by itself (a panic in a debug build) is started again after this long.
const RESTART_AFTER_DEATH: Duration = Duration::from_secs(60);
/// `shutdown` waits this long for the threads (their sockets are shut down, so they end at once unless a sync is running).
const SHUTDOWN_WAIT: Duration = Duration::from_millis(2500);

static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static QUIT: Mutex<Option<Arc<Stop>>> = Mutex::new(None);
static SUPERVISOR_DONE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn quit_flag() -> Arc<Stop> {
    QUIT.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(|| Arc::new(Stop::new())).clone()
}

/// Starts the supervisor (once, next to `sync_worker`).
pub fn start(app: tauri::AppHandle) {
    let quit = quit_flag();
    STARTED.store(true, std::sync::atomic::Ordering::SeqCst);
    std::thread::Builder::new().name("idle-supervisor".into()).spawn(move || supervisor(app, quit)).ok();
}

/// App exit: every push session is closed (sockets shut down, threads joined for a moment). Safe to call twice.
pub fn shutdown() {
    quit_flag().stop();
    if !STARTED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let (m, cv) = &SUPERVISOR_DONE;
    let g = m.lock().unwrap_or_else(|p| p.into_inner());
    let _ = cv.wait_timeout_while(g, SHUTDOWN_WAIT + Duration::from_millis(500), |done| !*done);
}

fn start_worker(app: &tauri::AppHandle, db: &Db, acc: &Account, catch_up: bool) -> Option<Running> {
    let shared = Shared::new();
    let host = AppHost { app: app.clone(), db: db.clone(), id: acc.id.clone() };
    set_state(&acc.id, Some(Push::Starting));
    let sh = shared.clone();
    let thread = std::thread::Builder::new()
        .name(format!("idle-{}", acc.id))
        .spawn(move || run_account(&sh, &host, &Timing::default(), catch_up))
        .ok()?;
    Some(Running { shared, thread, fingerprint: fingerprint(acc) })
}

/// What one look at the accounts leads to.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub stop: Vec<String>,
    pub start: Vec<String>,
}

/// `running`: account id -> (connection fingerprint it was started with, its thread has ended). `want`: account id -> fingerprint now.
/// `cooling`: accounts whose worker died a moment ago. A worker is stopped when its account is gone (removed, push turned off),
/// its server settings changed, or it died; an account that should have one and has none is started (not while it cools down).
pub fn plan(running: &HashMap<String, (String, bool)>, want: &HashMap<String, String>, cooling: &std::collections::HashSet<String>) -> Plan {
    let mut stop: Vec<String> = running
        .iter()
        .filter(|(id, (fp, finished))| *finished || want.get(*id) != Some(fp))
        .map(|(id, _)| id.clone())
        .collect();
    stop.sort();
    let mut start: Vec<String> = want
        .keys()
        .filter(|id| (!running.contains_key(*id) || stop.contains(id)) && !cooling.contains(*id))
        .cloned()
        .collect();
    start.sort();
    Plan { stop, start }
}

/// The wall clock moved on much more than one tick: the computer was asleep (its connections are dead or about to be).
pub fn slept(wall_gap: Duration, tick: Duration) -> bool {
    wall_gap > tick + Duration::from_secs(60)
}

fn announce(app: &tauri::AppHandle, id: &str, state: &str) {
    let _ = app.emit("idle-state", serde_json::json!({ "accountId": id, "state": state }));
}

fn supervisor(app: tauri::AppHandle, quit: Arc<Stop>) {
    let mut running: HashMap<String, Running> = HashMap::new();
    let mut stopping: Vec<JoinHandle<()>> = vec![];
    let mut cooldown: HashMap<String, Instant> = HashMap::new();
    let mut last_wall = std::time::SystemTime::now();
    while !quit.sleep(TICK) {
        let db = app.state::<AppState>().db.clone();
        let now = Instant::now();
        let wall = std::time::SystemTime::now();
        let woke = slept(wall.duration_since(last_wall).unwrap_or_default(), TICK);
        last_wall = wall;
        if woke && !running.is_empty() {
            // sockets that were open before the sleep are not trusted: every session is made again, with a catch-up sync
            startup::line("idle", &format!("the computer woke up: {} push session(s) are made again", running.len()));
            for (id, r) in running.drain() {
                r.shared.stop_now();
                stopping.push(r.thread);
                announce(&app, &id, "polling");
            }
        }
        for (id, r) in &running {
            if r.thread.is_finished() {
                cooldown.insert(id.clone(), now + RESTART_AFTER_DEATH);
            }
        }
        cooldown.retain(|_, until| now < *until);
        let accounts = wanted(&db);
        let want: HashMap<String, String> = accounts.iter().map(|(id, a)| (id.clone(), fingerprint(a))).collect();
        let view: HashMap<String, (String, bool)> = running.iter().map(|(id, r)| (id.clone(), (r.fingerprint.clone(), r.thread.is_finished()))).collect();
        let cooling = cooldown.keys().cloned().collect();
        let p = plan(&view, &want, &cooling);
        for id in &p.stop {
            if let Some(r) = running.remove(id) {
                r.shared.stop_now();
                stopping.push(r.thread);
            }
            set_state(id, None);
            announce(&app, id, "polling");
        }
        stopping.retain(|t| !t.is_finished());
        for id in &p.start {
            if let Some(acc) = accounts.get(id) {
                if let Some(r) = start_worker(&app, &db, acc, woke) {
                    running.insert(id.clone(), r);
                }
            }
        }
        for r in running.values() {
            if r.shared.watchdog(now) {
                startup::line("idle", "a silent connection was cut (no answer after the IDLE renewal)");
            }
        }
    }
    // exit: stop all, wait for the threads for a moment
    for (id, r) in running.drain() {
        r.shared.stop_now();
        set_state(&id, None);
        stopping.push(r.thread);
    }
    let end = Instant::now() + SHUTDOWN_WAIT;
    while Instant::now() < end && stopping.iter().any(|t| !t.is_finished()) {
        std::thread::sleep(Duration::from_millis(25));
    }
    let left = stopping.iter().filter(|t| !t.is_finished()).count();
    if left > 0 {
        startup::line("idle", &format!("exit: {left} push thread(s) still busy with a sync; the process ends anyway"));
    }
    let (m, cv) = &SUPERVISOR_DONE;
    *m.lock().unwrap_or_else(|p| p.into_inner()) = true;
    cv.notify_all();
}

// ---------- tests ----------

// against a real server in Docker; opt-in, see the file
#[cfg(test)]
#[path = "idle_it.rs"]
mod idle_it;

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn backoff_grows_and_stays_at_the_cap() {
        let t = Timing::default();
        let secs: Vec<u64> = (1..=7).map(|n| t.backoff_for(n).as_secs()).collect();
        assert_eq!(secs, vec![30, 60, 120, 300, 300, 300, 300]);
        assert_eq!(t.backoff_for(0).as_secs(), 30);
    }

    #[test]
    fn push_after_idle_polling_after_repeated_failures_and_back() {
        let t = Timing::default();
        let t0 = Instant::now();
        let mut tr = Tracker::new();
        assert_eq!(tr.state, Push::Starting);
        assert_eq!(tr.idle_ok(t0), Some(Push::On));
        assert_eq!(tr.idle_ok(at(t0, 1500)), None, "a renewal is no change");
        // the connection drops after 25 minutes: healthy session, so the first failure of a new series; state stays
        let f = tr.failed(at(t0, 1500), &t);
        assert_eq!(f, Failure { retry_in: Duration::from_secs(30), was_up: true, change: None });
        // the reconnect fails: second failure in a row => polling
        let f = tr.failed(at(t0, 1530), &t);
        assert_eq!((f.retry_in.as_secs(), f.was_up, f.change), (60, false, Some(Push::Polling)));
        let f = tr.failed(at(t0, 1590), &t);
        assert_eq!((f.retry_in.as_secs(), f.change), (120, None));
        // IDLE works again
        assert_eq!(tr.idle_ok(at(t0, 1710)), Some(Push::On));
    }

    #[test]
    fn a_session_that_dies_young_does_not_reset_the_failure_count() {
        let t = Timing::default();
        let t0 = Instant::now();
        let mut tr = Tracker::new();
        tr.idle_ok(t0);
        let a = tr.failed(at(t0, 10), &t); // up for 10 s only
        tr.idle_ok(at(t0, 40));
        let b = tr.failed(at(t0, 50), &t); // up for 10 s again
        assert_eq!((a.retry_in.as_secs(), b.retry_in.as_secs()), (30, 60));
        assert_eq!(b.change, Some(Push::Polling));
        // stable for 2 minutes: the series starts again
        tr.idle_ok(at(t0, 200));
        let c = tr.failed(at(t0, 400), &t);
        assert_eq!(c.retry_in.as_secs(), 30);
    }

    #[test]
    fn a_server_without_idle_is_polling_once() {
        let mut tr = Tracker::new();
        assert_eq!(tr.unsupported(), Some(Push::Polling));
        assert_eq!(tr.unsupported(), None);
        assert_eq!(tr.state.label(), "polling");
        assert_eq!(Push::Starting.label(), "polling");
        assert_eq!(Push::On.label(), "push");
    }

    #[test]
    fn poll_interval_is_longer_only_while_push_is_healthy() {
        let t = Timing::default();
        assert_eq!(poll_minutes(Push::On, 2, &t), 10);
        assert_eq!(poll_minutes(Push::On, 30, &t), 30, "a longer configured interval stays");
        assert_eq!(poll_minutes(Push::Polling, 2, &t), 2);
        assert_eq!(poll_minutes(Push::Starting, 1, &t), 1);
    }

    #[test]
    fn a_burst_is_one_sync_and_syncs_keep_their_distance() {
        let t = Timing::default();
        let t0 = Instant::now();
        let mut p = Pacer::default();
        // first change: after the debounce
        assert_eq!(p.due(t0, &t), at(t0, 2));
        p.synced(at(t0, 3));
        // the next change right after the sync: not before min_gap since the sync ended
        assert_eq!(p.due(at(t0, 3), &t), at(t0, 8));
        // a change long after: the debounce only
        assert_eq!(p.due(at(t0, 100), &t), at(t0, 102));
    }

    #[test]
    fn the_keepalive_and_the_watchdog_follow_the_clock() {
        let t = Timing::default();
        assert_eq!((t.poll.as_secs(), t.finish.as_secs()), (2, 30));
        let t0 = Instant::now();
        assert_eq!(t.keepalive, Duration::from_secs(25 * 60));
        let deadline = t.watchdog_deadline(t0);
        assert_eq!(deadline, at(t0, 25 * 60 + 30));
        let sh = Shared::new();
        sh.set_deadline(Some(deadline));
        assert!(!sh.watchdog(at(t0, 25 * 60)), "the wait is still within its keepalive");
        assert!(!sh.watchdog(at(t0, 25 * 60 + 29)));
        assert!(sh.watchdog(at(t0, 25 * 60 + 30)), "the answer to DONE is overdue");
        assert!(!sh.watchdog(at(t0, 3000)), "the deadline fires once");
    }

    #[test]
    fn stop_wakes_a_sleep_at_once_and_a_sleep_is_not_cut_short_otherwise() {
        let st = Arc::new(Stop::new());
        let t0 = Instant::now();
        assert!(!st.sleep(Duration::from_millis(40)));
        assert!(t0.elapsed() >= Duration::from_millis(40));
        let st2 = st.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            st2.stop();
        });
        let t1 = Instant::now();
        assert!(st.sleep(Duration::from_secs(30)));
        assert!(t1.elapsed() < Duration::from_secs(5));
        h.join().unwrap();
        assert!(st.is_stopped());
        assert!(st.sleep(Duration::from_secs(30)), "stopped stays stopped");
    }

    #[test]
    fn the_connection_settings_fingerprint_ignores_cosmetic_edits() {
        let mut a = Account {
            id: "a".into(), email: "x@example.test".into(), display_name: "X".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false,
        };
        let f = fingerprint(&a);
        a.display_name = "Y".into();
        a.color = Some("#fff".into());
        assert_eq!(fingerprint(&a), f);
        a.imap_port = 143;
        assert_ne!(fingerprint(&a), f);
    }

    #[test]
    fn the_plan_stops_removed_changed_and_dead_workers_and_starts_missing_ones() {
        use std::collections::HashSet;
        let run = |v: &[(&str, &str, bool)]| -> HashMap<String, (String, bool)> { v.iter().map(|(i, f, d)| (i.to_string(), (f.to_string(), *d))).collect() };
        let want = |v: &[(&str, &str)]| -> HashMap<String, String> { v.iter().map(|(i, f)| (i.to_string(), f.to_string())).collect() };
        let none = HashSet::new();
        // nothing changed
        assert_eq!(plan(&run(&[("a", "f1", false)]), &want(&[("a", "f1")]), &none), Plan::default());
        // account removed (AC1.4) or push turned off: it is not wanted any more
        assert_eq!(plan(&run(&[("a", "f1", false), ("b", "f2", false)]), &want(&[("b", "f2")]), &none), Plan { stop: vec!["a".into()], start: vec![] });
        // the server settings were edited: restart
        assert_eq!(plan(&run(&[("a", "f1", false)]), &want(&[("a", "f9")]), &none), Plan { stop: vec!["a".into()], start: vec!["a".into()] });
        // a new account (first sync done) or push turned on
        assert_eq!(plan(&run(&[]), &want(&[("n", "f")]), &none), Plan { stop: vec![], start: vec!["n".into()] });
        // a worker that died is replaced, but not at once when it has just died
        let dead = run(&[("a", "f1", true)]);
        assert_eq!(plan(&dead, &want(&[("a", "f1")]), &none), Plan { stop: vec!["a".into()], start: vec!["a".into()] });
        let cooling: HashSet<String> = ["a".to_string()].into();
        assert_eq!(plan(&dead, &want(&[("a", "f1")]), &cooling), Plan { stop: vec!["a".into()], start: vec![] });
    }

    #[test]
    fn a_long_gap_between_ticks_means_the_computer_slept() {
        let tick = Duration::from_secs(10);
        assert!(!slept(Duration::from_secs(10), tick));
        assert!(!slept(Duration::from_secs(25), tick), "a busy machine is no sleep");
        assert!(slept(Duration::from_secs(71), tick));
        assert!(slept(Duration::from_secs(3 * 3600), tick));
    }

    // ---- a server that answers wrongly must never be able to end the app (release builds use panic = "abort") ----

    #[derive(Clone, Copy, Debug)]
    enum Odd {
        /// `tag NO ...` to IDLE
        No,
        /// `tag BAD ...` to IDLE
        Bad,
        /// a line of garbage to IDLE, then the connection closes
        Garbage,
        /// `tag OK` to IDLE with no continuation (the case the crate called `unreachable!`)
        OkWithoutContinuation,
        /// an untagged line first, then `tag OK`
        UntaggedThenOk,
        /// an untagged `* NO [ALERT]` inside the EXAMINE answer (a second `unreachable!` of the crate); IDLE itself is fine
        AlertInExamine,
    }

    /// A plain-TCP IMAP server that is correct up to `IDLE`, where it does what `Odd` says. Counts the IDLE commands it got.
    fn fake_server(odd: Odd) -> (std::net::SocketAddr, Arc<std::sync::atomic::AtomicU32>) {
        use std::io::{BufRead, BufReader, Write};
        use std::sync::atomic::Ordering;
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let idles = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let n = idles.clone();
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let n = n.clone();
                std::thread::spawn(move || {
                    let mut w = c.try_clone().unwrap();
                    let mut r = BufReader::new(c);
                    let _ = w.write_all(b"* OK fake ready\r\n");
                    let mut line = String::new();
                    loop {
                        line.clear();
                        if r.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let mut it = line.trim_end().splitn(2, ' ');
                        let (tag, cmd) = (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_uppercase());
                        let reply = if cmd.starts_with("LOGIN") {
                            format!("{tag} OK LOGIN completed\r\n")
                        } else if cmd.starts_with("CAPABILITY") {
                            format!("* CAPABILITY IMAP4rev1 IDLE\r\n{tag} OK done\r\n")
                        } else if cmd.starts_with("EXAMINE") {
                            let alert = if matches!(odd, Odd::AlertInExamine) { "* NO [ALERT] the server is odd today\r\n" } else { "" };
                            format!("{alert}* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n{tag} OK [READ-ONLY] done\r\n")
                        } else if cmd.starts_with("NOOP") {
                            format!("{tag} OK done\r\n")
                        } else if cmd.starts_with("IDLE") {
                            n.fetch_add(1, Ordering::SeqCst);
                            match odd {
                                Odd::No => format!("{tag} NO IDLE is not available now\r\n"),
                                Odd::Bad => format!("{tag} BAD unknown command\r\n"),
                                Odd::Garbage => {
                                    let _ = w.write_all(b"\x00\xff\xfe this is not imap \x01\r\n");
                                    return;
                                }
                                Odd::OkWithoutContinuation => format!("{tag} OK IDLE terminated\r\n"),
                                Odd::UntaggedThenOk => format!("* 1 EXISTS\r\n{tag} OK IDLE terminated\r\n"),
                                Odd::AlertInExamine => "+ idling\r\n".to_string(),
                            }
                        } else if cmd.starts_with("DONE") {
                            continue;
                        } else {
                            format!("{tag} BAD unexpected\r\n")
                        };
                        if w.write_all(reply.as_bytes()).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (addr, idles)
    }

    struct OddHost {
        addr: std::net::SocketAddr,
        log: Mutex<Vec<String>>,
        states: Mutex<Vec<Push>>,
    }

    impl Host for OddHost {
        fn account(&self) -> R<(Account, String)> {
            let a = Account {
                id: "odd".into(), email: "x@example.test".into(), display_name: "X".into(), imap_host: "127.0.0.1".into(), imap_port: 1, imap_ssl: false,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false,
            };
            Ok((a, "pw".into()))
        }
        fn changed(&self) {}
        fn state(&self, s: Push) {
            self.states.lock().unwrap().push(s);
        }
        fn log(&self, what: &str) {
            self.log.lock().unwrap().push(what.to_string());
        }
        fn plain_addr(&self) -> Option<std::net::SocketAddr> {
            Some(self.addr)
        }
    }

    /// Runs the worker against the odd server for a few seconds with short backoffs. A hard limit makes a stuck worker fail the test.
    fn run_against(odd: Odd) -> (Vec<String>, Vec<Push>, u32) {
        crate::test_guard::within(60, move || run_against_unguarded(odd))
    }

    fn run_against_unguarded(odd: Odd) -> (Vec<String>, Vec<Push>, u32) {
        let (addr, idles) = fake_server(odd);
        let host = Arc::new(OddHost { addr, log: Default::default(), states: Default::default() });
        let sh = Shared::new();
        let t = Timing { backoff: vec![Duration::from_millis(300), Duration::from_millis(300), Duration::from_millis(600)], poll: Duration::from_millis(300), ..Timing::default() };
        let (h2, s2) = (host.clone(), sh.clone());
        let worker = std::thread::spawn(move || run_account(&s2, h2.as_ref(), &t, false));
        // long enough for several attempts; a loaded machine gets up to 10 s to show the first outcome
        std::thread::sleep(Duration::from_millis(2500));
        let first = Instant::now();
        while host.states.lock().unwrap().is_empty() && first.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let t0 = Instant::now();
        sh.stop_now();
        // a panic in the worker (the old crate behaviour) shows here; in a release build it would have ended the process
        worker.join().unwrap_or_else(|_| panic!("the worker panicked on {odd:?}"));
        assert!(t0.elapsed() < Duration::from_secs(3), "stop is quick: {:?} after {odd:?}, log {:?}", t0.elapsed(), host.log.lock().unwrap());
        let (l, s) = (host.log.lock().unwrap().clone(), host.states.lock().unwrap().clone());
        (l, s, idles.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[test]
    fn a_server_that_answers_idle_wrongly_gives_a_logged_failure_a_backoff_and_polling_never_a_panic() {
        for odd in [Odd::No, Odd::Bad, Odd::Garbage, Odd::OkWithoutContinuation, Odd::UntaggedThenOk] {
            let (log, states, idles) = run_against(odd);
            eprintln!("{odd:?}: idle commands {idles}, states {states:?}, log {log:?}");
            assert!(log.iter().any(|l| l.starts_with("reconnect in ")), "{odd:?}: the failure is logged: {log:?}");
            assert!(states.contains(&Push::Polling) && !states.contains(&Push::On), "{odd:?}: falls back to polling: {states:?}");
            // 2.5 s with 0.3 s / 0.3 s / 0.6 s waits: a handful of attempts, not a tight loop
            assert!((2..=6).contains(&idles), "{odd:?}: backs off ({idles} attempts)");
        }
    }

    #[test]
    fn an_untagged_alert_inside_the_examine_answer_does_not_panic_and_idle_goes_on() {
        let (log, states, _) = run_against(Odd::AlertInExamine);
        assert_eq!(states, vec![Push::On], "{log:?}");
        assert!(log.contains(&"push on".to_string()));
    }
}
