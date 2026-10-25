//! The ghost of a hidden window (1.0.9, owner: an all-white window at the start with Windows, no taskbar button, a click on the tray icon makes the UI appear).
//!
//! What was measured on the owner's PC (a tray start of 1.0.8, still running) and on a QA build (see coder-v109-autostart-tray.md): the main window is hidden
//! (`IsWindowVisible` false for it and all its children, no taskbar button, not cloaked, `startup.log` says "window stays hidden (tray start)") and yet a pure
//! white rectangle with the window's shadow is painted on the desktop at the window's place. It belongs to the hidden window (moving the window moves it, nothing
//! else owns a window there: `WindowFromPoint` answers the desktop). It is drawn from the moment the window and its web view are made (a fade-in of about 90 ms,
//! sampled at the pixel) when the window has NEVER been shown; a window that was shown and hidden again (close to the tray) leaves nothing, and a `ShowWindow(SW_SHOWNA)`
//! followed by `SW_HIDE` of a ghost removes it. The pixel looks of `startup.rs` read pixels only after a show, and a hidden window is no show, so nothing saw it.
//!
//! What this file does:
//! - a tray start parks its window right after it is made: moved to a place that is on no monitor (`PARK_AT`; tao ignores a creation position that is on no monitor), and
//!   given its place back (where the system had put it) by `unpark`, which `shell::show_main` calls before the first show. Whatever the compositor draws for a
//!   never-shown window is then drawn where nobody sees it. The page still loads, so the first open shows an already running UI.
//! - a look (`look`) reads the screen at the place of the hidden window: points where the desktop is the window under the point and the colour is pure white are a ghost.
//!   A tray start looks after it was made, and a window that was hidden by the close button looks after the hide; a ghost is healed by parking the window (`park`, the
//!   place it had is kept and given back at the next show). Both are logged (`[ghost ...]`).
//!
//! macOS / Linux: no such window ghost is known (the compositors do not draw a hidden window); nothing here runs there, the pure parts are tested everywhere.
#![cfg_attr(not(windows), allow(dead_code))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

/// Where a parked window is made, in logical pixels on both axes (on no monitor; physical -12500 at 125 %, -30000 at 300 %: inside the 16-bit range window messages use).
pub const PARK_AT: f64 = -10_000.0;
/// A window whose left edge is left of this is parked (physical pixels).
const PARKED_BELOW: i32 = -5_000;
/// How far from the window rectangle's edge the look starts (pixels).
#[cfg(windows)]
const INSET: i32 = 12;

/// The window is parked (made off-screen at a tray start, or moved there by a heal).
static PARKED: AtomicBool = AtomicBool::new(false);
/// Where a parked window was before it was parked (None: it cannot be told, so `unpark` centres it).
static RESTORE: Mutex<Option<(i32, i32)>> = Mutex::new(None);

/// `HEYLOOK_TEST_GHOST` (debug builds only): `keep` = neither parking nor healing (the control: the ghost stays), `look` = no parking at creation, the looks heal.
fn test_mode() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("HEYLOOK_TEST_GHOST").ok().map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty()) } else { None }
}

/// Is a tray start's window made parked? (The test seam can switch it off.)
pub fn park_at_creation() -> bool {
    !matches!(test_mode().as_deref(), Some("keep") | Some("look"))
}

/// Do the looks heal a ghost? (The test seam can switch it off.)
pub fn heal_enabled() -> bool {
    test_mode().as_deref() != Some("keep")
}

// ---------- pure decisions ----------

/// Enough of the desktop points at the window's place are pure white to call it a ghost: at least 30 such points, 85 % of them white.
pub fn is_ghost(desktop_points: usize, white: usize) -> bool {
    desktop_points >= 30 && white * 100 >= desktop_points * 85
}

/// Where a window of `win` (w, h) goes on a work area `(x, y, w, h)`: centred, and never left of / above the area.
pub fn centered(area: (i32, i32, i32, i32), win: (i32, i32)) -> (i32, i32) {
    (area.0 + ((area.2 - win.0) / 2).max(0), area.1 + ((area.3 - win.1) / 2).max(0))
}

/// Is a window whose left edge is at `left` on no monitor, i.e. parked?
pub fn is_parked_place(left: i32) -> bool {
    left < PARKED_BELOW
}

/// What a look found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Look {
    /// The window is on screen (a ghost is no concern then: the pixel looks of a show take over).
    Visible,
    /// No point of the window's place is on the desktop (the window is parked, or other windows cover it): nothing to see.
    Nothing,
    Clean { desktop: usize, white: usize },
    Ghost { desktop: usize, white: usize },
    Failed(String),
}

pub fn describe(l: &Look) -> String {
    match l {
        Look::Visible => "the window is on screen".into(),
        Look::Nothing => "no point of the window's place shows the desktop (parked off-screen, or covered)".into(),
        Look::Clean { desktop, white } => format!("clean: {white} of {desktop} desktop points at the window's place are pure white"),
        Look::Ghost { desktop, white } => format!("GHOST: {white} of {desktop} desktop points at the window's place are pure white although the window is hidden"),
        Look::Failed(e) => format!("could not look: {e}"),
    }
}

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use super::*;
    use tauri::Manager;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetClassNameW, GetWindowRect, IsWindowVisible, SetWindowPos, WindowFromPoint, GA_ROOT, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};

    fn main_hwnd(app: &AppHandle) -> Option<HWND> {
        app.get_webview_window("main")?.hwnd().ok()
    }

    pub fn rect_of(app: &AppHandle) -> Option<RECT> {
        let hwnd = main_hwnd(app)?;
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut r).ok()? };
        Some(r)
    }

    pub fn look(app: &AppHandle) -> Look {
        let Some(hwnd) = main_hwnd(app) else { return Look::Failed("no window".into()) };
        unsafe {
            if IsWindowVisible(hwnd).as_bool() {
                return Look::Visible;
            }
            let mut r = RECT::default();
            if let Err(e) = GetWindowRect(hwnd, &mut r) {
                return Look::Failed(e.to_string());
            }
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            if w < 200 || h < 200 || w > 8000 || h > 8000 {
                return Look::Failed(format!("the window is {w}x{h}"));
            }
            let screen = GetDC(None);
            let (mut desktop, mut white) = (0usize, 0usize);
            // (the points lie inside the visible window: the rectangle of a window has an invisible resizing border of about 8 px, where the wallpaper shows)
            for (x, y) in crate::startup::grid_points(w - 2 * INSET, h - 2 * INSET, 32, 20) {
                let at = POINT { x: r.left + INSET + x, y: r.top + INSET + y };
                let under = WindowFromPoint(at);
                if under.0.is_null() {
                    continue; // (on no monitor)
                }
                let root = GetAncestor(under, GA_ROOT);
                let mut name = [0u16; 64];
                let n = GetClassNameW(if root.0.is_null() { under } else { root }, &mut name) as usize;
                let class = String::from_utf16_lossy(&name[..n.min(64)]);
                if class != "Progman" && class != "WorkerW" {
                    continue; // (another window: it says nothing about ours)
                }
                let c = GetPixel(screen, at.x, at.y).0;
                if c == 0xFFFF_FFFF {
                    continue; // (CLR_INVALID)
                }
                desktop += 1;
                if (c & 0xFF) >= 250 && ((c >> 8) & 0xFF) >= 250 && ((c >> 16) & 0xFF) >= 250 {
                    white += 1;
                }
            }
            ReleaseDC(None, screen);
            if desktop == 0 {
                Look::Nothing
            } else if is_ghost(desktop, white) {
                Look::Ghost { desktop, white }
            } else {
                Look::Clean { desktop, white }
            }
        }
    }

    /// Moves the window to the parked place. True when it moved.
    pub fn park(app: &AppHandle) -> bool {
        let (Some(hwnd), Some(r)) = (main_hwnd(app), rect_of(app)) else { return false };
        if !is_parked_place(r.left) {
            *RESTORE.lock().unwrap_or_else(|p| p.into_inner()) = Some((r.left, r.top));
        }
        let scale = app.get_webview_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
        let at = (PARK_AT * scale).round() as i32;
        let moved = unsafe { SetWindowPos(hwnd, None, at, at, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE).is_ok() };
        if moved {
            PARKED.store(true, Ordering::SeqCst);
        }
        moved
    }

    /// Gives a parked window its place back (where it was, or centred on the monitor of the pointer, else the primary one) before it is shown.
    pub fn unpark(app: &AppHandle) {
        let Some(w) = app.get_webview_window("main") else { return };
        let t0 = std::time::Instant::now();
        let restore = RESTORE.lock().unwrap_or_else(|p| p.into_inner()).take();
        let place = match restore {
            Some(p) => Some(p),
            None => {
                let size = w.outer_size().ok().map(|s| (s.width as i32, s.height as i32));
                let monitor = app.cursor_position().ok().and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten()).or_else(|| app.primary_monitor().ok().flatten());
                match (monitor, size) {
                    (Some(m), Some(sz)) => {
                        let a = m.work_area();
                        Some(centered((a.position.x, a.position.y, a.size.width as i32, a.size.height as i32), sz))
                    }
                    _ => None,
                }
            }
        };
        if let Some((x, y)) = place {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        crate::startup::line("ghost", &format!("the parked window gets its place back ({}) before it is shown, in {} ms", place.map(|(x, y)| format!("{x},{y}")).unwrap_or_else(|| "no monitor: left where it is".into()), t0.elapsed().as_millis()));
    }
}

/// Reads the screen at the hidden window's place (Windows; elsewhere nothing to see).
pub fn look(app: &AppHandle) -> Look {
    #[cfg(windows)]
    return win::look(app);
    #[cfg(not(windows))]
    {
        let _ = app;
        Look::Nothing
    }
}

/// Moves the hidden main window to the parked place (Windows). True when it moved.
#[cfg(windows)]
pub fn park(app: &AppHandle) -> bool {
    win::park(app)
}

/// Before `shell::show_main` shows the main window: a parked window goes to the screen.
pub fn unpark(app: &AppHandle) {
    if PARKED.swap(false, Ordering::SeqCst) {
        #[cfg(windows)]
        win::unpark(app);
        #[cfg(not(windows))]
        let _ = app;
    }
}

/// Looks at the hidden main window `at_ms` after now (each entry after the one before it) and heals a ghost by parking the window; every look is logged. `why` says what
/// the looks are for. Ends at the first look that finds the window on screen or the app quitting. Windows only.
pub fn watch_hidden(app: &AppHandle, why: &'static str, at_ms: &'static [u64]) {
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut last = 0;
            for &ms in at_ms {
                std::thread::sleep(std::time::Duration::from_millis(ms - last));
                last = ms;
                if crate::startup::is_exiting() {
                    return;
                }
                let found = look(&app);
                if matches!(found, Look::Visible) {
                    return; // (shown by now: the looks of the show take over)
                }
                crate::startup::line("ghost", &format!("look {ms} ms after {why}: {}", describe(&found)));
                if matches!(found, Look::Ghost { .. }) && heal_enabled() {
                    let moved = win::park(&app);
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    crate::startup::line("ghost", &format!("healed by parking the window ({}): {}", if moved { "moved" } else { "could not move it" }, describe(&look(&app))));
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, why, at_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ghost_is_most_of_the_desktop_points_pure_white() {
        assert!(is_ghost(100, 90) && is_ghost(100, 100) && is_ghost(30, 26));
        assert!(!is_ghost(100, 84), "a wallpaper with white areas is no ghost");
        assert!(!is_ghost(29, 29), "too few desktop points to say");
        assert!(!is_ghost(0, 0));
    }

    #[test]
    fn a_window_is_centred_on_the_work_area_and_never_leaves_its_top_left() {
        assert_eq!(centered((0, 0, 2560, 1400), (1600, 1000)), (480, 200));
        assert_eq!(centered((2560, 0, 1920, 1040), (1280, 800)), (2560 + 320, 120), "a second monitor on the right");
        assert_eq!(centered((-1920, 0, 1920, 1040), (1280, 800)), (-1920 + 320, 120), "a monitor on the left");
        assert_eq!(centered((0, 0, 1000, 600), (1280, 800)), (0, 0), "a window bigger than the area starts at its corner");
    }

    #[test]
    fn the_parked_place_is_on_no_monitor_and_inside_the_range_of_window_messages() {
        assert!(is_parked_place(-12_500) && is_parked_place(-30_000) && is_parked_place(-10_001));
        assert!(!is_parked_place(0) && !is_parked_place(-1_900) && !is_parked_place(160));
        for scale in [1.0, 1.25, 1.5, 2.0, 2.5, 3.0] {
            let at = (PARK_AT * scale) as i32;
            assert!(is_parked_place(at) && at > -32_768, "scale {scale}: {at}");
        }
    }

    #[test]
    fn every_look_has_words_for_the_log() {
        assert!(describe(&Look::Ghost { desktop: 100, white: 95 }).starts_with("GHOST: 95 of 100"));
        assert!(describe(&Look::Clean { desktop: 100, white: 0 }).starts_with("clean"));
        assert!(describe(&Look::Nothing).contains("parked"));
        assert!(describe(&Look::Failed("x".into())).contains("x"));
    }

    /// The source of a file without its test modules (for the wiring tests).
    fn code(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(name);
        crate::test_guard::non_test_code(&std::fs::read_to_string(p).unwrap().replace('\r', ""))
    }

    #[test]
    fn a_tray_start_makes_its_window_parked_and_every_show_unparks_it() {
        let gate = code("startgate.rs");
        let start = &gate[gate.find("pub fn start(").unwrap()..];
        assert!(start.contains("ghost::park_at_creation()") && start.contains("crate::ghost::park(&app)"), "{start}");
        assert!(start.find(".build()").unwrap() < start.find("crate::ghost::park(&app)").unwrap() && start.find("crate::ghost::park(&app)").unwrap() < start.find("crate::startup::stage(Some(&app), \"window made after the start gate\")").unwrap(), "parked right after it was made, before anything else is done with it");
        let shell = code("shell.rs");
        let show = &shell[shell.find("pub fn show_main").unwrap()..];
        let show = &show[..show.find("\n}\n").unwrap()];
        assert!(show.contains("crate::ghost::unpark(app)") && show.find("ghost::unpark").unwrap() < show.find("w.show()").unwrap(), "{show}");
        // the looks: after a tray start's page is ready and after the close button hides the window
        assert!(code("startup.rs").contains("crate::ghost::watch_hidden(app, \"the tray start\""), "tray start");
        assert!(code("lib.rs").contains("ghost::watch_hidden(window.app_handle(), \"the window was hidden\""), "close to the tray");
    }
}
