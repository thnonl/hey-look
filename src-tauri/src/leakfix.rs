//! Source guard of the macOS window code (DEC-024, D-093, D-098; AC-4.1.11). This file has no code of its own: it is compiled for the tests only.
//!
//! History: fix28 released the extra references that a closed pop-out's `NSWindow` keeps, computed from `retainCount`; fix28 and fix29 crashed the app in `objc_autoreleasePoolPop` because the
//! autorelease pool holds references to the window that `retainCount` cannot tell from the leaked ones. The decision (DEC-024, option A, "mac-window-floor"): no manual release of anything the
//! framework owns, ever. What a close does instead is the normal Cocoa teardown (macwin.rs `sweep`: observers, drag types, delegate, first responder, web view, content view, `orderOut`, after
//! the `Destroyed` event); the empty shell may stay until the app quits. The root cause is a reference cycle between wry's web view and tao's window (upstream-wry-window-cycle.md in the reports).

#[cfg(test)]
mod tests {
    use crate::test_guard::non_test_code;

    /// The files that touch native windows and views on macOS.
    const FILES: [(&str, &str); 3] = [("macwin.rs", include_str!("macwin.rs")), ("popout.rs", include_str!("popout.rs")), ("leakfix.rs", include_str!("leakfix.rs"))];

    /// Code lines only: no comment lines, no inline test modules.
    fn code(src: &str) -> String {
        non_test_code(src).lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn no_manual_release_is_sent_to_a_window_or_a_view() {
        for (name, src) in FILES {
            let c = code(src);
            for bad in ["release]", "autorelease", "CFRelease", "objc_release", "objc_retain", "retain]", ".release(", "drop(strong)", "from_raw", "into_raw", "mem::forget", "ManuallyDrop"] {
                assert!(!c.contains(bad), "{name} contains `{bad}`: nothing may release or re-own a window or view by hand (DEC-024)");
            }
        }
        // the only references that are let go of are the ones `hold` took itself with `Retained`, in `sweep`
        let mac = code(include_str!("macwin.rs"));
        let sweep = &mac[mac.find("pub fn sweep(").unwrap()..mac.find("pub fn check(").unwrap()];
        assert_eq!(sweep.matches("drop(").count(), 2, "the window and its delegate that `hold` retained");
        assert!(sweep.contains("drop(delegate);") && sweep.contains("drop(w);"));
        assert!(!mac[mac.find("pub fn check(").unwrap()..].contains("drop("), "the check drops nothing by hand");
        assert!(mac.contains("Retained::retain(ns_window as *mut AnyObject)"), "hold is where the one reference is taken");
    }

    #[test]
    fn the_switches_of_the_release_experiments_are_gone_everywhere() {
        // built from pieces so that this file does not contain them
        let removed: Vec<String> = ["LEAK_FIX", "NO_LEAK_FIX", "RELEASE_LEAK", "RELEASE_KEEP"].iter().map(|s| format!("HEYLOOK_MAC_{s}")).collect();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![dir];
        let mut seen = 0;
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    let src = std::fs::read_to_string(&p).unwrap();
                    // (the strings in this test module are pieces; non-test code is what counts)
                    let c = non_test_code(&src);
                    seen += 1;
                    for r in &removed {
                        assert!(!c.contains(r.as_str()), "{} still names {r}", p.display());
                    }
                }
            }
        }
        assert!(seen > 20);
    }

    #[test]
    fn the_teardown_runs_after_the_window_has_ended_and_keeps_its_order() {
        let mac = code(include_str!("macwin.rs"));
        let sweep = &mac[mac.find("pub fn sweep(").unwrap()..mac.find("pub fn check(").unwrap()];
        let steps = ["teardown_views(ptr", "setDelegate: nil", "removeObserver: d", "removeObserver: ptr", "removeWindowsItem: ptr", "setContentView: &*empty", "orderOut: nil", "msg_send![ptr, close]"];
        let mut last = 0;
        for s in steps {
            let at = sweep.find(s).unwrap_or_else(|| panic!("the sweep lacks {s}"));
            assert!(at >= last, "{s} is out of order");
            last = at;
        }
        let td = &mac[mac.find("unsafe fn teardown_views(").unwrap()..mac.find("unsafe fn collect_views(").unwrap()];
        let order = ["makeFirstResponder: nil", "unregisterDraggedTypes", "removeObserver: *t", "setNavigationDelegate: nil", "removeFromSuperview", "setContentView: &*empty"];
        let mut last = 0;
        for s in order {
            let at = td.find(s).unwrap_or_else(|| panic!("the teardown lacks {s}"));
            assert!(at >= last, "{s} is out of order");
            last = at;
        }
        // it is started from the sweep, which popout.rs runs only for a window whose Destroyed event came
        let pop = code(include_str!("popout.rs"));
        let after = &pop[pop.find("fn after_destroyed(").unwrap()..];
        assert!(after.contains("if !destroyed {") && after.find("if !destroyed {").unwrap() < after.find("native_sweep(&name)").unwrap());
        // and the check is read-only and debug-only
        let check = &mac[mac.find("pub fn check(").unwrap()..];
        assert!(check.contains("if !cfg!(debug_assertions) {"));
    }
}
