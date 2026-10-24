//! The colour of a window before its page has painted (1.0.7, owner: "an empty white window" after an autostart, D-057).
//!
//! The web view (WebView2 `DefaultBackgroundColor`, WKWebView `underPageBackgroundColor`, WebKitGTK `set_background_color`) and the native window
//! behind it have a default colour of their own, white, in the dark theme too. It shows whenever the page has not painted yet or paints late: the
//! first frame after a show, a page that loads slowly, a resize that is ahead of the page. Every window now gets the colour of the app's own
//! background token (`--bg` in src/App.css, the same two values as the critical CSS public/boot.css), so what shows before the page is the page's
//! own ground, and the page puts its start screen (index.html: the logo) on it.
//!
//! Which of the two: the theme setting decides ("dark" / "light", see `wintheme::choice_of`); "system" (or nothing stored yet, or an unreadable blob)
//! takes the theme the OS has, which is what the window reports for itself while nothing is pinned. When even that is unknown: light, the default of
//! the page's own CSS. Called when a window is created (`popout::create`, the main window at the start of `setup`) and again by
//! `wintheme::apply_all`, which every theme or OS-theme change goes through.
use tauri::window::Color;
use tauri::{AppHandle, Manager, Theme};

/// `--bg` of the dark theme (src/App.css `:root[data-theme="dark"]`). A test keeps this, public/boot.css and App.css the same.
pub const DARK: (u8, u8, u8) = (0x1b, 0x1c, 0x20);
/// `--bg` of the light theme (src/App.css `:root`).
pub const LIGHT: (u8, u8, u8) = (0xff, 0xff, 0xff);

/// The theme a window starts with: what the setting pins, else what the OS has, else light.
pub fn theme_for(choice: Option<Theme>, os: Option<Theme>) -> Theme {
    match choice {
        Some(Theme::Dark) => Theme::Dark,
        Some(Theme::Light) => Theme::Light,
        _ => match os {
            Some(Theme::Dark) => Theme::Dark,
            _ => Theme::Light,
        },
    }
}

/// The background token of a theme.
pub fn rgb_of(theme: Theme) -> (u8, u8, u8) {
    match theme {
        Theme::Dark => DARK,
        _ => LIGHT,
    }
}

/// The colour as the window builder and the web view take it (opaque: WebView2 knows only alpha 0 or 255).
pub fn color_of(theme: Theme) -> Color {
    let (r, g, b) = rgb_of(theme);
    Color(r, g, b, 255)
}

/// The theme the OS has, from the value of the global default `AppleInterfaceStyle` (macOS: "Dark" while dark mode is on, no value in Light).
pub fn os_theme_from_style(style: Option<&str>) -> Theme {
    if style.is_some_and(|s| s.eq_ignore_ascii_case("dark")) { Theme::Dark } else { Theme::Light }
}

/// The OS theme as far as it can be known. macOS: the system's own setting, read fresh (a window's `theme()` is what tao cached when that window was last told a theme, and a window
/// that kept an old one gave its own ground colour to the title strip: D-099, the reader and search windows stayed dark in Light). Elsewhere: what a window reports, which is the OS's
/// own while the setting pins nothing.
fn os_theme(app: &AppHandle) -> Option<Theme> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Some(os_theme_from_style(crate::macwin::os_style().as_deref()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.webview_windows().values().find_map(|w| w.theme().ok())
    }
}

/// The theme every window is shown in now: ONE answer for all of them (the setting, else the OS).
pub fn current(app: &AppHandle) -> Theme {
    theme_for(crate::wintheme::choice_of_app(app), os_theme(app))
}

/// The colour a window that is about to be created gets.
pub fn for_new_window(app: &AppHandle) -> Color {
    color_of(theme_for(crate::wintheme::choice_of_app(app), os_theme(app)))
}

/// Give every window (visible, hidden or parked) the colour of the current theme setting. Safe to call from any thread, as often as needed.
/// Returns the theme used and how many windows were set, for the log.
pub fn apply(app: &AppHandle) -> (Theme, usize) {
    // one theme for every window, whatever kind it is: a window never decides its own ground (D-099)
    let theme = current(app);
    let mut n = 0;
    for w in app.webview_windows().values() {
        if w.set_background_color(Some(color_of(theme))).is_ok() {
            n += 1;
        }
    }
    // macOS: tao gives the NSWindow a colour in a colour space of its own (a dark ground reads (21,21,21), white (253,251,251)); the same ground in sRGB, exact, is set after it on the
    // main thread (the event loop runs the two in the order they were queued), for every window
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::wintheme::ground_all(&handle, theme == Theme::Dark));
    }
    (theme, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinned_setting_wins_over_the_os_and_system_takes_the_os() {
        assert_eq!(theme_for(Some(Theme::Dark), Some(Theme::Light)), Theme::Dark);
        assert_eq!(theme_for(Some(Theme::Light), Some(Theme::Dark)), Theme::Light);
        assert_eq!(theme_for(None, Some(Theme::Dark)), Theme::Dark);
        assert_eq!(theme_for(None, Some(Theme::Light)), Theme::Light);
    }

    #[test]
    fn when_nothing_is_known_the_window_starts_light_like_the_pages_own_css() {
        assert_eq!(theme_for(None, None), Theme::Light);
    }

    /// D-099: the ground of a window is a function of the setting and the OS alone - the same table for every kind of window, at creation, on a change of the setting and of the OS.
    #[test]
    fn the_ground_colour_follows_the_setting_and_the_os_in_a_table() {
        let (d, l) = (Color(0x1b, 0x1c, 0x20, 255), Color(255, 255, 255, 255));
        // (setting, OS, ground)
        let table = [
            (Some(Theme::Light), Some(Theme::Dark), l),
            (Some(Theme::Light), Some(Theme::Light), l),
            (Some(Theme::Light), None, l),
            (Some(Theme::Dark), Some(Theme::Dark), d),
            (Some(Theme::Dark), Some(Theme::Light), d),
            (Some(Theme::Dark), None, d),
            (None, Some(Theme::Dark), d),
            (None, Some(Theme::Light), l),
            (None, None, l),
        ];
        for (choice, os, want) in table {
            assert_eq!(color_of(theme_for(choice, os)), want, "setting {choice:?}, OS {os:?}");
        }
        // the OS from the global default
        assert_eq!(os_theme_from_style(Some("Dark")), Theme::Dark);
        assert_eq!(os_theme_from_style(Some("dark")), Theme::Dark);
        assert_eq!(os_theme_from_style(None), Theme::Light, "no value = Light");
        assert_eq!(os_theme_from_style(Some("")), Theme::Light);
        assert_eq!(os_theme_from_style(Some("Light")), Theme::Light);
    }

    /// D-099: nothing decides a ground from a single window (its cached `theme()`), the macOS native colour is set for every window after tao's, and the watchdog looks at the colour.
    #[test]
    fn every_road_gives_every_window_the_same_ground_natively_too() {
        let src = |f: &str| crate::test_guard::non_test_code(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap());
        let (bg, wt, mac, pop) = (src("bgcolor.rs"), src("wintheme.rs"), src("macwin.rs"), src("popout.rs"));
        let apply = &bg[bg.find("pub fn apply(").unwrap()..];
        let apply = &apply[..apply.find("\n}\n").unwrap()];
        assert!(!apply.contains("w.theme()"), "a window's own cached theme decides nothing: {apply}");
        assert!(apply.contains("let theme = current(app);") && apply.contains("crate::wintheme::ground_all(&handle, theme == Theme::Dark)"), "{apply}");
        // the native part: every window of the work list (tauri's windows and every other titled one), the colour opaque and in sRGB
        let walk = &mac[mac.find("pub fn apply_appearance(").unwrap()..];
        let walk = &walk[..walk.find("\n}\n").unwrap()];
        assert!(walk.contains("for (label, w) in work_list(known, only) {") && walk.contains("set_ground(w, expected);"), "{walk}");
        let ground = &mac[mac.find("unsafe fn set_ground(").unwrap()..];
        let ground = &ground[..ground.find("\n}\n").unwrap()];
        assert!(ground.contains("colorWithSRGBRed") && ground.contains("setOpaque: Bool::YES") && ground.contains("setBackgroundColor"), "{ground}");
        assert!(mac.contains("pub fn ground_all(") && mac.contains("pub fn mismatched(") && mac[mac.find("pub fn mismatched(").unwrap()..].contains("read_ground(w)"), "the watchdog compares the colour");
        // a window is made with the colour and then goes through apply_all (bgcolor::apply + the native part)
        let create = &pop[pop.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        assert!(create.contains("bgcolor::for_new_window(app)") && create.contains("crate::wintheme::apply_all(app,"), "{create}");
        // the setting, the OS theme and the custom colours all end in apply_all
        let all = &wt[wt.find("pub fn apply_all(").unwrap()..];
        assert!(all[..all.find("\n}\n").unwrap()].contains("crate::bgcolor::apply(app)"));
        assert!(wt.contains("pub fn ground_all(") && wt.contains("crate::macwin::ground_all("));
    }

    #[test]
    fn the_colour_is_opaque_and_is_the_background_token_of_the_theme() {
        assert_eq!(color_of(Theme::Dark), Color(0x1b, 0x1c, 0x20, 255));
        assert_eq!(color_of(Theme::Light), Color(255, 255, 255, 255));
    }

    /// The `--bg` value of the first rule whose selector starts with `selector` in a stylesheet.
    fn bg_of(css: &str, selector: &str) -> (u8, u8, u8) {
        let at = css.find(selector).unwrap_or_else(|| panic!("no rule {selector}"));
        let rule = &css[at..at + css[at..].find('}').unwrap()];
        let v = &rule[rule.find("--bg:").expect("no --bg in the rule") + 5..];
        let hex = v.trim_start()[..7].to_string();
        assert!(hex.starts_with('#'), "{hex}");
        let n = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
        (n(1), n(3), n(5))
    }

    #[test]
    fn the_two_colours_are_the_tokens_of_the_stylesheet_and_of_the_start_page() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let css = std::fs::read_to_string(root.join("src/App.css")).unwrap().replace('\r', "");
        assert_eq!(bg_of(&css, ":root {"), LIGHT, "App.css :root --bg");
        assert_eq!(bg_of(&css, ":root[data-theme=\"dark\"] {"), DARK, "App.css dark --bg");
        assert_eq!(bg_of(&css, ":root:not([data-theme=\"light\"]) {"), DARK, "App.css prefers-color-scheme: dark --bg");
        // the critical CSS of the start screen (public/boot.css, loaded by index.html) writes both as hex: light for the page, dark for System + dark OS and for Dark
        let boot = std::fs::read_to_string(root.join("public/boot.css")).unwrap();
        assert!(boot.contains(":where(html) { background: #ffffff; }"), "boot.css: light ground");
        assert_eq!(boot.matches("{ background: #1b1c20; }").count(), 2, "boot.css: dark ground (OS dark with System, and the Dark setting)");
    }

    #[test]
    fn the_window_is_given_its_colour_at_every_road_that_makes_or_themes_one() {
        let src = |f: &str| std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f)).unwrap().replace('\r', "");
        let (lib, pop, wt) = (src("lib.rs"), src("popout.rs"), src("wintheme.rs"));
        assert!(lib.contains("bgcolor::apply(app.handle())"), "the main window at the start of setup");
        assert!(pop.contains(".background_color(crate::bgcolor::for_new_window(app))"), "a pop-out at its creation");
        assert!(wt.contains("crate::bgcolor::apply(app)"), "every theme or OS-theme change (wintheme::apply_all)");
    }
}
