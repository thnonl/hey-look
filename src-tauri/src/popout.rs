//! Secondary windows ("pop-outs"): the window manager behind the compose and reader windows that can be moved out of the main
//! window (spec "pop-out windows", phases 0-1; the windows themselves are WP6b / WP6c, this is the foundation).
//!
//! What lives here
//! - the **registry**: which secondary windows exist, their labels (`compose-<n>` / `reader-<n>`, the counter only goes up in a run, so a
//!   label is never reused), at most [`MAX_SECONDARY`] at a time, one window per `key` (a conversation, a draft: asking again focuses
//!   the window that has it), the hand-off data of each window (dropped with it) and its last known place;
//! - the **geometry**: default sizes, the clamp to the work area of a monitor, a saved place that is used only while it is at least half
//!   visible, the cascade for a second window of a kind, all as pure functions of monitors and rectangles (tested below);
//! - the **commands**: `popout_open` / `popout_init` / `popout_ready` / `popout_focus` / `popout_close` / `popout_park` / `popout_destroy` /
//!   `popout_set_key`, and the window events
//!   (`on_window_event` in lib.rs hands every window that is not `main` to [`on_window_event`]).
//!
//! Who owns what (the strategy for the pages; the pages are in `src/popout/`)
//! - The backend and the database are the source of truth for mail, drafts, the outbox and the settings. Every window reads through
//!   commands and refreshes on the broadcast events (`mail-synced`, `outbox-changed`, `calendar-changed`, `prefs-changed`).
//! - The main page is the hub: it is the only writer of the `prefs` blob and the only owner of the intent layer (read / flag / pin),
//!   queued moves with Undo, the Undo-send timer and `sendsInFlight`. A secondary window asks it through the backend; it never writes
//!   `prefs` and never runs the quit, tray or update logic.
//! - Events meant for the main page are sent with `emit_to("main", ..)`, so a secondary window never handles a quit, a tray click or a
//!   toast click. A secondary window has its own JS store (nothing is shared between web views except through the backend).
//!
//! Lifecycle
//! - A window is created hidden (no white flash), with the native title bar, without the HTML5 drop handler of the OS disabled for
//!   the page (`disable_drag_drop_handler`, as the main window: the page handles drops), and shown when its page says it is ready
//!   (`popout_ready`), or after [`READY_WAIT`] at the latest, when it is also reloaded once. Every step is a line of startup.log
//!   (`[popout +ms] compose-1: ready`).
//! - Closing a secondary window never hides to the tray and never quits (lib.rs `on_window_event` looks at the label first). A quit
//!   asks every ready secondary window to answer first (`lib.rs` `flush_targets`, `quitwait::steps`); the extension point for a
//!   window that must save before it closes is [`on_close_requested`].
//! - Size and place are remembered per kind (settings `window.compose` / `window.reader`), written 500 ms after the last move or
//!   resize and when the window is destroyed.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

type R<T> = Result<T, String>;

/// Most secondary windows (all kinds together) open at once (REQ-W6).
pub const MAX_SECONDARY: usize = 8;
/// A window whose page has not said it is ready after this long is shown anyway and reloaded once (REQ-W2).
pub const READY_WAIT: Duration = Duration::from_secs(6);
/// A moved or resized window is written down this long after the last change (REQ-W4).
pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// Move and resize events this soon after a window became ready are the window system settling, not the person.
pub const SETTLE: Duration = Duration::from_millis(400);
/// A page that said it is ready has this long to say that it drew its view; else the window is reloaded once (see [`watch_content`]).
pub const CONTENT_WAIT: Duration = Duration::from_secs(8);
/// Ending a window ([`retire`]): the pause between taking it out of sight and asking for its end (a separate step of the event loop, never
/// inside the page's own call), how often the end is checked, when the end is asked for again, and when the window is given up.
pub const RETIRE_DELAY: Duration = Duration::from_millis(40);
pub const RETIRE_POLL: Duration = Duration::from_millis(50);
pub const RETIRE_AGAIN: Duration = Duration::from_millis(700);
pub const RETIRE_GIVE_UP: Duration = Duration::from_millis(2500);
/// After a window is gone: when its native window is checked and finished by hand, and when the count of windows is logged a second time.
pub const SWEEP_AFTER: Duration = Duration::from_millis(400);
pub const COUNT_AFTER: Duration = Duration::from_secs(3);
/// The offset of a second window of a kind, in logical pixels (REQ-W5).
pub const CASCADE: i32 = 28;
/// Event to a secondary window: save what you hold and answer (the secondary counterpart of the main page's `flush-sends`).
pub const FLUSH_EVENT: &str = "popout-flush";
/// Event to every window: the `prefs` blob changed (`{ writer: <label> }`); the main page is the only writer, the others re-read it.
pub const PREFS_EVENT: &str = "prefs-changed";

// ---------------------------------------------------------------- kinds

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Compose,
    Reader,
    /// A calendar event in a window of its own (W4.6): the key is the event id, a new event has none.
    Event,
    /// Settings in a window of its own (W4.6): one at a time.
    Settings,
    /// The results of a search in a window of its own (W4.6): the key is the normalised search.
    Search,
    /// The Scheduled list in a window of its own (W4.6): one at a time.
    Scheduled,
}

/// Every kind of window, in the order of `Kind::index` (the tests walk it).
#[cfg(test)]
pub const KINDS: [Kind; 6] = [Kind::Compose, Kind::Reader, Kind::Event, Kind::Settings, Kind::Search, Kind::Scheduled];

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "compose" => Some(Kind::Compose),
            "reader" => Some(Kind::Reader),
            "event" => Some(Kind::Event),
            "settings" => Some(Kind::Settings),
            "search" => Some(Kind::Search),
            "scheduled" => Some(Kind::Scheduled),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Compose => "compose",
            Kind::Reader => "reader",
            Kind::Event => "event",
            Kind::Settings => "settings",
            Kind::Search => "search",
            Kind::Scheduled => "scheduled",
        }
    }

    /// Does the PAGE of this kind decide what a close request means (it may ask a question first and ends the window itself)? A compose window with text
    /// asks Save / Discard; an event window with changes asks the discard question (REQ-4.6.7). The other kinds close at once, like a reader.
    pub fn page_decides_close(self) -> bool {
        matches!(self, Kind::Compose | Kind::Event)
    }

    /// The key of a kind of which only one window exists (Settings, the Scheduled list): asking again focuses it (REQ-4.6.8, 4.6.17).
    pub fn single_key(self) -> Option<&'static str> {
        match self {
            Kind::Settings => Some("settings"),
            Kind::Scheduled => Some("scheduled"),
            _ => None,
        }
    }

    fn index(self) -> usize {
        self as usize
    }

    /// The setting that remembers size and place of this kind (not in `prefs`: only the main page writes that).
    pub fn setting_key(self) -> &'static str {
        match self {
            Kind::Compose => "window.compose",
            Kind::Reader => "window.reader",
            Kind::Event => "window.event",
            Kind::Settings => "window.settings",
            Kind::Search => "window.search",
            Kind::Scheduled => "window.scheduled",
        }
    }

    /// Default size, logical pixels, outer (frame and title bar included; REQ-W3).
    pub fn default_size(self) -> (f64, f64) {
        match self {
            // fix48 (owner): the message and reader windows open taller so more of the message shows; the 90 % cap of `place` still protects small screens
            Kind::Compose => (960.0, 920.0),
            Kind::Reader => (1040.0, 960.0),
            Kind::Event => (760.0, 780.0),
            Kind::Settings => (1040.0, 760.0),
            Kind::Search => (960.0, 780.0),
            Kind::Scheduled => (860.0, 700.0),
        }
    }

    /// Smallest size, logical pixels (REQ-W3).
    pub fn min_size(self) -> (f64, f64) {
        match self {
            Kind::Compose => (560.0, 440.0),
            Kind::Reader => (520.0, 400.0),
            Kind::Event => (480.0, 480.0),
            Kind::Settings => (720.0, 500.0),
            Kind::Search => (520.0, 400.0),
            Kind::Scheduled => (520.0, 400.0),
        }
    }
}

/// The kind a window label belongs to: `compose-3` is a compose window, `main` and anything else is not a secondary window.
pub fn kind_of_label(label: &str) -> Option<Kind> {
    let (prefix, n) = label.split_once('-')?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Kind::parse(prefix)
}

/// Is the window on its way out (its close was asked for or its end is being checked)? A poll that walks the windows (wintheme.rs) leaves such a window alone.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_retiring(app: &AppHandle, label: &str) -> bool {
    reg(app).get(label).is_some_and(|e| e.retiring)
}

/// Is this window label a secondary window (not `main`)?
pub fn is_secondary(label: &str) -> bool {
    kind_of_label(label).is_some()
}

// ---------------------------------------------------------------- geometry (pure)

/// A rectangle in physical pixels of the virtual desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w
    }

    fn bottom(&self) -> i32 {
        self.y + self.h
    }

    fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    fn area(&self) -> i64 {
        self.w.max(0) as i64 * self.h.max(0) as i64
    }

    fn overlap(&self, o: &Rect) -> i64 {
        let w = (self.right().min(o.right()) - self.x.max(o.x)).max(0) as i64;
        let h = (self.bottom().min(o.bottom()) - self.y.max(o.y)).max(0) as i64;
        w * h
    }

    /// Differs by more than `tol` pixels in any of position and size (the window system rounds frames and DPI by a pixel or two).
    pub fn differs(&self, o: &Rect, tol: i32) -> bool {
        (self.x - o.x).abs() > tol || (self.y - o.y).abs() > tol || (self.w - o.w).abs() > tol || (self.h - o.h).abs() > tol
    }

    fn contains(&self, o: &Rect) -> bool {
        o.x >= self.x && o.y >= self.y && o.right() <= self.right() && o.bottom() <= self.bottom()
    }

    fn contains_point(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.0 < self.right() && p.1 >= self.y && p.1 < self.bottom()
    }
}

/// A monitor: its work area (without the taskbar) in physical pixels and its scale factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mon {
    pub work: Rect,
    pub scale: f64,
    pub primary: bool,
}

/// What is written to the setting of a kind: the outer position in physical pixels, the OUTER size (frame and title bar included) in logical
/// pixels (so that it means the same on a monitor with another scale), and whether the window was maximized.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// Where and how large a new window opens. `rect` is the OUTER rectangle in physical pixels (the sizes of `Kind` are outer sizes too);
/// `None` = no monitor is known, the system places it (and `size` is the logical size to ask for).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub rect: Option<Rect>,
    pub size: (f64, f64),
    pub maximized: bool,
}

/// The share of the work area a default size may use (REQ-W3: the 1620 x 648 display gets at most 583 px height).
const DEFAULT_SHARE: f64 = 0.9;
/// A saved place is used when at least this much of the window is on a connected monitor (REQ-W5).
const VISIBLE_SHARE: f64 = 0.5;

fn phys(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

/// The monitor a rectangle is mostly on; the one that holds its center when none overlaps; None when there is no monitor.
fn monitor_of<'a>(mons: &'a [Mon], r: &Rect) -> Option<&'a Mon> {
    mons.iter()
        .filter(|m| r.overlap(&m.work) > 0)
        .max_by_key(|m| r.overlap(&m.work))
        .or_else(|| mons.iter().find(|m| m.work.contains_point(r.center())))
}

fn primary_of(mons: &[Mon]) -> Option<&Mon> {
    mons.iter().find(|m| m.primary).or_else(|| mons.first())
}

/// Shift (never resize) a rectangle so that it lies inside the work area; if it is larger than the area it is aligned to the top left.
fn clamp_into(r: Rect, work: &Rect) -> Rect {
    let x = if r.w >= work.w { work.x } else { r.x.clamp(work.x, work.right() - r.w) };
    let y = if r.h >= work.h { work.y } else { r.y.clamp(work.y, work.bottom() - r.h) };
    Rect { x, y, ..r }
}

/// Size in physical pixels: the logical `want` on this monitor, never below `min` (when the area allows it) and never above `share` of the area.
fn size_on(m: &Mon, want: (f64, f64), min: (f64, f64), share: f64) -> (i32, i32) {
    let fit = |want: f64, min: f64, area: i32| {
        let cap = ((area as f64) * share).floor() as i32;
        phys(want, m.scale).max(phys(min, m.scale)).min(cap.max(1))
    };
    (fit(want.0, min.0, m.work.w), fit(want.1, min.1, m.work.h))
}

/// Where a window of `kind` opens (REQ-W3, W5). In order of preference:
/// 1. `cascade_from` (the window of the same kind opened last, which is still open): +28 px right and down; when that would leave the
///    work area it starts again at the place it would have had without the cascade (`base`);
/// 2. the `saved` place, while at least half of it is on a connected monitor (clamped into that work area);
/// 3. centred over `main` (when it is on screen), else over the primary monitor.
pub fn place(kind: Kind, saved: Option<&Saved>, mons: &[Mon], main: Option<Rect>, cascade_from: Option<Rect>) -> Placement {
    let default = kind.default_size();
    let min = kind.min_size();
    let size_of = |m: &Mon| match saved {
        // a size the person chose is kept up to the whole work area
        Some(s) if s.w >= 1.0 && s.h >= 1.0 => size_on(m, (s.w, s.h), min, 1.0),
        _ => size_on(m, default, min, DEFAULT_SHARE),
    };
    let maximized = saved.is_some_and(|s| s.maximized);
    let Some(fallback) = primary_of(mons) else {
        return Placement { rect: None, size: saved.map(|s| (s.w, s.h)).unwrap_or(default), maximized };
    };

    // the place without the cascade
    let base = (|| {
        if let Some(s) = saved {
            let m = monitor_of(mons, &Rect { x: s.x, y: s.y, w: 1, h: 1 }).or_else(|| {
                // the saved corner may be off every monitor while part of the window is on one: look at the whole rectangle
                let guess = Rect { x: s.x, y: s.y, w: phys(s.w, fallback.scale), h: phys(s.h, fallback.scale) };
                monitor_of(mons, &guess)
            });
            if let Some(m) = m {
                let (w, h) = size_of(m);
                let r = Rect { x: s.x, y: s.y, w, h };
                let seen: i64 = mons.iter().map(|mm| r.overlap(&mm.work)).sum();
                if r.area() > 0 && (seen as f64) >= VISIBLE_SHARE * r.area() as f64 {
                    return clamp_into(r, &m.work);
                }
            }
        }
        // centred over the main window when it is on screen, else over the primary monitor
        let m = main.and_then(|r| monitor_of(mons, &r)).unwrap_or(fallback);
        let (w, h) = size_of(m);
        let (cx, cy) = match main {
            Some(r) if monitor_of(mons, &r).is_some() => r.center(),
            _ => m.work.center(),
        };
        clamp_into(Rect { x: cx - w / 2, y: cy - h / 2, w, h }, &m.work)
    })();

    let rect = match cascade_from {
        Some(last) => {
            let m = monitor_of(mons, &last).unwrap_or(fallback);
            let step = phys(CASCADE as f64, m.scale);
            let next = Rect { x: last.x + step, y: last.y + step, w: base.w, h: base.h };
            if m.work.contains(&next) { next } else { base }
        }
        None => base,
    };
    Placement { rect: Some(rect), size: (rect.w as f64 / fallback_scale(mons, &rect), rect.h as f64 / fallback_scale(mons, &rect)), maximized }
}

fn fallback_scale(mons: &[Mon], r: &Rect) -> f64 {
    monitor_of(mons, r).or_else(|| primary_of(mons)).map(|m| m.scale).filter(|s| *s > 0.0).unwrap_or(1.0)
}

// ---------------------------------------------------------------- registry (pure)

#[derive(Clone, Debug)]
pub struct Entry {
    pub label: String,
    pub kind: Kind,
    /// What the window shows, when one thing may be open once only (a reply to a message, a draft): the keys it answers to. The key it was opened
    /// with stays until the window ends (a reply window answers to `re:<id>` after its first save too, W2.12); a save adds the key of the draft it made
    /// (`set_key`). Empty = no such rule (a new message that was never saved). A key is held by one window of the kind only.
    pub keys: Vec<String>,
    /// Opaque token in the page address; the page quotes it in `popout_init`.
    pub token: String,
    /// The page said it is ready (`popout_ready`): it listens to the quit request now.
    pub ready: bool,
    /// When it said so. The events that follow the creation of a window (it is sized, placed and shown after it was built) are not the
    /// person moving it: they are ignored until [`SETTLE`] after this.
    pub ready_at: Option<std::time::Instant>,
    /// Data for the page (a compose body, attachments): kept here and not in the address, dropped with the window.
    pub init: Option<Value>,
    /// The last known normal (not maximized, not minimized) outer rectangle, physical pixels, and its scale factor.
    pub rect: Option<Rect>,
    pub scale: f64,
    pub maximized: bool,
    /// Counts the real changes of place and size; the write 500 ms later happens only when nothing came after it.
    pub moves: u64,
    /// The person moved, resized or maximized this window after it opened: only then is its place worth remembering (the place it
    /// was given, the default or a cascade step, is not "where the person likes it").
    pub dirty: bool,
    /// The window is on its way out ([`retire`]): it is never shown, never asked to answer a quit, does not count, and its key is free.
    pub retiring: bool,
    /// The page drew its view and said so (`popout_note("content", ..)`). A page that says it is ready but never draws is reloaded once.
    pub content: bool,
    /// How many times the process of this window's page died (W4.2): the first death reloads the window, the second ends it.
    pub deaths: u32,
    /// A compose window: the id of the crash snapshot of the message it holds (the page tells it: `popout_note("recovery", id)`; a message handed over
    /// with a snapshot id of its own keeps that one). A reloaded window shows the message of this snapshot again, and a window ended for its second
    /// death has its snapshot saved to Drafts by the main window (W4.2).
    pub recovery_id: Option<String>,
}

/// The key of a saved draft (`draft:<conversation>`, made by `draftKey` in `src/popout/entry.ts`): a window holds one of these at a time.
fn is_draft_key(k: &str) -> bool {
    k.starts_with("draft:")
}

/// What `show` decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Show {
    /// The window shows the new thing now: its key and its hand-off data are the new ones.
    Shown,
    /// Another window of the kind has that key: it is brought forward and this window stays as it is.
    Focus { label: String },
    /// No such window, or it is on its way out.
    Unknown,
}

/// What `request` decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    /// Create this window.
    Create { label: String },
    /// A window with this key exists: focus it.
    Focus { label: String },
    /// [`MAX_SECONDARY`] windows are open.
    TooMany,
}

#[derive(Default)]
pub struct Registry {
    /// Next number per kind; only ever goes up, so a label is never reused in a run.
    next: [u32; 6],
    pub entries: Vec<Entry>,
}

impl Registry {
    /// Ask for a window. A key that is open already focuses that window (also when the cap is reached); otherwise the cap decides.
    /// A created window is registered at once, so two requests at the same time cannot both pass the cap.
    pub fn request(&mut self, kind: Kind, key: Option<&str>, token: String, init: Option<Value>) -> Request {
        if let Some(k) = key {
            if let Some(e) = self.entries.iter().find(|e| e.kind == kind && !e.retiring && e.keys.iter().any(|x| x == k)) {
                return Request::Focus { label: e.label.clone() };
            }
        }
        // a window that is on its way out (its close was asked for, its end is being checked) does not count: the person who closed it and opens another must not be told "too many"
        // because a window system is slow to let go (D-094: Settings, a search and the Scheduled list did not open after a run of closed windows)
        if self.entries.iter().filter(|e| !e.retiring).count() >= MAX_SECONDARY {
            return Request::TooMany;
        }
        self.next[kind.index()] += 1;
        let label = format!("{}-{}", kind.name(), self.next[kind.index()]);
        self.entries.push(Entry {
            label: label.clone(),
            kind,
            keys: key.map(String::from).into_iter().collect(),
            token,
            ready: false,
            ready_at: None,
            init,
            rect: None,
            scale: 1.0,
            maximized: false,
            moves: 0,
            dirty: false,
            retiring: false,
            content: false,
            deaths: 0,
            recovery_id: None,
        });
        Request::Create { label }
    }

    pub fn get(&self, label: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.label == label)
    }

    pub fn get_mut(&mut self, label: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.label == label)
    }

    /// Forget a window (destroyed, or it could not be created). Returns it, with its hand-off data.
    pub fn remove(&mut self, label: &str) -> Option<Entry> {
        let i = self.entries.iter().position(|e| e.label == label)?;
        Some(self.entries.remove(i))
    }

    /// The rectangle of the window of `kind` opened last that is still open, leaving out `except` (the one being made): a new window of
    /// the kind cascades from it.
    pub fn newest_rect(&self, kind: Kind, except: &str) -> Option<Rect> {
        self.entries.iter().rev().find(|e| e.kind == kind && e.label != except).and_then(|e| e.rect)
    }

    /// Labels of the windows whose page is ready, oldest first: the ones a quit asks.
    pub fn ready_labels(&self) -> Vec<String> {
        self.entries.iter().filter(|e| e.ready && !e.retiring).map(|e| e.label.clone()).collect()
    }

    /// May this window be put on screen now? Not when it is on its way out, and not before its page said it is ready (or the wait for that
    /// ran out): a window shown early is a blank white window, which is what a second "open" of a key whose window was still being created
    /// used to do.
    pub fn may_show(&self, label: &str) -> bool {
        self.get(label).is_some_and(|e| !e.retiring && (e.ready || e.ready_at.is_some()))
    }

    /// Mark a window as on its way out and free its key. `None`: not known. `Some(true)`: this call started it; `Some(false)`: it was already.
    pub fn start_retire(&mut self, label: &str) -> Option<bool> {
        let e = self.get_mut(label)?;
        let first = !e.retiring;
        e.retiring = true;
        e.keys.clear();
        Some(first)
    }

    /// The window of `kind` that shows `key`, if any.
    pub fn find_key(&self, kind: Kind, key: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.kind == kind && e.keys.iter().any(|x| x == key))
    }

    /// A reader window goes on to show another conversation (Next / Previous, W4.4): its key and its hand-off data become the new conversation's, so a
    /// second open of that conversation focuses this window and a reload of the page (W4.2) shows what the window shows now. Refused (`Focus`) when another
    /// window of the kind has the key: that window is the one to bring forward.
    pub fn show(&mut self, label: &str, key: &str, init: Value) -> Show {
        let Some(kind) = self.get(label).filter(|e| !e.retiring).map(|e| e.kind) else { return Show::Unknown };
        if let Some(other) = self.entries.iter().find(|e| e.kind == kind && e.label != label && !e.retiring && e.keys.iter().any(|x| x == key)) {
            return Show::Focus { label: other.label.clone() };
        }
        if let Some(e) = self.get_mut(label) {
            e.keys = vec![key.to_string()];
            e.init = Some(init);
        }
        Show::Shown
    }

    /// Change what a window shows. `Some(key)`: the window also answers to `key` now (a save made a draft of it). The key it was opened with stays
    /// (a reply window keeps `re:<id>`, so a second Reply on the mail focuses it after a save, W2.12); only a key of another draft is given up (a window
    /// holds one draft at a time: the draft a save replaced is gone). `None`: the window shows nothing any more (parked, on its way out) and frees all its
    /// keys. False when the window is not known, or another window of the kind already has that key (the caller keeps what it had; the lock of a draft
    /// is not given to two windows).
    pub fn set_key(&mut self, label: &str, key: Option<String>) -> bool {
        let Some(kind) = self.get(label).map(|e| e.kind) else { return false };
        let Some(k) = key else {
            if let Some(e) = self.get_mut(label) {
                e.keys.clear();
            }
            return true;
        };
        if self.entries.iter().any(|e| e.kind == kind && e.label != label && e.keys.iter().any(|x| *x == k)) {
            return false;
        }
        match self.get_mut(label) {
            Some(e) => {
                if is_draft_key(&k) {
                    e.keys.retain(|x| !is_draft_key(x));
                }
                if !e.keys.contains(&k) {
                    e.keys.push(k);
                }
                true
            }
            None => false,
        }
    }

    /// How many windows of `kind` exist (every state: shown, parked, not ready yet; not the ones on their way out: the person ended those).
    pub fn count(&self, kind: Kind) -> usize {
        self.entries.iter().filter(|e| e.kind == kind && !e.retiring).count()
    }
}

// ---------------------------------------------------------------- state and the window system

pub struct State {
    pub reg: Mutex<Registry>,
}

impl Default for State {
    fn default() -> Self {
        State { reg: Mutex::new(Registry::default()) }
    }
}

fn reg(app: &AppHandle) -> std::sync::MutexGuard<'_, Registry> {
    app.state::<State>().inner().reg.lock().unwrap_or_else(|p| p.into_inner())
}

/// Tokens in the page address: opaque, unguessable enough for "this is the page that this window was made for" (REQ-S3).
fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn log(what: &str) {
    crate::startup::line("popout", what);
}

/// Labels of the secondary windows that exist and whose page is ready (what a quit has to ask).
pub fn ready_labels(app: &AppHandle) -> Vec<String> {
    let labels = reg(app).ready_labels();
    labels.into_iter().filter(|l| app.get_webview_window(l).is_some()).collect()
}

/// The conversations the reader windows show (their keys, W6.3): a prune that lowers the download limit keeps them.
pub fn reader_keys(app: &AppHandle) -> Vec<String> {
    reg(app).entries.iter().filter(|e| e.kind == Kind::Reader).flat_map(|e| e.keys.iter().cloned()).collect()
}

/// Bring a secondary window to the front (also from the tray or minimized).
pub fn bring_to_front(app: &AppHandle, label: &str) {
    // a window that is on its way out, or whose page is not up yet, is not put on screen (a window shown early is a blank white one; the page
    // shows it itself when it is ready)
    if !reg(app).may_show(label) {
        log(&format!("{label}: not brought to the front (not ready yet, or on its way out)"));
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Is this secondary window on screen (shown and not minimized)?
pub fn is_shown(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label).is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

/// Is any secondary window focused and on screen? For "the app is in front": no desktop toast then (REQ-W13).
pub fn any_in_front(app: &AppHandle) -> bool {
    app.webview_windows().iter().any(|(label, w)| {
        is_secondary(label) && w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
    })
}

/// Set the same taskbar overlay badge on every secondary window (Windows), so the taskbar group shows it whichever window was active last (REQ-W14).
#[cfg(windows)]
pub fn set_overlay(app: &AppHandle, icon: Option<tauri::image::Image<'static>>) {
    for (label, w) in app.webview_windows() {
        if is_secondary(&label) {
            let _ = w.set_overlay_icon(icon.clone());
        }
    }
}

fn monitors(app: &AppHandle) -> Vec<Mon> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            Mon {
                work: Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 },
                scale: m.scale_factor(),
                primary: primary == Some(*m.position()),
            }
        })
        .collect()
}

/// The outer rectangle of the main window when it is on screen (shown, not minimized).
fn main_rect(app: &AppHandle) -> Option<Rect> {
    let w = app.get_webview_window("main")?;
    if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return None;
    }
    let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
    Some(Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 })
}

fn load_saved(app: &AppHandle, kind: Kind) -> Option<Saved> {
    let db = app.state::<crate::AppState>().db.clone();
    let raw = crate::db::get_setting(&crate::lock(&db), kind.setting_key())?;
    serde_json::from_str(&raw).ok()
}

fn store_saved(app: &AppHandle, kind: Kind, saved: &Saved) {
    let db = app.state::<crate::AppState>().db.clone();
    if let Ok(raw) = serde_json::to_string(saved) {
        let _ = crate::db::set_setting(&crate::lock(&db), kind.setting_key(), &raw);
    }
}

/// What `popout_open` answers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// "created" | "focused" | "tooMany" | "none" (only for `focus_only`: no window has the key)
    pub status: &'static str,
    pub label: Option<String>,
}

/// Open a window of `kind`, or focus the one that has `key`. Must not run on the main thread of the window system on Windows
/// (creating a window waits for it): the command is async. `focus_only`: never create; focus the window that has `key` or answer "none"
/// (an inline editor asks this before it opens a draft: a draft is open in one editor only).
pub fn open(app: &AppHandle, from: &str, kind: Kind, key: Option<String>, init: Option<Value>, focus_only: bool) -> R<Opened> {
    // (what was asked, by whom: the next log tells a reader window from a compose window and which gesture asked twice; the key is an opaque id)
    log(&format!("open requested by {from}: {} key={} {}", kind.name(), key.as_deref().unwrap_or("-"), if focus_only { "(focus only)" } else { "" }));
    if focus_only {
        let found = key.as_deref().and_then(|k| reg(app).find_key(kind, k).map(|e| e.label.clone()));
        return Ok(match found {
            Some(label) => {
                log(&format!("{label}: asked for again, focused"));
                bring_to_front(app, &label);
                Opened { status: "focused", label: Some(label) }
            }
            None => Opened { status: "none", label: None },
        });
    }
    // (a message handed over with the id of its snapshot keeps that id: the reloaded window finds the snapshot under it, W4.2)
    // (asked for again with new data: Settings is brought to the tab that is asked for, `popout-refocus`)
    let refocus = if kind == Kind::Settings { init.clone() } else { None };
    let handed_recovery = init.as_ref().and_then(|i| i.get("recoveryId")).and_then(Value::as_str).filter(|id| is_recovery_id(id)).map(String::from);
    // (the cascade and the placement are decided together with the registration, under one lock)
    let token = new_token();
    let (label, cascade) = {
        let mut r = reg(app);
        match r.request(kind, key.as_deref(), token.clone(), init) {
            Request::Focus { label } => {
                drop(r);
                log(&format!("{label}: asked for again, focused"));
                bring_to_front(app, &label);
                if let Some(i) = refocus {
                    let _ = app.emit_to(label.as_str(), REFOCUS_EVENT, i);
                }
                return Ok(Opened { status: "focused", label: Some(label) });
            }
            Request::TooMany => {
                drop(r);
                log(&format!("a {} window was asked for with {MAX_SECONDARY} open: refused", kind.name()));
                return Ok(Opened { status: "tooMany", label: None });
            }
            Request::Create { label } => {
                let before = r.newest_rect(kind, &label);
                if let Some(e) = r.get_mut(&label) {
                    e.recovery_id = handed_recovery;
                }
                (label, before)
            }
        }
    };
    match create(app, kind, &label, &token, cascade) {
        Ok(()) => {
            log(&format!("{label}: {} window created for key {}", kind.name(), key.as_deref().unwrap_or("-")));
            announce_counts(app);
            Ok(Opened { status: "created", label: Some(label) })
        }
        Err(e) => {
            reg(app).remove(&label);
            log(&format!("{label}: could not be created: {e}{}", creation_hint(&e)));
            Err(e)
        }
    }
}

/// What the log adds to a window that could not be created. "failed to send message to the webview" is not about this window: the event loop of the app
/// takes no messages, so every window call fails from then on (a new window, hiding or ending one) until the app is started again. On Windows the loop
/// listens at an internal window of the class "Tao Thread Event Target"; that window is listed among the top-level windows of the process, and a tool that
/// posts WM_CLOSE to every one of them (the 1.0.7 WP2a QA helper did) destroys it. Nothing in the app does that, and a retry cannot help: the line says so,
/// so a log is not read as a fault of the window that was asked for (QA BUG-1: the same on 1.0.6, with the same helper).
fn creation_hint(e: &str) -> &'static str {
    if e.contains("failed to send message to the webview") {
        " (the event loop of the app takes no messages: its internal window is gone, e.g. WM_CLOSE sent to every window of the process; no window can be opened until the app is started again)"
    } else {
        ""
    }
}

fn create(app: &AppHandle, kind: Kind, label: &str, token: &str, cascade: Option<Rect>) -> R<()> {
    let mons = monitors(app);
    let placement = place(kind, load_saved(app, kind).as_ref(), &mons, main_rect(app), cascade);
    let (min_w, min_h) = kind.min_size();
    let url = WebviewUrl::App(format!("index.html?w={}&t={token}", kind.name()).into());
    let mut b = WebviewWindowBuilder::new(app, label, url)
        .title("Hey Look!")
        .inner_size(placement.size.0, placement.size.1)
        .min_inner_size(min_w, min_h)
        .resizable(true)
        .decorations(true)
        .visible(false)
        // the colour of the theme from the first frame, not the white of the web view (bgcolor.rs)
        .background_color(crate::bgcolor::for_new_window(app));
    // macOS (D-097): the page starts BELOW the title bar, never under the three window buttons. tauri's default style (Visible) makes the content view run under the title bar
    // (NSWindowStyleMaskFullSizeContentView) and D-063 makes the bar transparent, so the page headers lay under the buttons: Transparent keeps the bar transparent (the window's
    // background colour shows, D-063) without the full-size content view. The main window has the same in tauri.conf.json; macwin.rs `set_one` takes the flag away from any window.
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Transparent);
    }
    // the page handles file drops itself (HTML5 drop in the compose window), like the main window
    b = b.disable_drag_drop_handler();
    // (a QA build has no inspector, see identity.rs devtools_off)
    if crate::identity::devtools_off() {
        b = b.devtools(false);
    }
    let win = b.build().map_err(|e| e.to_string())?;
    native_hold(&win, label);
    // a death of the page process of this window is answered here, not by the main window's hook (W4.2)
    watch_page_process(app, &win, label);
    // the title bar has the theme the setting asks of it (never one fixed here: System = follow the OS), wintheme.rs
    crate::wintheme::apply_all(app, &format!("{label} created"));
    if let Some(r) = placement.rect {
        // the placement is the OUTER rectangle (frame and title bar included: what the person sees, and what is remembered); the window API sets
        // the inner size, so the frame of this window is taken off (restoring an outer size as an inner one made a window grow at every open)
        let (fw, fh) = match (win.outer_size(), win.inner_size()) {
            (Ok(o), Ok(i)) => ((o.width as i32 - i.width as i32).max(0), (o.height as i32 - i.height as i32).max(0)),
            _ => (0, 0),
        };
        let _ = win.set_size(tauri::PhysicalSize::new((r.w - fw).max(1) as u32, (r.h - fh).max(1) as u32));
        let _ = win.set_position(tauri::PhysicalPosition::new(r.x, r.y));
        let scale = fallback_scale(&mons, &r);
        if let Some(e) = reg(app).get_mut(label) {
            e.rect = Some(r);
            e.scale = scale;
        }
    }
    if placement.maximized {
        let _ = win.maximize();
    }
    log(&format!("{label}: created hidden ({} x {} logical)", placement.size.0.round(), placement.size.1.round()));
    watch_ready(app.clone(), label.to_string());
    Ok(())
}

/// After [`READY_WAIT`] a window that did not report itself is shown and reloaded once (REQ-W2). A window that was ended meanwhile is
/// left alone: it must not be put on screen again.
fn watch_ready(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        std::thread::sleep(READY_WAIT);
        let ready = match reg(&app).get(&label) {
            Some(e) if e.retiring => return, // on its way out
            Some(e) => e.ready,
            None => return, // closed meanwhile
        };
        if ready {
            return;
        }
        let Some(w) = app.get_webview_window(&label) else { return };
        if let Some(e) = reg(&app).get_mut(&label) {
            e.ready_at.get_or_insert_with(std::time::Instant::now);
        }
        log(&format!("{label}: shown without signal, reloaded"));
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.reload();
    });
}

/// After a window said it is ready, its page has [`CONTENT_WAIT`] to say that it drew something. A web view whose content process died or
/// whose script stopped is a white window that answers nothing: it is logged and reloaded once, and the log says if that did not help.
fn watch_content(app: AppHandle, label: String, reloaded: bool) {
    std::thread::spawn(move || {
        std::thread::sleep(CONTENT_WAIT);
        let drawn = match reg(&app).get(&label) {
            Some(e) if e.retiring => return,
            Some(e) => e.content,
            None => return,
        };
        if drawn {
            return;
        }
        if reloaded {
            log(&format!("{label}: still no content {} s after the reload", CONTENT_WAIT.as_secs()));
            return;
        }
        let Some(w) = app.get_webview_window(&label) else { return };
        log(&format!("{label}: ready but no content after {} s: reloading once", CONTENT_WAIT.as_secs()));
        let _ = w.reload();
        watch_content(app, label, true);
    });
}

// ---------------------------------------------------------------- a window whose page process dies (W4.2, REQ-W16)

/// Event to `main` only: a window was ended because its page process died twice, `{ label, kind, recoveryId }`. The main page says so in a toast and, for a
/// compose window, saves the latest snapshot of its message to Drafts at once.
pub const CRASHED_EVENT: &str = "popout-crashed";

/// What a window does about a failure of a process of its web view (REQ-4.2.2).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PageFailure {
    /// Not this window's business: the browser process of the whole web view is gone, the main window's hook restarts the app (no double handling).
    Ignore,
    /// Written to the log only (unresponsive, GPU, utility ... the runtime starts its own helpers again).
    LogOnly,
    /// The page process died for the first time in the life of this window: load the page again.
    Reload,
    /// It died again: the window is ended and the person is told.
    Close,
}

/// The reaction to a failure. `kind` is `COREWEBVIEW2_PROCESS_FAILED_KIND` (Linux maps "web process terminated" to 1, a render process that exited);
/// `deaths_before` how many times the page process of this window died earlier. Pure; the same on every system.
pub fn popout_failure(kind: i32, deaths_before: u32) -> PageFailure {
    match kind {
        0 => PageFailure::Ignore,
        1 | 3 if deaths_before == 0 => PageFailure::Reload,
        1 | 3 => PageFailure::Close,
        _ => PageFailure::LogOnly,
    }
}

/// A crash snapshot id as Compose makes it (a UUID); nothing else is taken as an id from a page.
fn is_recovery_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A process of a secondary window's web view failed (called by the hooks of `webview_health` on Windows and `linuxview` on Linux; macOS has no hook:
/// wry owns the navigation delegate, `watch_content` is the net there). Every failure is a line of the log; a dead page process reloads the window once and
/// ends it the second time.
pub fn page_failed(app: &AppHandle, label: &str, kind: i32, detail: &str) {
    if crate::startup::is_exiting() {
        return; // the app is closing: the processes of its web views end on purpose
    }
    log(&format!("{label}: web view: {}{}", crate::webview_health::kind_name(kind), if detail.is_empty() { String::new() } else { format!(" ({detail})") }));
    let (action, kind_of_window, recovery) = {
        let mut r = reg(app);
        let Some(e) = r.get_mut(label) else { return };
        if e.retiring {
            return; // on its way out: its processes end by themselves
        }
        let action = popout_failure(kind, e.deaths);
        if action == PageFailure::Reload {
            // the page that is loading is not ready: a quit does not ask it, and it shows nothing yet
            e.deaths += 1;
            e.ready = false;
            e.content = false;
        }
        (action, e.kind, e.recovery_id.clone())
    };
    match action {
        PageFailure::Ignore | PageFailure::LogOnly => {}
        PageFailure::Reload => {
            log(&format!("{label}: page process died: reloading"));
            let (app, label) = (app.clone(), label.to_string());
            // (not inside the callback of the web view that reported it; the runtime needs a moment to start a new page process)
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.reload();
                }
                watch_ready(app, label);
            });
        }
        PageFailure::Close => {
            log(&format!("{label}: page process died again: closed"));
            let _ = app.emit_to("main", CRASHED_EVENT, serde_json::json!({ "label": label, "kind": kind_of_window.name(), "recoveryId": recovery }));
            retire(app, label, "page process died again");
        }
    }
}

/// Listen for the process failures of the web view of window `label`, right after it was built (Windows: WebView2 `ProcessFailed`; Linux:
/// `web-process-terminated`; macOS: nothing, see [`page_failed`]).
fn watch_page_process(app: &AppHandle, win: &tauri::WebviewWindow, label: &str) {
    let _ = (app, win, label);
    #[cfg(windows)]
    crate::webview_health::watch_window(app, win, label);
    #[cfg(target_os = "linux")]
    crate::linuxview::watch_window(app, win, label);
}

/// A page tells the log something (errors of the page, "content" = it drew its view). Only for secondary windows; the text is cut short.
pub fn note(app: &AppHandle, label: &str, kind: &str, text: &str) {
    if kind == "content" {
        if let Some(e) = reg(app).get_mut(label) {
            e.content = true;
        }
    }
    if kind == "recovery" {
        // the id of the crash snapshot of the message this compose window holds (W4.2): not a log line of its own, it is bookkeeping
        if let Some(e) = reg(app).get_mut(label) {
            e.recovery_id = Some(text.chars().take(64).collect()).filter(|id: &String| is_recovery_id(id));
        }
        return;
    }
    let text: String = text.chars().take(600).collect();
    log(&format!("{label}: page says {kind}: {text}"));
}

/// The page of a window is up and listens to the quit request: show the window (REQ-W2).
pub fn mark_ready(app: &AppHandle, label: &str) {
    let (first, show) = {
        let mut r = reg(app);
        match r.get_mut(label) {
            Some(e) => {
                e.ready_at.get_or_insert_with(std::time::Instant::now);
                (!std::mem::replace(&mut e.ready, true), !e.retiring)
            }
            None => return,
        }
    };
    if !show {
        // ended before its page was up (the person closed it, or a second open raced with it): it stays out of sight
        log(&format!("{label}: ready after it was ended: not shown"));
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    if first {
        log(&format!("{label}: ready"));
        watch_content(app.clone(), label.to_string(), false);
        // the taskbar badge of the unread count (Windows) goes on the new window too
        let db = app.state::<crate::AppState>().db.clone();
        crate::shell::update_badge(app, &db);
    }
}

/// Window events of a secondary window. `Moved` / `Resized` keep the place of its kind, `Destroyed` forgets the window.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label().to_string();
    let Some(kind) = kind_of_label(&label) else { return };
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            log(&format!("{label}: close requested ({} window)", kind.name()));
            if !on_close_requested(app, &label) {
                api.prevent_close();
            } else if !kind.page_decides_close() {
                // a window whose page does not ask first (a reader, Settings, a search, the Scheduled list): its close goes through, so it is on its way out from now on
                // (it stops counting, takes no more shows, frees its key)
                if reg(app).start_retire(&label) == Some(true) {
                    announce_counts(app);
                }
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => note_geometry(app, window, &label),
        tauri::WindowEvent::Destroyed => {
            // write the place down now (the debounce may not have run yet), then forget the window and its hand-off data
            // what the window still asked of the AI Assistant is dropped with it (REQ-R12)
            for id in take_ai(&label) {
                crate::ai::cancel(&id);
            }
            let entry = reg(app).remove(&label);
            log(&format!("{label}: destroy done (the Destroyed event came)"));
            if let Some(e) = entry {
                if let Some(s) = saved_of(&e).filter(|_| e.dirty) {
                    store_saved(app, kind, &s);
                }
                log(&format!("{label}: closed"));
                announce_counts(app);
                after_destroyed(app, &label, true);
            }
        }
        _ => {}
    }
}

/// Decide whether a close request goes on on the native side: always (`true`). A compose window with unsaved text is kept open by its
/// PAGE instead: it listens to the close request (`onCloseRequested`), which makes the window system hold the close back until the page
/// has asked the person and ended the window itself (`popout_destroy`) or taken it out of sight (`popout_park`).
fn on_close_requested(_app: &AppHandle, _label: &str) -> bool {
    true
}

/// A window moved or was resized: keep its place and, when it really changed, write it down [`SAVE_DEBOUNCE`] after the last change.
fn note_geometry(app: &AppHandle, window: &tauri::Window, label: &str) {
    let maximized = window.is_maximized().unwrap_or(false);
    let odd = window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);
    let now = match (window.outer_position(), window.outer_size()) {
        (Ok(p), Ok(s)) => Some(Rect { x: p.x, y: p.y, w: s.width as i32, h: s.height as i32 }),
        _ => None,
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let moves = {
        let mut r = reg(app);
        let Some(e) = r.get_mut(label) else { return };
        let settled = e.ready_at.is_some_and(|t| t.elapsed() >= SETTLE);
        if !settled || !apply_geometry(e, now, scale, maximized, odd) {
            return;
        }
        e.moves
    };
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEBOUNCE);
        let saved = {
            let r = reg(&app);
            match r.get(&label) {
                Some(e) if e.moves == moves => saved_of(e).map(|s| (e.kind, s)),
                _ => None,
            }
        };
        if let Some((kind, s)) = saved {
            store_saved(&app, kind, &s);
        }
    });
}

/// What a move / resize event does to the registry entry (pure). Returns true when the change is real, i.e. when it is to be written down.
/// - minimized or full screen: odd rectangles, ignored;
/// - maximized: only the flag is kept, the last normal rectangle stays (it is what restoring gives back);
/// - otherwise the rectangle is taken when it differs from the known one by more than a couple of pixels: the events that follow the
///   creation of the window (it is sized and placed after it was built) change nothing and are not a decision of the person.
pub fn apply_geometry(e: &mut Entry, now: Option<Rect>, scale: f64, maximized: bool, odd: bool) -> bool {
    if odd {
        return false;
    }
    let mut changed = false;
    if e.maximized != maximized {
        e.maximized = maximized;
        changed = true;
    }
    if !maximized {
        if let Some(rect) = now {
            if e.rect.is_none_or(|known| known.differs(&rect, 2)) {
                e.rect = Some(rect);
                e.scale = scale;
                changed = true;
            }
        }
    }
    if changed {
        e.moves += 1;
        e.dirty = true;
    }
    changed
}

/// The state to write down for a window: its last normal rectangle (physical position, logical size) and whether it is maximized.
fn saved_of(e: &Entry) -> Option<Saved> {
    let r = e.rect?;
    if r.w <= 0 || r.h <= 0 {
        return None;
    }
    let s = if e.scale > 0.0 { e.scale } else { 1.0 };
    Some(Saved { x: r.x, y: r.y, w: (r.w as f64 / s).round(), h: (r.h as f64 / s).round(), maximized: e.maximized })
}

// ---------------------------------------------------------------- commands

/// What a page gets at start: who it is and the data its opener left for it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Init {
    pub kind: &'static str,
    pub label: String,
    pub key: Option<String>,
    pub init: Option<Value>,
    /// The page of this window was loaded again after its process died (W4.2): a compose window shows the message of `recovery_id` when the
    /// snapshot exists, else the hand-off data again.
    pub reloaded: bool,
    pub recovery_id: Option<String>,
}

/// Open a secondary window of `kind` ("compose" | "reader"), or focus the one that shows `key`. `init` is kept in the backend for the
/// page (`popout_init`). Answers `{ status: "created" | "focused" | "tooMany", label }`; the 9th window is not an error.
#[tauri::command]
pub async fn popout_open(app: AppHandle, window: tauri::Window, kind: String, key: Option<String>, init: Option<Value>, focus_only: Option<bool>) -> R<Opened> {
    let kind = Kind::parse(&kind).ok_or_else(|| format!("unknown window kind: {kind}"))?;
    // (Settings and the Scheduled list exist once: whoever asks without a key asks for the one window)
    let key = key.filter(|k| !k.is_empty()).or_else(|| kind.single_key().map(String::from));
    open(&app, window.label(), kind, key, init, focus_only.unwrap_or(false))
}

/// The page of a secondary window asks who it is. The token of its address must be the one this window was made with.
#[tauri::command]
pub fn popout_init(app: AppHandle, window: tauri::Window, token: String) -> R<Init> {
    let r = reg(&app);
    let e = r.get(window.label()).ok_or("this is not a secondary window")?;
    if e.token != token {
        return Err("wrong token".into());
    }
    Ok(Init { kind: e.kind.name(), label: e.label.clone(), key: e.keys.first().cloned(), init: e.init.clone(), reloaded: e.deaths > 0, recovery_id: e.recovery_id.clone() })
}

/// The page of a secondary window is up (it listens to the quit request): show the window.
#[tauri::command]
pub fn popout_ready(app: AppHandle, window: tauri::Window) {
    mark_ready(&app, window.label());
}

/// Bring a secondary window to the front.
#[tauri::command]
pub fn popout_focus(app: AppHandle, label: String) -> bool {
    if reg(&app).get(&label).is_none() {
        return false;
    }
    bring_to_front(&app, &label);
    true
}

/// Close a secondary window from outside (the same path as its close button). False when there is no such window.
#[tauri::command]
pub fn popout_close(app: AppHandle, label: String) -> bool {
    if reg(&app).get(&label).is_none() {
        return false;
    }
    match app.get_webview_window(&label) {
        Some(w) => w.close().is_ok(),
        None => false,
    }
}

/// Event to `main`: how many windows of each kind exist now, `{ compose, reader }`. The main page keeps the count (the support reminder does
/// not appear while a compose window is open, REQ-W15). Sent when a window is created and when one is destroyed.
pub const COUNT_EVENT: &str = "popout-count";
/// Event to one window that was asked for again with new data (the Settings window: `{ tab, focus, nonce }` of the dialog that was meant): it goes there (W4.6, REQ-4.6.9).
pub const REFOCUS_EVENT: &str = "popout-refocus";

fn announce_counts(app: &AppHandle) {
    let (compose, reader, settings) = {
        let r = reg(app);
        (r.count(Kind::Compose), r.count(Kind::Reader), r.count(Kind::Settings))
    };
    // (`settings`: while the Settings window exists every way of opening Settings goes to it, W4.6)
    let _ = app.emit_to("main", COUNT_EVENT, serde_json::json!({ "compose": compose, "reader": reader, "settings": settings }));
}

/// The calling window goes out of sight but stays alive: its page still has work to finish (a message in its Undo time, the send under way)
/// and ends the window itself when that is done (`popout_destroy`). The key is freed, so asking for the same draft or reply again opens a
/// new window instead of bringing back one that is on its way out. (The window brings itself back with `popout_focus` if the work fails.)
#[tauri::command]
pub fn popout_park(app: AppHandle, window: tauri::Window) -> bool {
    let label = window.label().to_string();
    if !is_secondary(&label) || !reg(&app).set_key(&label, None) {
        return false;
    }
    log(&format!("{label}: parked (hidden, still running)"));
    window.hide().is_ok()
}

/// A page tells the log something about itself: `kind` "content" (it drew its view), "error" (a script error or an unhandled rejection) or
/// "info" or "strip" (what the top of the page is painted with, the macOS title bar). Only a live secondary window, only about itself.
#[tauri::command]
pub fn popout_note(app: AppHandle, window: tauri::Window, kind: String, text: String) {
    let label = window.label();
    if is_secondary(label) && reg(&app).get(label).is_some() && matches!(kind.as_str(), "content" | "error" | "info" | "strip" | "recovery") {
        note(&app, label, &kind, &text);
    }
}

/// The calling window ends now, without a close request (its page has decided: it was saved, discarded or sent). Only a secondary window,
/// and only itself. The answer is given at once and the window is ended by [`retire`], not inside this call: destroying a window from the
/// IPC call of its own page is the order that is suspected of leaving windows behind on a Mac.
#[tauri::command]
pub fn popout_destroy(app: AppHandle, window: tauri::Window) -> bool {
    let label = window.label().to_string();
    if !is_secondary(&label) || reg(&app).get(&label).is_none() {
        return false;
    }
    retire(&app, &label, "ended by its page")
}

// ---------------------------------------------------------------- the end of a window

/// What the end of a window needs next (pure, so the order of the steps is tested without a window system).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum RetireStep {
    /// the window is gone: verified
    Done,
    /// keep looking
    Wait,
    /// it is still there after [`RETIRE_AGAIN`]: ask for its end once more
    DestroyAgain,
    /// it is still there after [`RETIRE_GIVE_UP`]: forget it (the registry and the counts must not depend on it)
    GiveUp,
}

pub fn retire_step(elapsed: Duration, gone: bool, asked_again: bool) -> RetireStep {
    if gone {
        RetireStep::Done
    } else if elapsed >= RETIRE_GIVE_UP {
        RetireStep::GiveUp
    } else if elapsed >= RETIRE_AGAIN && !asked_again {
        RetireStep::DestroyAgain
    } else {
        RetireStep::Wait
    }
}

/// End a secondary window whatever the order of create / ready / close / end was. In this order, each step in the log:
/// 1. it is marked as on its way out (the registry: its key is free, it does not count, it is never shown or asked to answer a quit);
/// 2. it is taken out of sight (`hide`);
/// 3. after a short pause, on the event loop and not inside the call that asked, its end is asked for (`destroy`);
/// 4. the end is looked for (the window object is gone); if it is still there after a while its end is asked for once more, and after a
///    longer while it is given up and forgotten;
/// 5. when it is gone, [`after_destroyed`] checks what the window system says and finishes the native window by hand (macOS).
///
/// Returns false when there is no such window. Safe to call twice.
pub fn retire(app: &AppHandle, label: &str, why: &str) -> bool {
    let first = match reg(app).start_retire(label) {
        Some(first) => first,
        None => return false,
    };
    if !first {
        log(&format!("{label}: {why}: already on its way out"));
        return true;
    }
    log(&format!("{label}: {why}"));
    announce_counts(app);
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || retire_steps(&app, &label));
    true
}

fn retire_steps(app: &AppHandle, label: &str) {
    let started = std::time::Instant::now();
    match app.get_webview_window(label) {
        Some(w) => match w.hide() {
            Ok(()) => log(&format!("{label}: hidden")),
            Err(e) => log(&format!("{label}: could not be hidden: {e}")),
        },
        None => log(&format!("{label}: no window object any more")),
    }
    std::thread::sleep(RETIRE_DELAY);
    log(&format!("{label}: destroy scheduled"));
    destroy_on_event_loop(app, label);
    let mut asked_again = false;
    loop {
        std::thread::sleep(RETIRE_POLL);
        let gone = app.get_webview_window(label).is_none();
        match retire_step(started.elapsed(), gone, asked_again) {
            RetireStep::Done => {
                log(&format!("{label}: gone (verified) after {} ms", started.elapsed().as_millis()));
                return;
            }
            RetireStep::Wait => {}
            RetireStep::DestroyAgain => {
                asked_again = true;
                log(&format!("{label}: still present: closing again"));
                destroy_on_event_loop(app, label);
            }
            RetireStep::GiveUp => {
                log(&format!("{label}: still present after {} ms: forgotten", started.elapsed().as_millis()));
                for id in take_ai(label) {
                    crate::ai::cancel(&id);
                }
                reg(app).remove(label);
                announce_counts(app);
                after_destroyed(app, label, false);
                return;
            }
        }
    }
}

/// Ask for the end of a window as a task of the event loop (it runs on the main thread, in a step of its own).
fn destroy_on_event_loop(app: &AppHandle, label: &str) {
    let (handle, name) = (app.clone(), label.to_string());
    if let Err(e) = app.run_on_main_thread(move || match handle.get_webview_window(&name) {
        Some(w) => {
            // (the native window is NOT touched before this: tao's `Destroyed` comes from the window's own `windowWillClose:` notification, which AppKit delivers to the delegate through
            // an observer that it registers itself; taking observers or the delegate away first, as fix24 did, left the label in the manager for ever, 1.0.7 round 11a)
            match w.destroy() {
                Ok(()) => log(&format!("{name}: destroy requested")),
                Err(e) => log(&format!("{name}: destroy was refused: {e}")),
            }
        }
        None => log(&format!("{name}: destroy: no window object any more")),
    }) {
        log(&format!("{label}: destroy could not be scheduled: {e}"));
    }
}

/// A window is gone (its `Destroyed` event came, or it was given up): say how many windows the app and the window system still list, now and a
/// little later, and finish its native window by hand (macOS). The lines in the log are the proof that windows are released.
/// `destroyed`: the `Destroyed` event came. A window that was given up while tauri still lists it gets no native step (the teardown is only for a window that has ended, fix26).
fn after_destroyed(app: &AppHandle, label: &str, destroyed: bool) {
    let mut left: Vec<String> = app.webview_windows().keys().cloned().collect();
    left.sort();
    log(&format!("{label}: {} window(s) left in the app: {}", left.len(), left.join(", ")));
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(SWEEP_AFTER);
        let name = label.clone();
        let _ = app.run_on_main_thread(move || {
            if !destroyed {
                log(&format!("{name}: still listed by the app: no native step"));
                return;
            }
            if let Some(text) = native_sweep(&name) {
                log(&format!("{name}: {text}"));
            }
        });
        std::thread::sleep(COUNT_AFTER);
        let (handle, name) = (app.clone(), label.clone());
        let _ = app.run_on_main_thread(move || {
            // macOS, debug builds: was the finished window freed? (a weak reference answers, macwin.rs `check`, read-only; the debug bridge counts the answers)
            if let Some(text) = native_check(&name) {
                log(&format!("{name}: {text}"));
            }
            let mut left: Vec<String> = handle.webview_windows().keys().cloned().collect();
            left.sort();
            log(&format!("{name}: {} s after closing: {} window(s) left in the app ({}){}", COUNT_AFTER.as_secs(), left.len(), left.join(", "), native_summary()));
        });
    });
}

/// macOS: keep a reference to the native window so that its end can be checked and finished (macwin.rs). Nothing on other systems.
#[cfg(target_os = "macos")]
fn native_hold(win: &tauri::WebviewWindow, label: &str) {
    static VERSION: std::sync::Once = std::sync::Once::new();
    VERSION.call_once(|| log(&format!("macOS {}", crate::macwin::os_version())));
    match win.ns_window() {
        Ok(p) if crate::macwin::hold(label, p) => {}
        Ok(_) => log(&format!("{label}: the native window is null")),
        Err(e) => log(&format!("{label}: no native window: {e}")),
    }
}
#[cfg(not(target_os = "macos"))]
fn native_hold(_win: &tauri::WebviewWindow, _label: &str) {}

/// Main thread. The line for the log about the native window (finished by hand and released), if one was held.
#[cfg(target_os = "macos")]
fn native_sweep(label: &str) -> Option<String> {
    crate::macwin::sweep(label)
}
#[cfg(not(target_os = "macos"))]
fn native_sweep(_label: &str) -> Option<String> {
    None
}

/// Main thread. The line for the log about whether the native window that was finished was freed (macOS), `None` elsewhere or when none was swept.
#[cfg(target_os = "macos")]
fn native_check(label: &str) -> Option<String> {
    crate::macwin::check(label)
}
#[cfg(not(target_os = "macos"))]
fn native_check(_label: &str) -> Option<String> {
    None
}

/// Main thread. ", NSApp lists n window(s), m visible" on macOS, nothing elsewhere.
#[cfg(target_os = "macos")]
fn native_summary() -> String {
    format!(", {}", crate::macwin::windows_summary())
}
#[cfg(not(target_os = "macos"))]
fn native_summary() -> String {
    String::new()
}

/// What `popout_show` answers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    /// "shown" | "focused" (another window has that conversation and was brought forward)
    pub status: &'static str,
    pub label: Option<String>,
}

/// The calling reader window goes on to show another conversation (Next / Previous, W4.4): the registry follows (key and hand-off data), or the window that
/// already shows it is brought forward and this one stays. Only a reader window.
#[tauri::command]
pub fn popout_show(app: AppHandle, window: tauri::Window, key: String, init: Value) -> R<Shown> {
    let label = window.label().to_string();
    if kind_of_label(&label) != Some(Kind::Reader) || key.is_empty() {
        return Err("only a reader window shows another conversation".into());
    }
    let decided = reg(&app).show(&label, &key, init);
    match decided {
        Show::Shown => {
            log(&format!("{label}: shows another conversation"));
            Ok(Shown { status: "shown", label: None })
        }
        Show::Focus { label: other } => {
            log(&format!("{label}: that conversation is open in {other}: brought forward"));
            bring_to_front(&app, &other);
            Ok(Shown { status: "focused", label: Some(other) })
        }
        Show::Unknown => Err("this window is not known".into()),
    }
}

/// The calling window shows another thing now (a draft that a save made is another draft): its key follows, so the lock of a draft keeps
/// holding. False when another window of the kind has that key.
#[tauri::command]
pub fn popout_set_key(app: AppHandle, window: tauri::Window, key: Option<String>) -> bool {
    reg(&app).set_key(window.label(), key.filter(|k| !k.is_empty()))
}

// ---------------------------------------------------------------- AI requests of a window (REQ-R12)

/// The `ai_complete` calls (with a job id) that secondary windows have under way, by window label: a translation or a summary that a reader
/// started stops when that window is destroyed, however it was closed (the page cannot be relied on to say so on its way out).
fn ai_jobs() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static JOBS: std::sync::OnceLock<Mutex<HashMap<String, Vec<String>>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn ai_jobs_lock() -> std::sync::MutexGuard<'static, HashMap<String, Vec<String>>> {
    ai_jobs().lock().unwrap_or_else(|p| p.into_inner())
}

/// A call under way that belongs to a secondary window; it is forgotten when this value is dropped (the call ended).
pub struct AiTrack {
    label: String,
    id: String,
}

impl Drop for AiTrack {
    fn drop(&mut self) {
        let mut g = ai_jobs_lock();
        if let Some(v) = g.get_mut(&self.label) {
            v.retain(|i| i != &self.id);
            if v.is_empty() {
                g.remove(&self.label);
            }
        }
    }
}

/// Note an AI call of `label` (nothing for the main window: its calls are the page's own). Keep the result until the call is over.
pub fn track_ai(label: &str, id: &str) -> Option<AiTrack> {
    if !is_secondary(label) {
        return None;
    }
    ai_jobs_lock().entry(label.to_string()).or_default().push(id.to_string());
    Some(AiTrack { label: label.to_string(), id: id.to_string() })
}

/// The calls a window still has under way (for the window that is being destroyed).
pub fn take_ai(label: &str) -> Vec<String> {
    ai_jobs_lock().remove(label).unwrap_or_default()
}

// ---------------------------------------------------------------- requests to the main page (REQ-S4)

/// Event to `main` only: a secondary window asks the main page to do something it owns (read / flag / pin / moves with Undo, a dialog of
/// the main window, a compose window ...). `{ id, from, kind, payload }`; `from` is stamped here, never taken from the page.
pub const REQUEST_EVENT: &str = "popout-request";
/// Event to one secondary window: the main page's answer to a request, `{ id, ok, data, error }`.
pub const REPLY_EVENT: &str = "popout-reply";
/// Event to every window: threads changed state (read, flag, pin, snooze) by `thread_action`, `{ threadIds, action }`. A reader re-reads.
pub const THREAD_STATE_EVENT: &str = "thread-state";

/// The envelope the main page receives. `from` is the label of the calling window, set by the backend (a payload that carries its own
/// `from` stays inside `payload`).
pub fn request_envelope(from: &str, id: &str, kind: &str, payload: Value) -> Value {
    serde_json::json!({ "id": id, "from": from, "kind": kind, "payload": payload })
}

/// A secondary window asks the main page for something (the main page owns mail state, prefs and the compose windows). Only a live
/// secondary window may ask. The answer comes as the event [`REPLY_EVENT`] to the caller; no answer within 5 s is the caller's timeout.
#[tauri::command]
pub fn popout_request(app: AppHandle, window: tauri::Window, id: String, kind: String, payload: Option<Value>) -> R<()> {
    let from = window.label().to_string();
    if reg(&app).get(&from).is_none() {
        return Err("this is not a secondary window".into());
    }
    app.emit_to("main", REQUEST_EVENT, request_envelope(&from, &id, &kind, payload.unwrap_or(Value::Null))).map_err(|e| e.to_string())
}

/// The main page answers a request of the secondary window `to`. Only the main window may answer. A window that is gone is no error.
#[tauri::command]
pub fn popout_reply(app: AppHandle, window: tauri::Window, to: String, id: String, ok: bool, data: Option<Value>, error: Option<String>) -> R<()> {
    if window.label() != "main" {
        return Err("only the main window answers a request".into());
    }
    if reg(&app).get(&to).is_none() {
        return Ok(());
    }
    app.emit_to(to.as_str(), REPLY_EVENT, serde_json::json!({ "id": id, "ok": ok, "data": data, "error": error })).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn the_ai_calls_of_a_window_are_known_until_they_end_or_the_window_goes() {
        let a = track_ai("reader-90", "translate-1-0").expect("a secondary window is tracked");
        let b = track_ai("reader-90", "summarize-2").unwrap();
        let other = track_ai("reader-91", "translate-9-0").unwrap();
        assert!(track_ai("main", "summarize-3").is_none(), "the main window's calls are its own");
        drop(a); // that call ended by itself
        assert_eq!(take_ai("reader-90"), vec!["summarize-2".to_string()], "only what is still under way");
        assert!(take_ai("reader-90").is_empty(), "taken once");
        drop(b); // ends after the window went: nothing to forget, no panic
        assert_eq!(take_ai("reader-91"), vec!["translate-9-0".to_string()], "another window's calls are not touched");
        drop(other);
        assert!(take_ai("reader-91").is_empty());
    }

    #[test]
    fn a_request_is_stamped_with_the_caller_and_keeps_the_payload_apart() {
        let spoof = serde_json::json!({ "from": "main", "action": "archive" });
        let e = request_envelope("reader-2", "r7", "thread-action", spoof.clone());
        assert_eq!(e["from"], "reader-2");
        assert_eq!(e["id"], "r7");
        assert_eq!(e["kind"], "thread-action");
        assert_eq!(e["payload"], spoof, "the payload is data: a `from` inside it changes nothing");
    }

    #[test]
    fn the_compose_window_commands_act_on_the_caller_only_and_the_count_goes_to_main() {
        let code = crate::test_guard::non_test_code(include_str!("popout.rs"));
        // park / destroy / set_key take the calling window (stamped by the backend), never a label from the page
        for f in ["fn popout_park(app: AppHandle, window: tauri::Window)", "fn popout_destroy(app: AppHandle, window: tauri::Window)", "fn popout_set_key(app: AppHandle, window: tauri::Window, key: Option<String>)"] {
            assert!(code.contains(f), "{f}");
        }
        // park hides the caller; destroy does NOT end the window inside the page's own call: it hands over to `retire`
        assert!(code.contains("window.hide()"));
        let destroy = &code[code.find("pub fn popout_destroy").unwrap()..];
        let destroy = &destroy[..destroy.find("
}
").unwrap()];
        assert!(destroy.contains("retire(&app, &label, \"ended by its page\")") && !destroy.contains(".destroy()") && !destroy.contains(".close()"), "{destroy}");
        // the count of windows is told to the main page only
        assert!(code.contains("app.emit_to(\"main\", COUNT_EVENT"));
        assert!(!code.contains("app.emit(COUNT_EVENT"));
        // creating and destroying a window both announce it
        assert!(code.contains("            announce_counts(app);
            Ok(Opened { status: \"created\""));
        let destroyed = &code[code.find("tauri::WindowEvent::Destroyed =>").unwrap()..];
        assert!(destroyed[..destroyed.find("_ => {}").unwrap()].contains("announce_counts(app);"));
        // ending a window also announces it (the count leaves out a window on its way out)
        let retire = &code[code.find("pub fn retire(").unwrap()..];
        assert!(retire[..retire.find("
}
").unwrap()].contains("announce_counts(app);"));
    }

    #[test]
    fn requests_and_answers_are_wired_to_the_right_windows() {
        let code = crate::test_guard::non_test_code(include_str!("popout.rs"));
        // a request goes to the main page only; an answer to the one window that asked; only a live secondary window asks, only main answers
        assert!(code.contains("app.emit_to(\"main\", REQUEST_EVENT"));
        assert!(code.contains("app.emit_to(to.as_str(), REPLY_EVENT"));
        assert!(!code.contains("app.emit(REQUEST_EVENT") && !code.contains("app.emit(REPLY_EVENT"));
        assert!(code.contains("if reg(&app).get(&from).is_none()"));
        assert!(code.contains("if window.label() != \"main\""));
        // the state event is a broadcast (every reader listens), set by `thread_action`
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(lib.contains("app.emit(popout::THREAD_STATE_EVENT"));
        // a reader window whose mailbox was removed reads its conversation again (it is gone)
        let at = lib.find("fn remove_account(").expect("remove_account");
        let body = &lib[at..at + lib[at..].find("
}
").unwrap()];
        assert!(body.contains("app.emit(\"mail-synced\", ())"), "remove_account tells the windows");
    }

    fn t(s: &str) -> String {
        s.to_string()
    }

    // ---- labels and kinds

    #[test]
    fn labels_tell_the_kind() {
        assert_eq!(kind_of_label("compose-1"), Some(Kind::Compose));
        assert_eq!(kind_of_label("reader-12"), Some(Kind::Reader));
        for not in ["main", "compose", "compose-", "compose-x", "compose-1a", "reader--1", "Compose-1", "other-1", "", "-1"] {
            assert_eq!(kind_of_label(not), None, "{not}");
            assert!(!is_secondary(not));
        }
        assert!(is_secondary("compose-3"));
        for k in KINDS {
            assert_eq!(Kind::parse(k.name()), Some(k));
            let (w, h) = (k.default_size(), k.min_size());
            assert!(w.0 > h.0 && w.1 > h.1, "the default is larger than the minimum");
        }
        assert_eq!(Kind::Compose.default_size(), (960.0, 920.0));
        assert_eq!(Kind::Reader.default_size(), (1040.0, 960.0));
        assert_eq!(Kind::Compose.min_size(), (560.0, 440.0));
        assert_eq!(Kind::Reader.min_size(), (520.0, 400.0));
        assert_ne!(Kind::Compose.setting_key(), Kind::Reader.setting_key());
    }

    /// W4.6 REQ-4.6.1: the four new kinds have a label, the sizes of the spec, a setting key of their own, and the rules of their kind.
    #[test]
    fn every_window_kind_has_its_label_size_and_setting_key() {
        let want = [
            (Kind::Compose, "compose", "window.compose", (960.0, 920.0), (560.0, 440.0)),
            (Kind::Reader, "reader", "window.reader", (1040.0, 960.0), (520.0, 400.0)),
            (Kind::Event, "event", "window.event", (760.0, 780.0), (480.0, 480.0)),
            (Kind::Settings, "settings", "window.settings", (1040.0, 760.0), (720.0, 500.0)),
            (Kind::Search, "search", "window.search", (960.0, 780.0), (520.0, 400.0)),
            (Kind::Scheduled, "scheduled", "window.scheduled", (860.0, 700.0), (520.0, 400.0)),
        ];
        assert_eq!(want.len(), KINDS.len());
        for (i, (k, name, key, def, min)) in want.into_iter().enumerate() {
            assert_eq!(KINDS[i], k, "the order of KINDS is the order of index()");
            assert_eq!(k.index(), i);
            assert_eq!((k.name(), k.setting_key(), k.default_size(), k.min_size()), (name, key, def, min));
            assert_eq!(Kind::parse(name), Some(k));
            assert_eq!(kind_of_label(&format!("{name}-7")), Some(k));
            assert!(is_secondary(&format!("{name}-1")));
        }
        let keys: std::collections::HashSet<_> = KINDS.iter().map(|k| k.setting_key()).collect();
        assert_eq!(keys.len(), KINDS.len(), "the place of each kind is remembered separately");
        // who decides what a close means, and who exists once
        assert!(Kind::Compose.page_decides_close() && Kind::Event.page_decides_close());
        assert!(!Kind::Reader.page_decides_close() && !Kind::Settings.page_decides_close() && !Kind::Search.page_decides_close() && !Kind::Scheduled.page_decides_close());
        assert_eq!((Kind::Settings.single_key(), Kind::Scheduled.single_key()), (Some("settings"), Some("scheduled")));
        assert!([Kind::Compose, Kind::Reader, Kind::Event, Kind::Search].iter().all(|k| k.single_key().is_none()));
        // Settings and the Scheduled list exist once; an event is one window per event, a search one per search; all of them count for the cap of 8 together
        let mut r = Registry::default();
        let Request::Create { label: a } = ask(&mut r, Kind::Settings, Some("settings")) else { panic!() };
        assert_eq!(ask(&mut r, Kind::Settings, Some("settings")), Request::Focus { label: a });
        let Request::Create { label: e } = ask(&mut r, Kind::Event, Some("event-id-1")) else { panic!() };
        assert_eq!(ask(&mut r, Kind::Event, Some("event-id-1")), Request::Focus { label: e });
        assert!(matches!(ask(&mut r, Kind::Event, Some("event-id-2")), Request::Create { .. }));
        assert!(matches!(ask(&mut r, Kind::Event, None), Request::Create { .. }), "a new event has no key");
        assert!(matches!(ask(&mut r, Kind::Event, None), Request::Create { .. }), "and may be opened twice");
        for _ in 0..3 {
            assert!(matches!(ask(&mut r, Kind::Search, None), Request::Create { .. }));
        }
        assert_eq!(r.entries.len(), 8);
        assert_eq!(ask(&mut r, Kind::Scheduled, Some("scheduled")), Request::TooMany, "the cap of 8 counts every kind");
    }

    // ---- registry

    fn ask(r: &mut Registry, kind: Kind, key: Option<&str>) -> Request {
        r.request(kind, key, t("tok"), None)
    }

    #[test]
    fn labels_are_unique_and_never_reused() {
        let mut r = Registry::default();
        let mut seen = std::collections::HashSet::new();
        for i in 0..3 {
            for k in KINDS {
                let Request::Create { label } = ask(&mut r, k, None) else { panic!("create {i}") };
                assert!(seen.insert(label.clone()), "{label} twice");
                assert_eq!(kind_of_label(&label), Some(k));
                // (the other kinds end at once: the cap of 8 is for all kinds together)
                if !matches!(k, Kind::Compose | Kind::Reader) {
                    r.remove(&label).unwrap();
                }
            }
        }
        assert_eq!(r.entries.len(), 6);
        // closing a window frees its slot, not its label
        r.remove("compose-1").unwrap();
        let Request::Create { label } = ask(&mut r, Kind::Compose, None) else { panic!() };
        assert_eq!(label, "compose-4", "the counter only goes up");
        assert!(r.remove("compose-1").is_none(), "gone is gone");
    }

    /// The frame theme (wintheme.rs) reaches `main` and every label this registry hands out, of both kinds, not only some of them.
    #[test]
    fn every_label_of_the_registry_gets_the_frame_theme() {
        let mut r = Registry::default();
        let mut labels = vec!["main".to_string()];
        for _ in 0..3 {
            for k in KINDS {
                let Request::Create { label } = ask(&mut r, k, None) else { panic!("create") };
                labels.push(label.clone());
                if !matches!(k, Kind::Compose | Kind::Reader) {
                    r.remove(&label).unwrap();
                }
            }
        }
        assert!(["compose-", "reader-", "event-", "settings-", "search-", "scheduled-"].iter().all(|p| labels.iter().any(|l| l.starts_with(p))), "every kind");
        let themed = crate::wintheme::themed_labels(labels.clone());
        for l in &labels {
            assert!(themed.contains(l), "{l} does not get the frame theme");
        }
    }

    #[test]
    fn at_most_eight_windows_all_kinds_together() {
        let mut r = Registry::default();
        for i in 0..MAX_SECONDARY {
            let kind = if i % 2 == 0 { Kind::Compose } else { Kind::Reader };
            assert!(matches!(ask(&mut r, kind, None), Request::Create { .. }), "window {i}");
        }
        assert_eq!(ask(&mut r, Kind::Compose, None), Request::TooMany);
        assert_eq!(ask(&mut r, Kind::Reader, None), Request::TooMany);
        assert_eq!(r.entries.len(), MAX_SECONDARY, "a refused request registers nothing");
        // one closes: one more fits
        r.remove("reader-1").unwrap();
        assert!(matches!(ask(&mut r, Kind::Reader, None), Request::Create { .. }));
        assert_eq!(ask(&mut r, Kind::Reader, None), Request::TooMany);
    }

    #[test]
    fn a_key_that_is_open_is_focused_not_opened_again() {
        let mut r = Registry::default();
        let Request::Create { label: a } = ask(&mut r, Kind::Reader, Some("thread-1")) else { panic!() };
        assert_eq!(ask(&mut r, Kind::Reader, Some("thread-1")), Request::Focus { label: a.clone() });
        // another key, another kind with the same key, and no key at all open new windows
        assert!(matches!(ask(&mut r, Kind::Reader, Some("thread-2")), Request::Create { .. }));
        assert!(matches!(ask(&mut r, Kind::Compose, Some("thread-1")), Request::Create { .. }));
        assert!(matches!(ask(&mut r, Kind::Reader, None), Request::Create { .. }));
        assert!(matches!(ask(&mut r, Kind::Reader, None), Request::Create { .. }));
        assert_eq!(r.entries.len(), 5);
        // closed: the key is free again
        r.remove(&a).unwrap();
        assert!(matches!(ask(&mut r, Kind::Reader, Some("thread-1")), Request::Create { .. }));
    }

    #[test]
    fn a_key_is_focused_even_when_the_cap_is_reached() {
        let mut r = Registry::default();
        let Request::Create { label } = ask(&mut r, Kind::Compose, Some("draft-1")) else { panic!() };
        for _ in 1..MAX_SECONDARY {
            ask(&mut r, Kind::Reader, None);
        }
        assert_eq!(r.entries.len(), MAX_SECONDARY);
        assert_eq!(ask(&mut r, Kind::Compose, Some("draft-1")), Request::Focus { label }, "focusing opens nothing, so the cap does not apply");
        assert_eq!(ask(&mut r, Kind::Compose, Some("draft-2")), Request::TooMany);
    }

    #[test]
    fn a_draft_is_open_in_one_window_only_and_its_key_follows_the_saves() {
        let mut r = Registry::default();
        let Request::Create { label: a } = ask(&mut r, Kind::Compose, Some("draft:t1")) else { panic!() };
        let Request::Create { label: b } = ask(&mut r, Kind::Compose, Some("draft:t2")) else { panic!() };
        assert_eq!(r.find_key(Kind::Compose, "draft:t1").map(|e| e.label.clone()), Some(a.clone()));
        assert!(r.find_key(Kind::Reader, "draft:t1").is_none(), "the key is per kind");
        // a save made another draft of it: the key follows, the old one is free, and asking for it opens a new window
        assert!(r.set_key(&a, Some(t("draft:t3"))));
        assert!(r.find_key(Kind::Compose, "draft:t1").is_none());
        assert_eq!(ask(&mut r, Kind::Compose, Some("draft:t3")), Request::Focus { label: a.clone() });
        // the draft another window holds cannot be taken, and the caller keeps what it had
        assert!(!r.set_key(&a, Some(t("draft:t2"))));
        assert_eq!(r.get(&a).unwrap().keys, ["draft:t3"]);
        assert_eq!(r.get(&b).unwrap().keys, ["draft:t2"]);
        // setting the key it has is fine; an unknown window is refused
        assert!(r.set_key(&a, Some(t("draft:t3"))));
        assert!(!r.set_key("compose-99", Some(t("x"))));
    }

    /// W2.12: a reply window answers to its reply key after its first save. The save adds the draft's key; a second Reply on the same mail focuses the window,
    /// so does opening the saved draft; Reply all and Forward of the same mail are other windows; a later save moves the draft key and keeps the reply key.
    #[test]
    fn a_window_keeps_its_answer_key_after_a_save() {
        let mut r = Registry::default();
        let Request::Create { label: a } = ask(&mut r, Kind::Compose, Some("re:m1")) else { panic!() };
        assert!(r.set_key(&a, Some(t("draft:mid:acc|<d1@x>"))), "the first save adds the draft's key");
        assert_eq!(r.find_key(Kind::Compose, "re:m1").map(|e| e.label.clone()), Some(a.clone()), "the answer key is kept");
        assert_eq!(r.find_key(Kind::Compose, "draft:mid:acc|<d1@x>").map(|e| e.label.clone()), Some(a.clone()));
        assert_eq!(ask(&mut r, Kind::Compose, Some("re:m1")), Request::Focus { label: a.clone() }, "a second Reply on the same mail: the same window");
        assert_eq!(ask(&mut r, Kind::Compose, Some("draft:mid:acc|<d1@x>")), Request::Focus { label: a.clone() }, "the saved draft: the same window");
        // Reply all and Forward have their own windows, as before
        let Request::Create { label: ra } = ask(&mut r, Kind::Compose, Some("ra:m1")) else { panic!("reply all is another window") };
        let Request::Create { label: fw } = ask(&mut r, Kind::Compose, Some("fw:m1")) else { panic!("forward is another window") };
        assert!(ra != a && fw != a && ra != fw);
        // the next save made another draft of it: the draft key moves, the old one is free, the answer key stays
        assert!(r.set_key(&a, Some(t("draft:mid:acc|<d2@x>"))));
        assert!(r.find_key(Kind::Compose, "draft:mid:acc|<d1@x>").is_none());
        assert_eq!(r.get(&a).unwrap().keys, ["re:m1", "draft:mid:acc|<d2@x>"]);
        // a key still cannot be held by two windows
        assert!(!r.set_key(&ra, Some(t("draft:mid:acc|<d2@x>"))));
        assert!(!r.set_key(&ra, Some(t("re:m1"))));
        assert_eq!(r.get(&ra).unwrap().keys, ["ra:m1"]);
        // the same key twice is held once
        assert!(r.set_key(&a, Some(t("draft:mid:acc|<d2@x>"))));
        assert_eq!(r.get(&a).unwrap().keys.len(), 2);
        // parked or on its way out: every key is free, and Reply on the mail opens a new window (AC-2.12.3)
        assert_eq!(r.start_retire(&a), Some(true));
        assert!(r.get(&a).unwrap().keys.is_empty());
        let Request::Create { label: again } = ask(&mut r, Kind::Compose, Some("re:m1")) else { panic!("the old key ended with the window") };
        assert_ne!(again, a);
        // destroyed: gone from the registry with its keys
        assert!(r.remove(&a).is_some());
        assert!(r.find_key(Kind::Compose, "draft:mid:acc|<d2@x>").is_none());
        // a window opened from a draft gives that draft's key up when a save made another draft (the first save of a reopened draft)
        let Request::Create { label: d } = ask(&mut r, Kind::Compose, Some("draft:t1")) else { panic!() };
        assert!(r.set_key(&d, Some(t("draft:t2"))));
        assert_eq!(r.get(&d).unwrap().keys, ["draft:t2"]);
        // parking (Undo off) frees all of them
        assert!(r.set_key(&again, None));
        assert!(r.get(&again).unwrap().keys.is_empty());
    }

    #[test]
    fn a_window_on_its_way_out_frees_its_key_but_still_counts() {
        let mut r = Registry::default();
        let Request::Create { label } = ask(&mut r, Kind::Compose, Some("re:m1")) else { panic!() };
        assert_eq!(ask(&mut r, Kind::Compose, Some("re:m1")), Request::Focus { label: label.clone() });
        assert!(r.set_key(&label, None), "parked: the key is freed");
        assert_eq!(r.count(Kind::Compose), 1, "it still exists, so it still counts against the cap");
        // a new reply to the same message opens a window of its own (the parked one is finishing a send)
        assert!(matches!(ask(&mut r, Kind::Compose, Some("re:m1")), Request::Create { .. }));
        assert_eq!(r.count(Kind::Compose), 2);
        assert_eq!(r.count(Kind::Reader), 0);
    }

    /// D-093: the macOS window code cannot run here; what the sweep does to a finished window, and that the check of the result and the experiment stay in debug builds, is read from the source.
    #[test]
    fn the_macos_sweep_takes_away_every_reference_the_app_side_can_and_checks_the_result() {
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let sweep = &mac[mac.find("pub fn sweep(").unwrap()..mac.find("pub fn check(").unwrap()];
        for step in ["setDelegate: nil", "removeObserver: d", "removeObserver: ptr", "removeWindowsItem: ptr", "setContentView: &*empty", "orderOut: nil", "msg_send![ptr, close]", "Weak::from(&w)", "drop(delegate);", "drop(w);"] {
            assert!(sweep.contains(step), "the sweep lacks {step}");
        }
        assert!(sweep.find("setDelegate: nil").unwrap() < sweep.find("msg_send![ptr, close]").unwrap(), "the delegate goes before the window is closed");
        let check = &mac[mac.find("pub fn check(").unwrap()..mac.find("/// What [`apply_appearance`]").unwrap()];
        assert!(check.contains("weak.load()") && check.contains("ALIVE.fetch_add") && check.contains("FREED.fetch_add"));
        assert!(check.contains("if !cfg!(debug_assertions) {") && !check.contains("release]"), "the check is read-only and debug-only (DEC-024)");
        assert!(!mac.contains("setReleasedWhenClosed"), "nothing here changes who owns the window");
        // every window of every kind gets the same native ground behind its title bar (D-092)
        let walk = &mac[mac.find("pub fn apply_appearance(").unwrap()..];
        assert!(walk.contains("set_ground(w, expected)") && !walk.contains("kind_of_label"), "{walk}");
        // the check runs after the sweep, in the same closing step, and the bridge shows the counters
        let pop = crate::test_guard::non_test_code(include_str!("popout.rs"));
        assert!(pop.contains("native_check(&name)") && pop.find("native_sweep(&name)").unwrap() < pop.find("native_check(&name)").unwrap());
        assert!(include_str!("testbridge/native.rs").contains("macwin::sweep_stats()"));
    }

    /// D-093 / round 11a: the Tauri destroy of a window never waits for, or depends on, the native teardown. The teardown (macOS, macwin.rs) runs only after the window is gone
    /// (`Destroyed`), as the first part of the sweep, on the pointer that was held at creation; the destroy is always requested and its result logged.
    #[test]
    fn the_destroy_of_a_window_never_depends_on_the_native_teardown_and_the_teardown_follows_it() {
        let pop = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let destroy = &pop[pop.find("fn destroy_on_event_loop(").unwrap()..];
        let destroy = &destroy[..destroy.find("\n}\n").unwrap()];
        assert!(destroy.contains("w.destroy()") && !destroy.contains("teardown") && !destroy.contains("macwin"), "nothing native before or around the destroy: {destroy}");
        assert!(destroy.contains("destroy requested") && destroy.contains("destroy was refused"), "both outcomes are logged");
        let close = &pop[pop.find("tauri::WindowEvent::CloseRequested { api, .. } =>").unwrap()..];
        assert!(!close[..close.find("tauri::WindowEvent::Moved").unwrap()].contains("teardown"), "nothing native when a close is only asked for");
        assert!(!pop.contains("native_teardown"), "no native step is named in the road of a window's end");
        assert!(pop.contains("destroy done (the Destroyed event came)"), "the log says that the window is gone");
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let sweep = &mac[mac.find("pub fn sweep(").unwrap()..mac.find("pub fn check(").unwrap()];
        assert!(sweep.find("teardown_views(").unwrap() < sweep.find("setDelegate: nil").unwrap(), "the teardown is the first part of the sweep");
        let td = &mac[mac.find("unsafe fn teardown_views(").unwrap()..mac.find("unsafe fn collect_views(").unwrap()];
        let steps = ["makeFirstResponder: nil", "unregisterDraggedTypes", "removeObserver: *t", "setNavigationDelegate: nil", "setUIDelegate: nil", "stopLoading", "removeFromSuperview", "removeTitlebarAccessoryViewControllerAtIndex", "setToolbar: nil", "setContentView: &*empty"];
        let mut at = 0;
        for step in steps {
            let i = td.find(step).unwrap_or_else(|| panic!("teardown lacks {step}"));
            assert!(i >= at, "{step} is out of order");
            at = i;
        }
        assert!(!td.contains("close]") && !td.contains("release]") && !td.contains("setReleasedWhenClosed"), "teardown releases and closes nothing");
        // the poll of the window system leaves a window that is on its way out alone (no "no native window" every 2 s)
        let wt = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        assert!(wt.contains("crate::popout::is_retiring(app, &label)"), "wintheme skips retiring windows");
        // the check afterwards is read-only and debug-only (DEC-024; leakfix.rs guards it)
        let check = &mac[mac.find("pub fn check(").unwrap()..mac.find("/// What [`apply_appearance`]").unwrap()];
        assert!(check.contains("if !cfg!(debug_assertions) {"));
    }

    #[test]
    fn windows_on_their_way_out_do_not_count_against_the_cap_of_eight() {
        // D-094: after a run of closed windows the next Settings / search / Scheduled window must open, not be refused as "too many"
        let mut r = Registry::default();
        let mut labels = vec![];
        for i in 0..MAX_SECONDARY {
            let Request::Create { label } = ask(&mut r, Kind::Compose, Some(&format!("draft:{i}"))) else { panic!("{i}") };
            labels.push(label);
        }
        assert_eq!(ask(&mut r, Kind::Settings, Some("settings")), Request::TooMany, "eight open windows: the ninth is refused");
        // the person closes two of them: they are going, the registry still lists them until the window system has let go
        r.start_retire(&labels[0]);
        r.start_retire(&labels[1]);
        assert_eq!(r.entries.len(), MAX_SECONDARY, "still listed");
        assert!(matches!(ask(&mut r, Kind::Settings, Some("settings")), Request::Create { .. }), "but they no longer count");
        assert!(matches!(ask(&mut r, Kind::Search, Some("search:a")), Request::Create { .. }));
        assert_eq!(ask(&mut r, Kind::Scheduled, Some("scheduled")), Request::TooMany, "back at eight live windows");
    }

    #[test]
    fn a_window_that_is_ended_is_out_of_every_list_at_once() {
        let mut r = Registry::default();
        let Request::Create { label } = ask(&mut r, Kind::Compose, Some("draft:t1")) else { panic!() };
        r.get_mut(&label).unwrap().ready = true;
        assert_eq!(r.ready_labels(), [label.clone()]);
        assert_eq!(r.start_retire(&label), Some(true), "the first call starts it");
        assert_eq!(r.start_retire(&label), Some(false), "asking twice is harmless");
        assert_eq!(r.start_retire("compose-99"), None);
        assert!(r.ready_labels().is_empty(), "a quit does not ask a window that is going");
        assert_eq!(r.count(Kind::Compose), 0, "the person ended it: it is not an open compose window any more");
        assert!(!r.may_show(&label));
        assert!(r.get(&label).is_some(), "it is forgotten when its Destroyed event comes, not before");
        // the same draft opened again is a new window, not a focus of the one that is going
        let Request::Create { label: again } = ask(&mut r, Kind::Compose, Some("draft:t1")) else { panic!("a retiring window must not take a focus request") };
        assert_ne!(again, label);
    }

    /// 1.0.7 WP2a QA BUG-1: "a draft that was popped out and closed cannot be popped out again". The registry side of that, 20 times over, by every road a
    /// window ends by: the page ends it (retire, then Destroyed), the window system destroys it at once (Destroyed only), and a window that was given up.
    /// The same key always gets a NEW window with a NEW label (never a focus of the one that is gone, never a refusal), and nothing is left behind.
    #[test]
    fn a_closed_draft_window_can_be_opened_again_every_time() {
        let mut r = Registry::default();
        let mut seen = std::collections::HashSet::new();
        let mut last: Option<String> = None;
        for i in 0..20 {
            let Request::Create { label } = ask(&mut r, Kind::Compose, Some("draft:mid:acc|<d1@x>")) else { panic!("open {i}: the closed draft did not get a new window") };
            assert!(seen.insert(label.clone()), "open {i}: {label} was used before");
            assert_eq!(r.find_key(Kind::Compose, "draft:mid:acc|<d1@x>").map(|e| e.label.clone()), Some(label.clone()));
            // a second ask while it is open is a focus, as before
            assert_eq!(ask(&mut r, Kind::Compose, Some("draft:mid:acc|<d1@x>")), Request::Focus { label: label.clone() });
            // the page says it is ready, the draft's key follows a save (set_key), then the window ends
            r.get_mut(&label).unwrap().ready = true;
            assert!(r.set_key(&label, Some(format!("draft:mid:acc|<d{i}@x>"))));
            assert!(r.set_key(&label, Some("draft:mid:acc|<d1@x>".into())));
            match i % 3 {
                0 => {
                    // ended by its page: out of sight and key freed at once, forgotten when the window system says it is destroyed
                    assert_eq!(r.start_retire(&label), Some(true));
                    assert!(r.find_key(Kind::Compose, "draft:mid:acc|<d1@x>").is_none(), "its key is free while it is going");
                    assert!(r.remove(&label).is_some());
                }
                1 => assert!(r.remove(&label).is_some(), "destroyed by the window system without a retire"),
                _ => {
                    // given up after the wait (the window object never went): forgotten all the same
                    assert_eq!(r.start_retire(&label), Some(true));
                    assert!(r.remove(&label).is_some());
                    assert!(r.remove(&label).is_none(), "forgotten once");
                }
            }
            assert!(r.entries.is_empty(), "open {i}: {:?} left behind", r.entries.iter().map(|e| &e.label).collect::<Vec<_>>());
            if let Some(prev) = &last {
                assert_ne!(prev, &label);
            }
            last = Some(label);
        }
        assert_eq!(seen.len(), 20);
    }

    /// A window that could not be created is taken out again (`open` does that), so it holds no slot and no key: the next open of the same draft works, and
    /// the cap is not eaten by the failures.
    #[test]
    fn a_window_that_could_not_be_created_holds_no_slot_and_no_key() {
        let mut r = Registry::default();
        for i in 0..(MAX_SECONDARY * 3) {
            let Request::Create { label } = ask(&mut r, Kind::Compose, Some("draft:t1")) else { panic!("try {i}: refused after earlier failures") };
            assert_eq!(r.entries.len(), 1);
            assert!(r.remove(&label).is_some()); // the creation failed
            assert!(r.entries.is_empty() && r.find_key(Kind::Compose, "draft:t1").is_none());
        }
        // and then it works
        assert!(matches!(ask(&mut r, Kind::Compose, Some("draft:t1")), Request::Create { .. }));
        // the code takes the entry out before anything else on a failure
        let code = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let open = &code[code.find("pub fn open(").unwrap()..code.find("fn creation_hint(").unwrap()];
        let failed = &open[open.find("Err(e) => {").unwrap()..];
        assert!(failed.find("reg(app).remove(&label)").unwrap() < failed.find("could not be created").unwrap());
    }

    #[test]
    fn the_log_says_when_the_event_loop_itself_stopped_taking_messages() {
        // a window call that fails with this text is not about that window: the hint is added to the line, and only to that error
        let e = "runtime error: failed to send message to the webview";
        assert!(creation_hint(e).contains("event loop") && creation_hint(e).contains("WM_CLOSE") && creation_hint(e).contains("started again"));
        assert_eq!(creation_hint("failed to create window: out of memory"), "");
        assert_eq!(creation_hint(""), "");
    }

    #[test]
    fn a_window_is_shown_only_when_its_page_is_ready_or_the_wait_ran_out() {
        let mut r = Registry::default();
        let Request::Create { label } = ask(&mut r, Kind::Reader, Some("t1")) else { panic!() };
        // a second open of the same conversation while the first window is still being made: it must not put the blank window on screen
        assert_eq!(ask(&mut r, Kind::Reader, Some("t1")), Request::Focus { label: label.clone() });
        assert!(!r.may_show(&label), "created hidden, page not up: not shown");
        r.get_mut(&label).unwrap().ready = true;
        assert!(r.may_show(&label));
        // the wait ran out (the window is shown without a signal)
        let Request::Create { label: slow } = ask(&mut r, Kind::Reader, Some("t2")) else { panic!() };
        r.get_mut(&slow).unwrap().ready_at = Some(std::time::Instant::now());
        assert!(r.may_show(&slow));
        assert!(!r.may_show("reader-99"), "no such window");
    }

    #[test]
    fn the_end_of_a_window_is_asked_again_and_then_given_up() {
        use RetireStep::*;
        let ms = Duration::from_millis;
        assert_eq!(retire_step(ms(0), false, false), Wait);
        assert_eq!(retire_step(ms(100), true, false), Done, "gone: verified, whenever");
        assert_eq!(retire_step(ms(2400), true, true), Done);
        assert_eq!(retire_step(RETIRE_AGAIN - ms(1), false, false), Wait);
        assert_eq!(retire_step(RETIRE_AGAIN, false, false), DestroyAgain, "still there: closing again, once");
        assert_eq!(retire_step(RETIRE_AGAIN + ms(100), false, true), Wait);
        assert_eq!(retire_step(RETIRE_GIVE_UP, false, true), GiveUp);
        assert_eq!(retire_step(RETIRE_GIVE_UP, false, false), GiveUp, "never waits for ever");
        assert!(RETIRE_DELAY < RETIRE_POLL && RETIRE_POLL < RETIRE_AGAIN && RETIRE_AGAIN < RETIRE_GIVE_UP);
    }

    #[test]
    fn every_system_ends_a_window_by_the_same_road_and_nothing_ends_one_inside_a_page_call() {
        let code = crate::test_guard::non_test_code(include_str!("popout.rs"));
        // the steps, in this order, each with its line in the log
        let steps = &code[code.find("fn retire_steps(").unwrap()..];
        let steps = &steps[..steps.find("\n}\n").unwrap()];
        let at = |needle: &str| steps.find(needle).unwrap_or_else(|| panic!("{needle} is missing in retire_steps"));
        assert!(at("w.hide()") < at("destroy scheduled") && at("destroy scheduled") < at("destroy_on_event_loop(app, label)"));
        assert!(at("destroy_on_event_loop(app, label)") < at("gone (verified)") && at("still present: closing again") < at("forgotten"));
        assert!(steps.contains("hidden") && steps.contains("RetireStep::DestroyAgain") && steps.contains("RetireStep::GiveUp"));
        // the end is a task of the event loop, and it is the only place a window is destroyed
        let task = &code[code.find("fn destroy_on_event_loop(").unwrap()..];
        assert!(task[..task.find("\n}\n").unwrap()].contains("run_on_main_thread") && task.contains("w.destroy()"));
        assert_eq!(code.matches(".destroy()").count(), 1, "one place destroys a window");
        // no #[cfg(target_os)] around the road itself: the macOS-only parts are the native hold / sweep / summary functions
        let road = &code[code.find("pub fn retire(").unwrap()..code.find("/// macOS: keep a reference to the native window").unwrap()];
        assert!(!road.contains("cfg(target_os") && !road.contains("cfg(windows"), "the end of a window is the same on every system");
        assert_eq!(code.matches("#[cfg(target_os = \"macos\")]").count(), 5, "native_hold, native_sweep, native_check, native_summary, and the title bar style of `create` (D-097)");
        // a window that was ended is never put on screen again: by a second open, by its own page getting ready late, by the wait for the page
        assert!(code.contains("if !reg(app).may_show(label) {"));
        let ready = &code[code.find("pub fn mark_ready(").unwrap()..];
        assert!(ready[..ready.find("\n}\n").unwrap()].contains("e.retiring"));
        let watch = &code[code.find("fn watch_ready(").unwrap()..];
        assert!(watch[..watch.find("\n}\n").unwrap()].contains("e.retiring"));
        // the native window is kept at creation, and finished once the window is gone
        assert!(code.contains("native_hold(&win, label);") && code.contains("native_sweep(&name)"));
        // the log counts the windows left, at once and later
        assert!(code.contains("window(s) left in the app") && code.contains("s after closing"));
    }

    #[test]
    fn hand_off_data_and_token_live_and_die_with_the_window() {
        let mut r = Registry::default();
        let Request::Create { label } = r.request(Kind::Compose, None, t("secret"), Some(serde_json::json!({"to": "a@example.com"}))) else { panic!() };
        let e = r.get(&label).unwrap();
        assert_eq!(e.token, "secret");
        assert_eq!(e.init.as_ref().unwrap()["to"], "a@example.com");
        assert!(!e.ready);
        let gone = r.remove(&label).unwrap();
        assert!(gone.init.is_some(), "handed back to the caller of remove");
        assert!(r.get(&label).is_none(), "nothing of it is kept");
    }

    #[test]
    fn only_windows_whose_page_is_ready_are_asked_to_answer_a_quit() {
        let mut r = Registry::default();
        for _ in 0..3 {
            ask(&mut r, Kind::Compose, None);
        }
        assert!(r.ready_labels().is_empty());
        r.get_mut("compose-2").unwrap().ready = true;
        r.get_mut("compose-1").unwrap().ready = true;
        assert_eq!(r.ready_labels(), ["compose-1", "compose-2"], "oldest first");
        // the window a new one cascades from: the newest of its kind that is open, not itself, and only once its place is known
        assert_eq!(r.newest_rect(Kind::Compose, "compose-3"), None, "no place known yet");
        r.get_mut("compose-2").unwrap().rect = Some(Rect { x: 1, y: 2, w: 3, h: 4 });
        assert_eq!(r.newest_rect(Kind::Compose, "compose-3"), Some(Rect { x: 1, y: 2, w: 3, h: 4 }));
        assert_eq!(r.newest_rect(Kind::Compose, "compose-2"), None, "compose-3 is newer but has no place; compose-1 neither");
        assert_eq!(r.newest_rect(Kind::Reader, "reader-1"), None);
    }

    // ---- geometry

    fn mon(x: i32, y: i32, w: i32, h: i32, scale: f64, primary: bool) -> Mon {
        Mon { work: Rect { x, y, w, h }, scale, primary }
    }

    fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    fn saved(x: i32, y: i32, w: f64, h: f64) -> Saved {
        Saved { x, y, w, h, maximized: false }
    }

    fn big() -> Vec<Mon> {
        vec![mon(0, 0, 1920, 1040, 1.0, true)]
    }

    #[test]
    fn the_default_is_centred_over_the_main_window() {
        let p = place(Kind::Compose, None, &big(), Some(rect(100, 50, 1280, 800)), None);
        // 960 x 920, centre of main = (740, 450): y would be -10, so the window is moved down into the work area
        assert_eq!(p.rect, Some(rect(260, 0, 960, 920)));
        assert_eq!(p.size, (960.0, 920.0));
        let p = place(Kind::Reader, None, &big(), Some(rect(100, 50, 1280, 800)), None);
        // 960 is above 90 % of the 1040 px work area (936): the reader is cut to the cap
        assert_eq!(p.rect.map(|r| (r.w, r.h)), Some((1040, 936)));
    }

    #[test]
    fn without_a_visible_main_window_the_primary_monitor_is_used() {
        let mons = vec![mon(0, 0, 1920, 1040, 1.0, false), mon(1920, 0, 2560, 1400, 1.0, true)];
        let p = place(Kind::Compose, None, &mons, None, None).rect.unwrap();
        assert_eq!((p.x, p.y), (1920 + (2560 - 960) / 2, (1400 - 920) / 2));
    }

    #[test]
    fn the_default_never_exceeds_90_percent_of_a_small_work_area() {
        // the 1620 x 648 display of QA round 8: at most 583 px high
        let mons = vec![mon(0, 0, 1620, 648, 1.0, true)];
        let r = place(Kind::Compose, None, &mons, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (960, 583));
        assert!(mons[0].work.contains(&r));
        // and the minimum is respected where the area allows it (440 <= 583)
        let r = place(Kind::Reader, None, &mons, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (1040, 583));
        // a tiny area: the window is the area, no larger
        let tiny = vec![mon(0, 0, 500, 300, 1.0, true)];
        let r = place(Kind::Compose, None, &tiny, None, None).rect.unwrap();
        assert!(r.w <= 500 && r.h <= 300, "{r:?}");
    }

    /// fix34 (owner: the defaults are larger): on a laptop screen every default is cut to 90 % of the work area, so the whole window, title bar included, is on screen; a size the
    /// person chose still wins over the default.
    #[test]
    fn the_larger_defaults_still_fit_a_laptop_screen_and_a_saved_size_still_wins() {
        // 1366 x 768 with the task bar (40 px): work area 1366 x 728; 1280 x 720 with the task bar: 1280 x 680; a 1536 x 864 logical screen at 125 % (physical 1920 x 1080, work 1920 x 1040)
        for (work, scale) in [((1366, 728), 1.0), ((1280, 680), 1.0), ((1920, 1040), 1.25)] {
            let mons = vec![mon(0, 0, work.0, work.1, scale, true)];
            for k in KINDS {
                let r = place(k, None, &mons, None, None).rect.unwrap();
                assert!(mons[0].work.contains(&r), "{k:?} on {work:?}: {r:?} is not inside the work area");
                assert!(r.w <= (work.0 as f64 * 0.9) as i32 && r.h <= (work.1 as f64 * 0.9) as i32, "{k:?} on {work:?}: {r:?} is more than 90 % of the area");
                let (min_w, min_h) = k.min_size();
                assert!(r.w >= (min_w * scale) as i32 && r.h >= (min_h * scale) as i32, "{k:?} on {work:?}: {r:?} is below the minimum");
            }
        }
        // the compose window on 1366 x 728: 960 wide (a 1229 cap), 655 high (90 % of 728), centred over the primary monitor
        let mons = vec![mon(0, 0, 1366, 728, 1.0, true)];
        let r = place(Kind::Compose, None, &mons, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (960, 655));
        assert_eq!((r.x, r.y), (683 - 480, 364 - 327), "centred: centre of the area minus half the window");
        // what the person resized to is kept, the default only applies to the first open of a kind
        let saved_size = place(Kind::Compose, Some(&saved(100, 40, 700.0, 600.0)), &mons, None, None).rect.unwrap();
        assert_eq!((saved_size.w, saved_size.h), (700, 600));
    }

    /// fix48 (owner: the message and reader windows open taller): the 90 % cap still keeps a small screen's window inside the work area, and a 1080p area is large enough
    /// for the new Compose height as it is (no cap) while the Reader (960 > 936) is cut to the cap.
    #[test]
    fn the_taller_compose_and_reader_defaults_are_capped_on_small_screens_and_uncapped_on_1080p() {
        // 1366 x 768 with scale 1.0 and no task bar taken off: 90 % of 768 is 691.2, so at most 691 px high; the window is inside the area
        let small = vec![mon(0, 0, 1366, 768, 1.0, true)];
        for k in [Kind::Compose, Kind::Reader] {
            let r = place(k, None, &small, None, None).rect.unwrap();
            assert!(small[0].work.contains(&r), "{k:?}: {r:?} is not inside the work area");
            assert!(r.h <= (768.0_f64 * 0.9) as i32, "{k:?}: {r:?} is more than 90 % of 768");
            assert_eq!(r.h, 691, "{k:?}: cut to the cap, not to its default");
            assert!(r.h >= k.min_size().1 as i32, "{k:?}: below the minimum");
        }
        // 1920 x 1040 (1080p minus the task bar): the cap is 936; Compose 920 fits whole, Reader 960 is cut to 936; the widths are the defaults
        let hd = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let c = place(Kind::Compose, None, &hd, None, None).rect.unwrap();
        assert_eq!((c.w, c.h), (960, 920), "Compose uncapped: 920 <= 936");
        assert!(hd[0].work.contains(&c));
        let r = place(Kind::Reader, None, &hd, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (1040, 936), "Reader cut to 90 % of 1040");
        assert!(hd[0].work.contains(&r));
        // a taller work area (1920 x 1200 minus the task bar: 1160, cap 1044) shows the Reader whole
        let tall = vec![mon(0, 0, 1920, 1160, 1.0, true)];
        let r = place(Kind::Reader, None, &tall, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (1040, 960));
        // what the person saved still wins over the new defaults
        let r = place(Kind::Compose, Some(&saved(100, 40, 960.0, 780.0)), &hd, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (960, 780), "a saved size is kept");
    }

    #[test]
    fn sizes_follow_the_scale_of_the_monitor() {
        // 150 %: 960 x 920 logical = 1440 x 1380 physical, inside 90 % of 2560 x 1600 (the height 1380 <= 1440)
        let mons = vec![mon(0, 0, 2560, 1600, 1.5, true)];
        let p = place(Kind::Compose, None, &mons, None, None);
        let r = p.rect.unwrap();
        assert_eq!((r.w, r.h), (1440, 1380));
        assert_eq!(p.size, (960.0, 920.0), "the logical size asked of the window system");
    }

    #[test]
    fn a_saved_place_is_used_while_at_least_half_of_it_is_visible() {
        let mons = big();
        let s = saved(300, 200, 700.0, 600.0);
        assert_eq!(place(Kind::Compose, Some(&s), &mons, None, None).rect, Some(rect(300, 200, 700, 600)));
        // 60 % visible (hangs 40 % over the right edge): still used, and brought fully inside the area
        let s = saved(1920 - 420, 200, 700.0, 600.0);
        let r = place(Kind::Compose, Some(&s), &mons, None, None).rect.unwrap();
        assert_eq!(r, rect(1920 - 700, 200, 700, 600), "clamped into the work area, not resized");
        // only 30 % visible: the saved place is not used, the window is centred over main
        let s = saved(1920 - 210, 200, 700.0, 600.0);
        let r = place(Kind::Compose, Some(&s), &mons, Some(rect(0, 0, 1280, 800)), None).rect.unwrap();
        assert_eq!(r, rect(640 - 350, 400 - 300, 700, 600), "the saved size is kept, the place is the fallback");
        // a monitor that was unplugged: the saved place is off every monitor
        let s = saved(3000, 100, 700.0, 600.0);
        let r = place(Kind::Compose, Some(&s), &mons, None, None).rect.unwrap();
        assert!(mons[0].work.contains(&r), "{r:?}");
    }

    #[test]
    fn a_saved_place_on_another_monitor_stays_there() {
        let mons = vec![mon(0, 0, 1920, 1040, 1.0, true), mon(1920, 0, 1920, 1040, 1.0, false)];
        let s = saved(2200, 100, 700.0, 600.0);
        assert_eq!(place(Kind::Compose, Some(&s), &mons, None, None).rect, Some(rect(2200, 100, 700, 600)));
        // a window across the seam is half on each: visible
        let s = saved(1700, 100, 700.0, 600.0);
        assert!(place(Kind::Compose, Some(&s), &mons, None, None).rect.is_some());
        // a monitor to the left of the primary has negative coordinates
        let mons = vec![mon(0, 0, 1920, 1040, 1.0, true), mon(-1280, 0, 1280, 1024, 1.0, false)];
        let s = saved(-1000, 50, 700.0, 600.0);
        assert_eq!(place(Kind::Compose, Some(&s), &mons, None, None).rect, Some(rect(-1000, 50, 700, 600)));
    }

    #[test]
    fn a_saved_size_is_kept_but_never_larger_than_the_work_area_or_below_the_minimum() {
        let mons = vec![mon(0, 0, 1000, 700, 1.0, true)];
        let r = place(Kind::Compose, Some(&saved(0, 0, 5000.0, 5000.0)), &mons, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (1000, 700));
        let r = place(Kind::Compose, Some(&saved(10, 10, 100.0, 100.0)), &mons, None, None).rect.unwrap();
        assert_eq!((r.w, r.h), (560, 440), "the minimum of the kind");
        // a nonsense size falls back to the default
        let r = place(Kind::Compose, Some(&saved(10, 10, 0.0, -3.0)), &mons, None, None).rect.unwrap();
        assert_eq!(r.w, 960.min((1000.0 * 0.9) as i32));
        // maximized is carried
        let s = Saved { maximized: true, ..saved(10, 10, 700.0, 600.0) };
        assert!(place(Kind::Compose, Some(&s), &mons, None, None).maximized);
    }

    #[test]
    fn a_second_window_of_a_kind_cascades_and_wraps() {
        let mons = big();
        let first = place(Kind::Compose, None, &mons, Some(rect(0, 0, 1280, 800)), None).rect.unwrap();
        let second = place(Kind::Compose, None, &mons, Some(rect(0, 0, 1280, 800)), Some(first)).rect.unwrap();
        assert_eq!((second.x, second.y), (first.x + CASCADE, first.y + CASCADE));
        assert_eq!((second.w, second.h), (first.w, first.h));
        // 150 %: the offset is 42 physical pixels
        let m150 = vec![mon(0, 0, 2880, 1560, 1.5, true)];
        let f = place(Kind::Compose, None, &m150, None, None).rect.unwrap();
        let s = place(Kind::Compose, None, &m150, None, Some(f)).rect.unwrap();
        assert_eq!((s.x - f.x, s.y - f.y), (42, 42));
        // the next one would leave the work area: it starts again at the place it would have had
        let low = rect(1920 - 960 - 10, 100, 960, 920);
        let wrapped = place(Kind::Compose, None, &mons, Some(rect(0, 0, 1280, 800)), Some(low)).rect.unwrap();
        assert_eq!(wrapped, first);
        let low = rect(300, 1040 - 920, 960, 920);
        assert_eq!(place(Kind::Compose, None, &mons, Some(rect(0, 0, 1280, 800)), Some(low)).rect.unwrap(), first);
    }

    #[test]
    fn no_monitor_known_leaves_the_place_to_the_system() {
        let p = place(Kind::Reader, None, &[], None, None);
        assert_eq!(p.rect, None);
        assert_eq!(p.size, (1040.0, 960.0));
        let p = place(Kind::Reader, Some(&saved(5, 5, 600.0, 500.0)), &[], None, None);
        assert_eq!((p.rect, p.size), (None, (600.0, 500.0)));
    }

    #[test]
    fn what_is_written_down_reads_back() {
        let e = Entry {
            label: t("compose-1"), kind: Kind::Compose, keys: vec![], token: t("x"), ready: true, ready_at: None, init: None,
            rect: Some(rect(100, 200, 1140, 1020)), scale: 1.5, maximized: false, moves: 1, dirty: true, retiring: false, content: false, deaths: 0, recovery_id: None,
        };
        let s = saved_of(&e).unwrap();
        assert_eq!(s, Saved { x: 100, y: 200, w: 760.0, h: 680.0, maximized: false });
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<Saved>(&json).unwrap(), s);
        // an older or damaged value: missing "maximized" is fine, garbage is no place at all
        assert!(serde_json::from_str::<Saved>(r#"{"x":1,"y":2,"w":3.0,"h":4.0}"#).is_ok());
        assert!(serde_json::from_str::<Saved>("nonsense").is_err());
        // nothing known yet, or an empty rectangle: nothing to write
        assert_eq!(saved_of(&Entry { rect: None, ..e.clone() }), None);
        assert_eq!(saved_of(&Entry { rect: Some(rect(0, 0, 0, 0)), ..e }), None);
    }

    fn entry() -> Entry {
        Entry {
            label: t("compose-1"), kind: Kind::Compose, keys: vec![], token: t("x"), ready: false, ready_at: None, init: None,
            rect: Some(rect(494, 258, 950, 850)), scale: 1.25, maximized: false, moves: 0, dirty: false, retiring: false, content: false, deaths: 0, recovery_id: None,
        }
    }

    #[test]
    fn the_events_after_creation_are_not_a_decision_of_the_person() {
        let mut e = entry();
        // the window is sized and placed after it was built: the same rectangle (within a pixel or two of rounding)
        assert!(!apply_geometry(&mut e, Some(rect(494, 258, 950, 850)), 1.25, false, false));
        assert!(!apply_geometry(&mut e, Some(rect(495, 257, 951, 849)), 1.25, false, false));
        assert_eq!((e.moves, e.dirty), (0, false), "nothing to write down");
        assert_eq!(saved_of(&e).filter(|_| e.dirty), None, "and a close writes nothing either");
    }

    #[test]
    fn a_move_or_a_resize_is_written_down_and_a_new_one_supersedes_it() {
        let mut e = entry();
        assert!(apply_geometry(&mut e, Some(rect(300, 150, 950, 850)), 1.25, false, false), "moved");
        assert_eq!((e.moves, e.dirty, e.rect), (1, true, Some(rect(300, 150, 950, 850))));
        assert!(apply_geometry(&mut e, Some(rect(300, 150, 875, 750)), 1.25, false, false), "resized");
        assert_eq!(e.moves, 2, "the delayed write of move 1 sees that move 2 came after it and does not run");
        let s = saved_of(&e).unwrap();
        assert_eq!((s.x, s.y, s.w, s.h), (300, 150, 700.0, 600.0));
        // another scale factor (the window crossed to another monitor) is remembered with the rectangle
        assert!(apply_geometry(&mut e, Some(rect(2000, 100, 1200, 1000)), 2.0, false, false));
        assert_eq!(saved_of(&e).map(|s| (s.w, s.h)), Some((600.0, 500.0)));
    }

    #[test]
    fn minimized_and_full_screen_windows_report_nothing_worth_keeping() {
        let mut e = entry();
        assert!(!apply_geometry(&mut e, Some(rect(-32000, -32000, 160, 28)), 1.25, false, true), "minimized: Windows reports -32000");
        assert_eq!((e.rect, e.dirty), (Some(rect(494, 258, 950, 850)), false));
    }

    #[test]
    fn a_maximized_window_keeps_its_last_normal_rectangle_and_the_flag() {
        let mut e = entry();
        assert!(apply_geometry(&mut e, Some(rect(-10, -10, 1940, 1060)), 1.25, true, false), "maximized");
        assert_eq!((e.maximized, e.rect, e.dirty), (true, Some(rect(494, 258, 950, 850)), true), "restoring gives the normal rectangle back");
        assert!(saved_of(&e).unwrap().maximized);
        // moving events while maximized change nothing more
        assert!(!apply_geometry(&mut e, Some(rect(-8, -8, 1936, 1056)), 1.25, true, false));
        // restored: the flag goes, the rectangle is the normal one again
        assert!(apply_geometry(&mut e, Some(rect(494, 258, 950, 850)), 1.25, false, false), "the flag changed");
        assert!(!e.maximized && !saved_of(&e).unwrap().maximized);
    }

    // ---- W4.2: a window whose page process dies

    /// REQ-4.2.2: the reaction table, kinds 0..8 x deaths 0 / 1 (and more).
    #[test]
    fn a_failed_page_process_of_a_window_reloads_it_once_then_closes_it() {
        for deaths in 0..4u32 {
            // the browser process of the whole web view: the main window's hook restarts the app, never a window's
            assert_eq!(popout_failure(0, deaths), PageFailure::Ignore);
            // unresponsive, utility, sandbox helper, GPU, plugin, plugin broker, unknown: the log only
            for kind in [2, 4, 5, 6, 7, 8, 9, -1] {
                assert_eq!(popout_failure(kind, deaths), PageFailure::LogOnly, "kind {kind}");
            }
        }
        for kind in [1, 3] {
            assert_eq!(popout_failure(kind, 0), PageFailure::Reload, "the first death reloads (kind {kind})");
            assert_eq!(popout_failure(kind, 1), PageFailure::Close, "the second ends the window (kind {kind})");
            assert_eq!(popout_failure(kind, 5), PageFailure::Close);
        }
    }

    /// REQ-4.2.3: a reloaded window keeps its label, its keys and its place; it is not ready until its page says so; the page gets the snapshot id.
    #[test]
    fn a_reloaded_window_keeps_its_label_key_and_place() {
        let mut r = Registry::default();
        let Request::Create { label } = r.request(Kind::Compose, Some("draft:t1"), "tok".into(), Some(serde_json::json!({ "to": ["a@b"] }))) else { panic!() };
        {
            let e = r.get_mut(&label).unwrap();
            e.ready = true;
            e.content = true;
            e.rect = Some(Rect { x: 10, y: 20, w: 800, h: 600 });
            e.recovery_id = Some("0f3c-1".into());
        }
        // what page_failed does to the entry on a first death
        let e = r.get_mut(&label).unwrap();
        assert_eq!(popout_failure(1, e.deaths), PageFailure::Reload);
        e.deaths += 1;
        e.ready = false;
        e.content = false;
        assert_eq!(r.get(&label).unwrap().label, label);
        assert_eq!(r.get(&label).unwrap().keys, ["draft:t1"]);
        assert_eq!(r.get(&label).unwrap().rect, Some(Rect { x: 10, y: 20, w: 800, h: 600 }));
        assert_eq!(r.get(&label).unwrap().init, Some(serde_json::json!({ "to": ["a@b"] })), "the hand-off data stays");
        assert_eq!(r.get(&label).unwrap().recovery_id.as_deref(), Some("0f3c-1"));
        assert!(r.ready_labels().is_empty(), "a quit does not ask a page that is loading (REQ-4.2.5)");
        assert_eq!(r.request(Kind::Compose, Some("draft:t1"), "t2".into(), None), Request::Focus { label: label.clone() }, "the draft lock holds");
        assert_eq!(popout_failure(3, r.get(&label).unwrap().deaths), PageFailure::Close);
        assert!(is_recovery_id("0f3c-1") && is_recovery_id(&"a".repeat(36)) && !is_recovery_id("") && !is_recovery_id("../x") && !is_recovery_id(&"a".repeat(65)));
    }

    /// REQ-4.2.1: every window kind is watched when it is made, on Windows and Linux; the reaction has no per-system branch.
    #[test]
    fn every_secondary_window_is_watched_at_creation() {
        let src = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let create = &src[src.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        assert!(create.contains("watch_page_process(app, &win, label)"), "{create}");
        let watch = &src[src.find("fn watch_page_process(").unwrap()..];
        let watch = &watch[..watch.find("\n}\n").unwrap()];
        assert!(watch.contains("#[cfg(windows)]\n    crate::webview_health::watch_window(") && watch.contains("#[cfg(target_os = \"linux\")]\n    crate::linuxview::watch_window("), "{watch}");
        let react = &src[src.find("pub fn popout_failure(").unwrap()..];
        let react = &react[..react.find("\n}\n").unwrap()];
        assert!(!react.contains("cfg(") && !react.contains("target_os"), "the reaction is the same on every system");
        let page = &src[src.find("pub fn page_failed(").unwrap()..];
        let page = &page[..page.find("\n}\n").unwrap()];
        assert!(!page.contains("restart_app") && !page.contains("recover_dead_page") && !page.contains("web_view_failed"), "the main window is never reloaded for a window's failure");
        assert!(page.contains("PageFailure::Close") && page.contains("CRASHED_EVENT") && page.contains("retire(app, label,"), "{page}");
        // both hooks hand the failure to the window manager
        let health = include_str!("webview_health.rs");
        assert!(health.contains("crate::popout::page_failed(&handler_app, &handler_label, kind, &detail)"));
        let linux = include_str!("linuxview.rs");
        assert!(linux.contains("crate::popout::page_failed(&on_end, &name, 1,") && linux.contains("crate::popout::page_failed(&on_change, &name, 2,"));
    }

    // ---- W4.4: a reader goes on to show another conversation

    #[test]
    fn a_reader_that_shows_another_conversation_takes_its_key_or_is_refused() {
        let mut r = Registry::default();
        let Request::Create { label: a } = r.request(Kind::Reader, Some("t-c"), "ta".into(), Some(serde_json::json!({ "threadId": "t-c" }))) else { panic!() };
        let Request::Create { label: b } = r.request(Kind::Reader, Some("t-e"), "tb".into(), Some(serde_json::json!({ "threadId": "t-e" }))) else { panic!() };
        // C goes on to D: the key and the hand-off data follow, the old key is free and the new one is held
        assert_eq!(r.show(&a, "t-d", serde_json::json!({ "threadId": "t-d" })), Show::Shown);
        assert_eq!(r.get(&a).unwrap().keys, ["t-d"]);
        assert_eq!(r.get(&a).unwrap().init, Some(serde_json::json!({ "threadId": "t-d" })), "a reload of the page shows D (W4.2)");
        assert_eq!(r.request(Kind::Reader, Some("t-c"), "t3".into(), None), Request::Create { label: "reader-3".into() }, "C is free again: opening it makes a window");
        assert_eq!(r.request(Kind::Reader, Some("t-d"), "t4".into(), None), Request::Focus { label: a.clone() }, "opening D focuses this window");
        // D goes on to E, which window b shows: refused with that window to bring forward; nothing changes here
        assert_eq!(r.show(&a, "t-e", serde_json::json!({ "threadId": "t-e" })), Show::Focus { label: b.clone() });
        assert_eq!(r.get(&a).unwrap().keys, ["t-d"]);
        assert_eq!(r.get(&b).unwrap().keys, ["t-e"]);
        // to its own key again is no conflict; a window that is not known, or on its way out, is refused
        assert_eq!(r.show(&a, "t-d", serde_json::json!(null)), Show::Shown);
        assert_eq!(r.show("reader-99", "t-x", serde_json::json!(null)), Show::Unknown);
        r.start_retire(&b);
        assert_eq!(r.show(&b, "t-y", serde_json::json!(null)), Show::Unknown);
        assert_eq!(r.show(&a, "t-e", serde_json::json!(null)), Show::Shown, "the key of a window on its way out is free");
    }

    /// The command is a reader's alone, and in the three places.
    #[test]
    fn popout_show_is_a_reader_command_in_the_three_places() {
        let src = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let f = &src[src.find("pub fn popout_show(").unwrap()..];
        let f = &f[..f.find("
}
").unwrap()];
        assert!(f.contains("Some(Kind::Reader)"), "{f}");
        assert!(crate::test_guard::non_test_code(include_str!("lib.rs")).contains("popout::popout_show,"));
        assert!(include_str!("../build.rs").contains("\"popout_show\""));
        for cap in [include_str!("../capabilities/default.json"), include_str!("../capabilities/popout.json")] {
            assert!(cap.contains("\"allow-popout-show\""));
        }
    }

    // ---- W4.1: the macOS window release fix (tao PR #1368)

    /// A closed window must be released on macOS (REQ-4.1.1 / 4.1.2): tao 0.37.1 over-retains every window it creates (tao issue #1327). The fix is in tao
    /// commit 9aa859e (PR #1368), in crates.io from a 0.37.x after 0.37.1 (expected 0.37.2). The lock file has to say one of the two, and Cargo.toml
    /// has the patch line only in the first case, so that a `cargo update` cannot quietly lose the fix.
    #[test]
    fn tao_carries_the_macos_window_release_fix() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let lock = std::fs::read_to_string(root.join("Cargo.lock")).unwrap().replace("
", "
");
        let toml = crate::test_guard::non_test_code(&std::fs::read_to_string(root.join("Cargo.toml")).unwrap());
        let block = lock.split("
[[package]]
").find(|b| b.lines().next() == Some("name = \"tao\"")).expect("the tao package is in Cargo.lock");
        let version = block.lines().find_map(|l| l.strip_prefix("version = \"")).and_then(|v| v.strip_suffix('"')).expect("a version");
        let source = block.lines().find_map(|l| l.strip_prefix("source = \"")).and_then(|v| v.strip_suffix('"')).unwrap_or("");
        let pinned = source.starts_with("git+https://github.com/tauri-apps/tao?rev=9aa859e1fe61d664f8fd33f4593f9fac4a0012d5#");
        let patch_line = toml.lines().any(|l| l.starts_with("tao = { git = \"https://github.com/tauri-apps/tao\", rev = \"9aa859e1fe61d664f8fd33f4593f9fac4a0012d5\" }"));
        if pinned {
            assert!(patch_line, "Cargo.lock pins tao to 9aa859e but Cargo.toml [patch.crates-io] has no tao line");
        } else {
            let mut parts = version.split('.').map(|n| n.parse::<u32>().unwrap_or(0));
            let (major, minor, patch) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
            assert!(source.starts_with("registry+") && (major, minor) == (0, 37) && patch >= 2, "tao {version} from {source:?} does not carry PR #1368 (a registry tao >= 0.37.2 or the git pin 9aa859e)");
            assert!(!patch_line, "the tao patch line is still in Cargo.toml although the registry tao carries the fix: remove it");
        }
    }

    // ---- the window system (source guards)

    /// A secondary window is created hidden, with the native title bar, and shown by its page (REQ-W1, W2, W8); nothing but the backend
    /// creates windows.
    #[test]
    fn windows_are_made_hidden_by_the_backend_only() {
        let src = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let create = &src[src.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        for needle in [".visible(false)", ".decorations(true)", ".disable_drag_drop_handler()", "watch_ready("] {
            assert!(create.contains(needle), "{needle}: {create}");
        }
        // the page opens as `index.html?w=<kind>&t=<token>`: no personal data in the address (REQ-S3)
        assert!(create.contains(r#"format!("index.html?w={}&t={token}", kind.name())"#));
        // no window is created from the pages: the permission to do so is granted to nobody
        let caps = std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")).unwrap();
        for f in caps {
            let text = std::fs::read_to_string(f.unwrap().path()).unwrap();
            assert!(!text.contains("create-webview-window") && !text.contains("webview:allow-create"), "a page may create windows: {text}");
        }
    }
}
