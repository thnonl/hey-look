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

/// The OS theme as far as it can be known: what the main window reports, which is the OS's own while the setting pins nothing.
fn os_theme(app: &AppHandle) -> Option<Theme> {
    app.webview_windows().values().find_map(|w| w.theme().ok())
}

/// The colour a window that is about to be created gets.
pub fn for_new_window(app: &AppHandle) -> Color {
    color_of(theme_for(crate::wintheme::choice_of_app(app), os_theme(app)))
}

/// Give every window (visible, hidden or parked) the colour of the current theme setting. Safe to call from any thread, as often as needed.
/// Returns the theme used and how many windows were set, for the log.
pub fn apply(app: &AppHandle) -> (Theme, usize) {
    let choice = crate::wintheme::choice_of_app(app);
    let mut n = 0;
    let mut used = theme_for(choice, None);
    for w in app.webview_windows().values() {
        // a pinned window reports the pinned theme; with System it is the OS's (`apply_all` released the pin before it comes here)
        let theme = theme_for(choice, w.theme().ok());
        used = theme;
        if w.set_background_color(Some(color_of(theme))).is_ok() {
            n += 1;
        }
    }
    (used, n)
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
