//! No browser autofill in any window of the app (Windows / WebView2).
//!
//! WebView2 is Edge: it remembers what was typed into text fields ("Saved info", form entries keyed by the field's name or id) and
//! offers it in a native dropdown under the field. In the search box that dropdown (entries like `quarterly`, `has:attachment`) opened OVER
//! the app's own panel (Search in / Recent searches), which has its own history. WebKit on macOS (WKWebView) and Linux (WebKitGTK) has no such dropdown.
//!
//! Two layers keep it away: the fields say `autoComplete="off"` (guarded by scripts/test-no-autofill.mjs), and this file
//! switches the WebView2 features off at the source: general autofill (`ICoreWebView2Settings4::IsGeneralAutofillEnabled`) and password
//! autosave (`IsPasswordAutosaveEnabled`), on the web view's settings and on its profile (`ICoreWebView2Profile6`, the same pair for the
//! whole profile, so a pop-out that shares it cannot be missed). The switches are made when a web view is created, whichever code made it:
//! a plugin hook (`on_webview_ready`) sees every web view of the app, the main window (from the configuration) and every pop-out alike.
//! Nothing is deleted: the entries Edge already saved in the profile stay on disk and are simply never offered.
//! (The app has no stored-password form: the mailbox passwords go to the system credential store through the backend, not the page.)

/// What the two switches read back as, for one web view.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct State {
    /// `IsGeneralAutofillEnabled` of the web view's settings
    pub general: bool,
    /// `IsPasswordAutosaveEnabled` of the web view's settings
    pub password: bool,
    /// the same two of the profile (`None`: this runtime has no `ICoreWebView2Profile6`)
    pub profile: Option<(bool, bool)>,
}

impl State {
    /// The one wanted state: everything off.
    pub fn is_off(&self) -> bool {
        !self.general && !self.password && self.profile.is_none_or(|(g, p)| !g && !p)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "generalAutofill": self.general,
            "passwordAutosave": self.password,
            "profileGeneralAutofill": self.profile.map(|p| p.0),
            "profilePasswordAutosave": self.profile.map(|p| p.1),
            "off": self.is_off(),
        })
    }
}

#[cfg(windows)]
pub use win::{plugin, report};

#[cfg(windows)]
mod win {
    use super::State;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, BOOL};

    /// Turns the switches off on one web view. The settings are the ones that matter; the profile is done as well when the runtime has it.
    /// Returns what was read back afterwards.
    pub unsafe fn switch_off(core: &ICoreWebView2) -> windows::core::Result<State> {
        unsafe {
            let settings = core.Settings()?.cast::<ICoreWebView2Settings4>()?;
            settings.SetIsGeneralAutofillEnabled(false)?;
            settings.SetIsPasswordAutosaveEnabled(false)?;
            if let Some(p) = profile(core) {
                // (an older runtime without the profile switches is not a failure: the settings above already did it)
                let _ = p.SetIsGeneralAutofillEnabled(false);
                let _ = p.SetIsPasswordAutosaveEnabled(false);
            }
            read(core)
        }
    }

    unsafe fn profile(core: &ICoreWebView2) -> Option<ICoreWebView2Profile6> {
        unsafe { core.cast::<ICoreWebView2_13>().ok()?.Profile().ok()?.cast::<ICoreWebView2Profile6>().ok() }
    }

    /// Reads the switches back.
    pub unsafe fn read(core: &ICoreWebView2) -> windows::core::Result<State> {
        unsafe {
            let settings = core.Settings()?.cast::<ICoreWebView2Settings4>()?;
            let (mut general, mut password) = (BOOL(1), BOOL(1));
            settings.IsGeneralAutofillEnabled(&mut general)?;
            settings.IsPasswordAutosaveEnabled(&mut password)?;
            let profile = profile(core).and_then(|p| {
                let (mut g, mut w) = (BOOL(1), BOOL(1));
                p.IsGeneralAutofillEnabled(&mut g).ok()?;
                p.IsPasswordAutosaveEnabled(&mut w).ok()?;
                Some((g.as_bool(), w.as_bool()))
            });
            Ok(State { general: general.as_bool(), password: password.as_bool(), profile })
        }
    }

    /// The hook: every web view of the app (main window, pop-outs, anything made later) is switched off the moment it exists. Registered in `run` (lib.rs).
    pub fn plugin() -> TauriPlugin<tauri::Wry> {
        Builder::new("autofill")
            .on_webview_ready(|webview| {
                let label = webview.label().to_string();
                let asked = webview.with_webview(move |pw| unsafe {
                    let line = match pw.controller().CoreWebView2().and_then(|core| switch_off(&core)) {
                        Ok(s) if s.is_off() => format!("{label}: browser autofill and password saving are off ({s:?})"),
                        Ok(s) => format!("{label}: browser autofill is STILL ON after switching it off ({s:?})"),
                        Err(e) => format!("{label}: could not turn the browser autofill off: {e}"),
                    };
                    crate::startup::line("webview", &line);
                });
                if let Err(e) = asked {
                    crate::startup::line("webview", &format!("could not reach the web view to turn the browser autofill off: {e}"));
                }
            })
            .build()
    }

    /// The state of every web view of the app, for the test bridge (`GET /native`, debug builds): `{ "main": { generalAutofill, ... }, "compose-2": ... }`.
    /// A web view that does not answer within three seconds is reported as an error text.
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn report(app: &AppHandle) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for (label, w) in app.webview_windows() {
            let (tx, rx) = mpsc::channel::<Result<State, String>>();
            let asked = w.with_webview(move |pw| unsafe {
                let _ = tx.send(pw.controller().CoreWebView2().and_then(|core| read(&core)).map_err(|e| e.to_string()));
            });
            let v = match asked.map_err(|e| e.to_string()).and_then(|_| rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "no answer in 3 s".to_string())).and_then(|r| r) {
                Ok(s) => s.to_json(),
                Err(e) => serde_json::json!({ "error": e }),
            };
            out.insert(label, v);
        }
        serde_json::Value::Object(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::mpsc;
        use webview2_com::{CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler};
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::*;

        unsafe extern "system" fn test_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            unsafe { DefWindowProcW(h, m, w, l) }
        }

        /// A real web view that is never shown (a temp data folder): the switches start ON (WebView2's defaults, which is the bug), and after
        /// `switch_off` every one reads back OFF. Skipped on a machine without the WebView2 runtime.
        #[test]
        fn a_real_web_view_has_its_autofill_off_after_switch_off() {
            let folder = std::env::temp_dir().join(format!("heylook-wv2-autofill-{}", std::process::id()));
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let class = WNDCLASSW { lpfnWndProc: Some(test_proc), lpszClassName: w!("HEYLOOK_WV2_AUTOFILL_TEST"), ..Default::default() };
                RegisterClassW(&class);
                let hinst = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
                let host = CreateWindowExW(Default::default(), w!("HEYLOOK_WV2_AUTOFILL_TEST"), w!("test"), WS_POPUP, 0, 0, 400, 300, None, None, hinst, None).unwrap();
                let udf = HSTRING::from(folder.to_string_lossy().as_ref());
                let (tx, rx) = mpsc::channel();
                let env = CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &udf, None::<&ICoreWebView2EnvironmentOptions>, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, env| {
                        code?;
                        tx.send(env.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                );
                let Some(env) = env.ok().and_then(|_| rx.recv().ok()).and_then(|r| r.ok()) else {
                    eprintln!("no WebView2 runtime here: test skipped");
                    let _ = DestroyWindow(host);
                    return;
                };
                let (tx, rx) = mpsc::channel();
                CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| env.CreateCoreWebView2Controller(host, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, c| {
                        code?;
                        tx.send(c.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                )
                .unwrap();
                let controller = rx.recv().unwrap().unwrap();
                let core = controller.CoreWebView2().unwrap();

                let before = read(&core).unwrap();
                eprintln!("before: {before:?}");
                assert!(before.general, "WebView2's default is general autofill ON: {before:?}");
                let after = switch_off(&core).unwrap();
                eprintln!("after: {after:?}");
                assert!(after.is_off(), "{after:?}");
                assert!(!after.general && !after.password, "{after:?}");
                assert_eq!(read(&core).unwrap(), after, "the read-back is stable");
                assert_eq!(after.to_json()["off"], true);
                let _ = controller.Close();
                let _ = DestroyWindow(host);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_means_every_switch_is_off() {
        let off = State { general: false, password: false, profile: Some((false, false)) };
        assert!(off.is_off());
        assert!(State { general: false, password: false, profile: None }.is_off(), "a runtime without profile switches: the settings decide");
        assert!(!State { general: true, password: false, profile: None }.is_off());
        assert!(!State { general: false, password: true, profile: None }.is_off());
        assert!(!State { general: false, password: false, profile: Some((true, false)) }.is_off());
        assert!(!State { general: false, password: false, profile: Some((false, true)) }.is_off());
        let j = off.to_json();
        assert_eq!(j["generalAutofill"], false);
        assert_eq!(j["passwordAutosave"], false);
        assert_eq!(j["off"], true);
        assert!(State { general: true, password: true, profile: None }.to_json()["profileGeneralAutofill"].is_null());
    }

    /// No window can be missed: every web view the app makes goes through the plugin hook (`on_webview_ready`), so the only things to guard are that the
    /// plugin is registered on Windows and that no web view is made in a way that skips it (a second builder would still pass the hook, but a window made
    /// outside tauri would not). Every builder in the sources is listed here; a new one must be added on purpose.
    #[test]
    fn the_hook_is_registered_and_every_builder_is_known() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(lib.contains(".plugin(autofill::plugin())"), "lib.rs must register the autofill plugin");
        let at = lib.find(".plugin(autofill::plugin())").unwrap();
        let cfg = &lib[lib[..at].rfind("#[cfg").unwrap()..at];
        assert!(cfg.contains("windows"), "the plugin is Windows only: {cfg}");
        // the builders: popout.rs makes the pop-outs (one), startgate.rs the main window from the configuration (and a probe of the start gate)
        let mut found = vec![];
        for (name, src) in [
            ("popout.rs", include_str!("popout.rs")),
            ("startgate.rs", include_str!("startgate.rs")),
            ("startup.rs", include_str!("startup.rs")),
            ("shell.rs", include_str!("shell.rs")),
            ("oauth.rs", include_str!("oauth.rs")),
            ("update.rs", include_str!("update.rs")),
            ("lib.rs", include_str!("lib.rs")),
        ] {
            let code = crate::test_guard::non_test_code(src);
            for pat in ["WebviewWindowBuilder::new", "WebviewWindowBuilder::from_config", "WebviewBuilder::new", ".add_child("] {
                for _ in code.matches(pat) {
                    found.push(format!("{name}:{pat}"));
                }
            }
        }
        found.sort();
        assert_eq!(found, vec!["popout.rs:WebviewWindowBuilder::new".to_string(), "startgate.rs:WebviewWindowBuilder::from_config".to_string()], "a new window builder: it goes through the plugin hook like the rest, add it here on purpose");
    }
}
