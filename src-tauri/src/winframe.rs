//! Custom window frame (Windows only).
//!
//! On Windows the OS title bar is removed and the app's own top bar (`TopBar.tsx`) acts as the title bar. Dragging, Aero
//! Snap, double-click-to-maximize and the resize borders come from Tauri/tao (`data-tauri-drag-region`, undecorated
//! resizing, `WS_THICKFRAME` is kept so Win+Arrow and Alt+Space keep working). What this module adds:
//!
//! * **Caption button hit-testing.** The frontend reports the rectangle of its minimize/maximize/close button group
//!   (`frame_caption_rect`). We lay a tiny transparent child window over exactly that rectangle. Its `WM_NCHITTEST`
//!   answers `HTMINBUTTON` / `HTMAXBUTTON` / `HTCLOSE` (the same codes a real title bar returns), which is what makes
//!   Windows 11 show the Snap Layouts flyout on hover over the maximize button. Win+Z works without any of this.
//!   A child window is used (instead of subclassing WebView2's internal windows) because that is the same mechanism
//!   Tauri uses for its own resize borders and it does not depend on WebView2 internals.
//! * **Hover / pressed visuals.** Once a window answers the hit test, the webview no longer receives mouse events for
//!   that spot, so the non-client messages (`WM_NCMOUSEMOVE`, `WM_NCMOUSELEAVE`, `WM_NCLBUTTONDOWN/UP`) are turned into
//!   `frame-caption` events `{ hot, down }` for the buttons' styling, and a click (down and up on the same button)
//!   minimizes / toggles maximize / closes. Close goes through `WebviewWindow::close()`, i.e. the normal
//!   `CloseRequested` handler (close-to-tray, scheduled-message guard).
//! * **System menu** (`frame_system_menu`): right click on the bar shows Restore / Move / Size / Minimize / Maximize /
//!   Close. Alt+Space is handled natively by the window style.
//!
//! The same overlay is used on Windows 10 (no flyout there, everything else identical). If the overlay cannot be
//! created, `frame_caption_rect` returns false and the frontend keeps ordinary DOM buttons. macOS and Linux keep their
//! native decorations: every function here is a no-op for them.
use serde::Serialize;

// ---------- pure logic (unit tested) ----------

/// One of the three caption buttons.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Min,
    Max,
    Close,
}

/// Win32 non-client hit-test codes (`HTMINBUTTON`, `HTMAXBUTTON`, `HTCLOSE`).
// (items below are used by the Windows module and the tests only; other targets compile them without warnings)
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const HT_MIN: u32 = 8;
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const HT_MAX: u32 = 9;
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const HT_CLOSE: u32 = 20;

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn hit_code(z: Zone) -> u32 {
    match z {
        Zone::Min => HT_MIN,
        Zone::Max => HT_MAX,
        Zone::Close => HT_CLOSE,
    }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn zone_from_hit(code: u32) -> Option<Zone> {
    match code {
        HT_MIN => Some(Zone::Min),
        HT_MAX => Some(Zone::Max),
        HT_CLOSE => Some(Zone::Close),
        _ => None,
    }
}

/// The button under `x` (relative to the group's left edge) in a group `width` pixels wide: three equal buttons.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn zone_at(x: i32, width: i32) -> Option<Zone> {
    if width <= 0 || x < 0 || x >= width {
        return None;
    }
    match (x as i64 * 3) / width as i64 {
        0 => Some(Zone::Min),
        1 => Some(Zone::Max),
        _ => Some(Zone::Close),
    }
}

/// A rectangle in device pixels, relative to the window's client area.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// CSS-pixel rectangle `(x, y, w, h)` of the button group -> device pixels (`dpr` = `devicePixelRatio`). The edges are
/// rounded, not the size, so neighbouring rectangles stay gap-free. `None` for an empty / invalid rectangle (the
/// frontend sends zeros while the buttons are hidden, e.g. in fullscreen).
pub fn device_rect(css: (f64, f64, f64, f64), dpr: f64) -> Option<Rect> {
    let (x, y, w, h) = css;
    if ![x, y, w, h, dpr].iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 || dpr <= 0.0 {
        return None;
    }
    let (l, t) = ((x * dpr).round() as i32, (y * dpr).round() as i32);
    let (r, b) = (((x + w) * dpr).round() as i32, ((y + h) * dpr).round() as i32);
    let rect = Rect { x: l, y: t, w: r - l, h: b - t };
    (rect.w > 0 && rect.h > 0).then_some(rect)
}

/// Windows 11 (build 22000+) has Snap Layouts; Windows 10 only gets the plain buttons.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn snap_layouts_supported(build: u32) -> bool {
    build >= 22000
}

/// What the pointer is doing over the caption buttons.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Pointer {
    pub hot: Option<Zone>,
    pub down: Option<Zone>,
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
impl Pointer {
    /// Moved over `z` (None = not over a button). True when the visual state changed.
    pub fn moved(&mut self, z: Option<Zone>) -> bool {
        let old = *self;
        self.hot = z;
        // a pressed button stays "down" only while the pointer is still over it
        if self.down.is_some() && self.down != z {
            self.down = None;
        }
        *self != old
    }
    /// The pointer left the button group.
    pub fn left(&mut self) -> bool {
        self.moved(None)
    }
    pub fn pressed(&mut self, z: Option<Zone>) -> bool {
        let old = *self;
        self.hot = z;
        self.down = z;
        *self != old
    }
    /// Button released over `z`. Returns (state changed, the button that was clicked): a click needs the press and the
    /// release on the same button.
    pub fn released(&mut self, z: Option<Zone>) -> (bool, Option<Zone>) {
        let old = *self;
        let click = if z.is_some() && self.down == z { z } else { None };
        self.down = None;
        self.hot = z;
        (*self != old, click)
    }
}

// ---------- commands (same signatures on every OS) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    /// The OS title bar was removed: the app draws its own window buttons.
    pub custom: bool,
    /// Windows 11 Snap Layouts flyout is expected on the maximize button.
    pub snap_layouts: bool,
}

#[tauri::command]
pub fn frame_info() -> FrameInfo {
    imp::info()
}

/// Reports where the caption button group is (CSS px, relative to the viewport). Returns true when it is hit-tested
/// natively; false means "keep using the DOM buttons".
#[tauri::command]
pub async fn frame_caption_rect(app: tauri::AppHandle, x: f64, y: f64, w: f64, h: f64, dpr: f64) -> bool {
    let rect = device_rect((x, y, w, h), dpr);
    // the call waits for the UI thread: keep that wait off the async runtime's worker threads
    tauri::async_runtime::spawn_blocking(move || imp::set_caption_rect(&app, rect)).await.unwrap_or(false)
}

/// Shows the window's system menu at a point of the client area (CSS px).
#[tauri::command]
pub async fn frame_system_menu(app: tauri::AppHandle, x: f64, y: f64, dpr: f64) {
    // the menu is modal on the UI thread and can stay open a long time: wait for it on the blocking pool
    let _ = tauri::async_runtime::spawn_blocking(move || imp::system_menu(&app, (x * dpr).round() as i32, (y * dpr).round() as i32)).await;
}

/// Called once from `setup`: removes the OS frame on Windows.
pub fn setup(app: &tauri::App) {
    imp::setup(app);
}

// ---------- non-Windows: native decorations stay ----------

#[cfg(not(windows))]
mod imp {
    use super::{FrameInfo, Rect};

    pub fn setup(_app: &tauri::App) {}
    pub fn info() -> FrameInfo {
        FrameInfo { custom: false, snap_layouts: false }
    }
    pub fn set_caption_rect(_app: &tauri::AppHandle, _rect: Option<Rect>) -> bool {
        false
    }
    pub fn system_menu(_app: &tauri::AppHandle, _x: i32, _y: i32) {}
}

// ---------- Windows ----------

#[cfg(windows)]
mod imp {
    use super::{hit_code, snap_layouts_supported, zone_at, zone_from_hit, FrameInfo, Pointer, Rect, Zone};
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter, Manager};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static CUSTOM: AtomicBool = AtomicBool::new(false);
    /// HWND (as isize) of the caption-button hit-test window, 0 = not created.
    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    static POINTER: Mutex<Pointer> = Mutex::new(Pointer { hot: None, down: None });
    static TRACKING: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static WORKER: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();
    const SUBCLASS_ID: usize = 0x4845_594C;
    const LEAVE_TIMER: usize = 1;
    const CLASS: PCWSTR = w!("HEYLOOK_CAPTION_BUTTONS");

    enum Msg {
        State(Pointer),
        Click(Zone),
    }

    pub fn info() -> FrameInfo {
        let build = windows_version::OsVersion::current().build;
        FrameInfo { custom: CUSTOM.load(Ordering::Relaxed), snap_layouts: snap_layouts_supported(build) }
    }

    pub fn setup(app: &tauri::App) {
        let _ = APP.set(app.handle().clone());
        let Some(win) = app.get_webview_window("main") else { return };
        // the window starts hidden (visible: false), so no flash of the native frame
        if win.set_decorations(false).is_err() {
            return;
        }
        let _ = win.set_shadow(true); // DWM shadow + Windows 11 rounded corners for the undecorated window
        CUSTOM.store(true, Ordering::Relaxed);
        if let Ok(hwnd) = win.hwnd() {
            // Tauri raises its own resize-border child window after every WM_SIZE; raise ours right after it
            unsafe {
                let _ = SetWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID, 0);
            }
        }
        spawn_worker();
    }

    /// Emits state changes and performs clicks in order, off the window-procedure stack.
    fn spawn_worker() {
        let (tx, rx) = channel::<Msg>();
        if WORKER.set(Mutex::new(tx)).is_err() {
            return;
        }
        std::thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                let Some(app) = APP.get() else { continue };
                match msg {
                    Msg::State(p) => {
                        let _ = app.emit("frame-caption", p);
                    }
                    Msg::Click(z) => {
                        let Some(win) = app.get_webview_window("main") else { continue };
                        let _ = match z {
                            Zone::Min => win.minimize(),
                            Zone::Max => {
                                if win.is_maximized().unwrap_or(false) {
                                    win.unmaximize()
                                } else {
                                    win.maximize()
                                }
                            }
                            // CloseRequested handler in lib.rs decides: hide to tray / ask about scheduled mail / quit
                            Zone::Close => win.close(),
                        };
                    }
                }
            }
        });
    }

    fn send(msg: Msg) {
        if let Some(tx) = WORKER.get() {
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(msg);
            }
        }
    }

    fn main_hwnd(app: &AppHandle) -> Option<HWND> {
        app.get_webview_window("main")?.hwnd().ok()
    }

    unsafe extern "system" fn parent_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        unsafe {
            let res = DefSubclassProc(hwnd, msg, wparam, lparam);
            match msg {
                WM_SIZE => raise_overlay(),
                WM_NCDESTROY => {
                    OVERLAY.store(0, Ordering::Relaxed); // the child window is destroyed with its parent
                    let _ = RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
                }
                _ => {}
            }
            res
        }
    }

    fn overlay_hwnd() -> Option<HWND> {
        let v = OVERLAY.load(Ordering::Relaxed);
        (v != 0).then(|| HWND(v as *mut _))
    }

    fn raise_overlay() {
        if let Some(o) = overlay_hwnd() {
            unsafe {
                let _ = SetWindowPos(o, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
            }
        }
    }

    /// Creates / moves / hides the hit-test window on the UI thread. True = the buttons are hit-tested natively.
    pub fn set_caption_rect(app: &AppHandle, rect: Option<Rect>) -> bool {
        if !CUSTOM.load(Ordering::Relaxed) {
            return false;
        }
        let (tx, rx) = channel();
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                let ok = main_hwnd(&handle).map(|parent| unsafe { place(parent, rect) }).unwrap_or(false);
                let _ = tx.send(ok);
            })
            .is_err()
        {
            return false;
        }
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(false)
    }

    unsafe fn place(parent: HWND, rect: Option<Rect>) -> bool {
        unsafe {
            let Some(r) = rect else {
                if let Some(o) = overlay_hwnd() {
                    let _ = ShowWindow(o, SW_HIDE);
                    reset_pointer();
                }
                return false;
            };
            let overlay = match overlay_hwnd() {
                Some(o) => o,
                None => match create_overlay(parent) {
                    Some(o) => o,
                    None => return false,
                },
            };
            let moved = SetWindowPos(overlay, Some(HWND_TOP), r.x, r.y, r.w, r.h, SWP_NOACTIVATE | SWP_SHOWWINDOW).is_ok();
            if moved {
                reset_pointer();
            }
            moved
        }
    }

    unsafe fn create_overlay(parent: HWND) -> Option<HWND> {
        unsafe {
            let hinst = GetModuleHandleW(PCWSTR::null()).ok()?;
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(overlay_proc),
                hInstance: hinst.into(),
                lpszClassName: CLASS,
                ..Default::default()
            };
            RegisterClassExW(&class); // 0 when the class already exists (fine)
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS,
                w!("Window controls"),
                WS_CHILD | WS_CLIPSIBLINGS, // hidden until `place` sizes it (SWP_SHOWWINDOW)
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                Some(hinst.into()),
                None,
            )
            .ok()?;
            OVERLAY.store(hwnd.0 as isize, Ordering::Relaxed);
            Some(hwnd)
        }
    }

    fn reset_pointer() {
        TRACKING.store(false, Ordering::Relaxed);
        if let Some(o) = overlay_hwnd() {
            unsafe {
                let _ = KillTimer(Some(o), LEAVE_TIMER);
            }
        }
        if let Ok(mut p) = POINTER.lock() {
            if p.left() {
                send(Msg::State(*p));
            }
        }
    }

    fn lparam_point(l: LPARAM) -> POINT {
        POINT { x: (l.0 & 0xFFFF) as u16 as i16 as i32, y: ((l.0 >> 16) & 0xFFFF) as u16 as i16 as i32 }
    }

    unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_NCHITTEST => {
                    let pt = lparam_point(lparam);
                    let mut rc = RECT::default();
                    if GetWindowRect(hwnd, &mut rc).is_ok() {
                        if let Some(z) = zone_at(pt.x - rc.left, rc.right - rc.left) {
                            return LRESULT(hit_code(z) as isize);
                        }
                    }
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                WM_NCMOUSEMOVE => {
                    if !TRACKING.swap(true, Ordering::Relaxed) {
                        let mut t = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        let _ = TrackMouseEvent(&mut t);
                    }
                    update(|p| p.moved(zone_from_hit(wparam.0 as u32)));
                    LRESULT(0)
                }
                WM_NCMOUSELEAVE => {
                    TRACKING.store(false, Ordering::Relaxed);
                    // The Snap Layouts flyout opening under the pointer also ends the tracking while the pointer is still
                    // on the button: keep it highlighted (like the native title bar) until the pointer really leaves.
                    if pointer_inside(hwnd) {
                        SetTimer(Some(hwnd), LEAVE_TIMER, 80, None);
                    } else {
                        update(|p| p.left());
                    }
                    LRESULT(0)
                }
                WM_TIMER if wparam.0 == LEAVE_TIMER => {
                    if !pointer_inside(hwnd) {
                        let _ = KillTimer(Some(hwnd), LEAVE_TIMER);
                        update(|p| p.left());
                    }
                    LRESULT(0)
                }
                // we do our own press tracking: the default handler would run a modal loop that paints classic buttons
                WM_NCLBUTTONDOWN => {
                    update(|p| p.pressed(zone_from_hit(wparam.0 as u32)));
                    LRESULT(0)
                }
                WM_NCLBUTTONUP => {
                    let mut click = None;
                    if let Ok(mut p) = POINTER.lock() {
                        let (changed, c) = p.released(zone_from_hit(wparam.0 as u32));
                        click = c;
                        if changed {
                            send(Msg::State(*p));
                        }
                    }
                    if let Some(z) = click {
                        send(Msg::Click(z));
                    }
                    LRESULT(0)
                }
                WM_ERASEBKGND => LRESULT(1),
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    unsafe fn pointer_inside(hwnd: HWND) -> bool {
        unsafe {
            let (mut pt, mut rc) = (POINT::default(), RECT::default());
            GetCursorPos(&mut pt).is_ok() && GetWindowRect(hwnd, &mut rc).is_ok() && IsWindowVisible(hwnd).as_bool() && pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top && pt.y < rc.bottom
        }
    }

    fn update(f: impl FnOnce(&mut Pointer) -> bool) {
        if let Ok(mut p) = POINTER.lock() {
            if f(&mut p) {
                send(Msg::State(*p));
            }
        }
    }

    /// Standard system menu (Restore, Move, Size, Minimize, Maximize, Close) at a client-area point.
    pub fn system_menu(app: &AppHandle, x: i32, y: i32) {
        if !CUSTOM.load(Ordering::Relaxed) {
            return;
        }
        let (tx, rx) = channel::<()>();
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                if let Some(hwnd) = main_hwnd(&handle) {
                    unsafe { show_system_menu(hwnd, x, y) };
                }
                let _ = tx.send(());
            })
            .is_err()
        {
            return;
        }
        // the menu is modal on the UI thread; wait for it so the command completes when the menu closes
        let _ = rx.recv_timeout(std::time::Duration::from_secs(120));
    }

    unsafe fn show_system_menu(hwnd: HWND, x: i32, y: i32) {
        unsafe {
            let menu = GetSystemMenu(hwnd, false);
            if menu.is_invalid() {
                return;
            }
            let maxed = IsZoomed(hwnd).as_bool();
            let on = |yes: bool| if yes { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, SC_RESTORE, MF_BYCOMMAND | on(maxed));
            let _ = EnableMenuItem(menu, SC_MOVE, MF_BYCOMMAND | on(!maxed));
            let _ = EnableMenuItem(menu, SC_SIZE, MF_BYCOMMAND | on(!maxed));
            let _ = EnableMenuItem(menu, SC_MINIMIZE, MF_BYCOMMAND | MF_ENABLED);
            let _ = EnableMenuItem(menu, SC_MAXIMIZE, MF_BYCOMMAND | on(!maxed));
            let _ = EnableMenuItem(menu, SC_CLOSE, MF_BYCOMMAND | MF_ENABLED);
            let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);
            let mut pt = POINT { x, y };
            let _ = ClientToScreen(hwnd, &mut pt);
            let _ = SetForegroundWindow(hwnd);
            let align = if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_LAYOUTRTL.0 != 0 { TPM_RIGHTALIGN } else { TPM_LEFTALIGN };
            let cmd = TrackPopupMenuEx(menu, (align | TPM_TOPALIGN | TPM_RETURNCMD | TPM_NONOTIFY).0, pt.x, pt.y, hwnd, None);
            if cmd.0 != 0 {
                // SC_CLOSE ends up in WM_CLOSE -> CloseRequested, i.e. the same guard as the X button
                let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(cmd.0 as usize), LPARAM(0));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_split_the_group_in_thirds() {
        assert_eq!(zone_at(0, 138), Some(Zone::Min));
        assert_eq!(zone_at(45, 138), Some(Zone::Min));
        assert_eq!(zone_at(46, 138), Some(Zone::Max));
        assert_eq!(zone_at(91, 138), Some(Zone::Max));
        assert_eq!(zone_at(92, 138), Some(Zone::Close));
        assert_eq!(zone_at(137, 138), Some(Zone::Close));
    }

    #[test]
    fn zones_outside_or_degenerate_are_none() {
        assert_eq!(zone_at(-1, 138), None);
        assert_eq!(zone_at(138, 138), None);
        assert_eq!(zone_at(0, 0), None);
        assert_eq!(zone_at(5, -3), None);
    }

    #[test]
    fn zones_at_fractional_scale_cover_every_pixel() {
        // 150%: 3 x 69 = 207 px
        let w = 207;
        let all: Vec<_> = (0..w).map(|x| zone_at(x, w).unwrap()).collect();
        assert_eq!(all.iter().filter(|z| **z == Zone::Min).count(), 69);
        assert_eq!(all.iter().filter(|z| **z == Zone::Max).count(), 69);
        assert_eq!(all.iter().filter(|z| **z == Zone::Close).count(), 69);
    }

    #[test]
    fn hit_codes_round_trip() {
        for z in [Zone::Min, Zone::Max, Zone::Close] {
            assert_eq!(zone_from_hit(hit_code(z)), Some(z));
        }
        assert_eq!(hit_code(Zone::Max), 9); // HTMAXBUTTON: the one that makes the Snap Layouts flyout appear
        assert_eq!(zone_from_hit(1), None); // HTCLIENT
        assert_eq!(zone_from_hit(2), None); // HTCAPTION
    }

    #[test]
    fn css_rect_to_device_pixels() {
        assert_eq!(device_rect((1142.0, 0.0, 138.0, 50.0), 1.0), Some(Rect { x: 1142, y: 0, w: 138, h: 50 }));
        // 125%: edges are rounded, not the size
        assert_eq!(device_rect((1142.0, 0.0, 138.0, 50.0), 1.25), Some(Rect { x: 1428, y: 0, w: 172, h: 63 }));
        // 150%
        assert_eq!(device_rect((1142.0, 0.0, 138.0, 50.0), 1.5), Some(Rect { x: 1713, y: 0, w: 207, h: 75 }));
    }

    #[test]
    fn empty_or_invalid_rect_hides_the_overlay() {
        assert_eq!(device_rect((0.0, 0.0, 0.0, 0.0), 1.0), None);
        assert_eq!(device_rect((10.0, 0.0, -5.0, 50.0), 1.0), None);
        assert_eq!(device_rect((f64::NAN, 0.0, 10.0, 10.0), 1.0), None);
        assert_eq!(device_rect((0.0, 0.0, 10.0, 10.0), 0.0), None);
        assert_eq!(device_rect((0.0, 0.0, f64::INFINITY, 10.0), 1.0), None);
    }

    #[test]
    fn snap_layouts_need_windows_11() {
        assert!(!snap_layouts_supported(19045)); // Windows 10 22H2
        assert!(!snap_layouts_supported(21999));
        assert!(snap_layouts_supported(22000)); // Windows 11 21H2
        assert!(snap_layouts_supported(26300));
    }

    #[test]
    fn hover_press_release_is_a_click() {
        let mut p = Pointer::default();
        assert!(p.moved(Some(Zone::Max)));
        assert!(!p.moved(Some(Zone::Max))); // no change, no event
        assert!(p.pressed(Some(Zone::Max)));
        assert_eq!(p, Pointer { hot: Some(Zone::Max), down: Some(Zone::Max) });
        let (changed, click) = p.released(Some(Zone::Max));
        assert!(changed);
        assert_eq!(click, Some(Zone::Max));
        assert_eq!(p, Pointer { hot: Some(Zone::Max), down: None });
    }

    #[test]
    fn release_on_another_button_is_not_a_click() {
        let mut p = Pointer::default();
        p.pressed(Some(Zone::Close));
        // dragging onto the neighbour cancels the press
        assert!(p.moved(Some(Zone::Max)));
        assert_eq!(p.down, None);
        let (_, click) = p.released(Some(Zone::Max));
        assert_eq!(click, None);
    }

    #[test]
    fn leaving_clears_hover_and_press() {
        let mut p = Pointer::default();
        p.pressed(Some(Zone::Min));
        assert!(p.left());
        assert_eq!(p, Pointer::default());
        let (_, click) = p.released(Some(Zone::Min));
        assert_eq!(click, None); // the press was lost when the pointer left
        assert!(!Pointer::default().left());
    }

    #[test]
    fn release_without_press_is_not_a_click() {
        let mut p = Pointer::default();
        p.moved(Some(Zone::Min));
        let (_, click) = p.released(Some(Zone::Min));
        assert_eq!(click, None);
    }

    #[test]
    fn state_serializes_for_the_frontend() {
        let p = Pointer { hot: Some(Zone::Close), down: None };
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"hot":"close","down":null}"#);
    }
}
