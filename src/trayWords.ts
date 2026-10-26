// The two places that offer to keep the app running when the window is closed name where it stays: the icon in the tray (Windows, Linux) or in the
// menu bar (macOS). The dictionary keys per system; pure, so scripts/test-open-failed-text.mjs runs it as it is.
import type { Os } from "./platform";

// A desktop without a tray (Linux with no tray host, shell_info.tray false) has no icon to keep the app running in: closing the window quits (settings.tray.noTray), so the texts that offer
// "Keep running in the tray" or talk about the tray say what is true instead (W5.6). `tray` defaults to true where the system is not known.

/** The button of the quit question while messages are scheduled (App.tsx). Without a tray, Keep = the app stays open. */
export const quitKeepKey = (os: Os, tray = true) => (!tray ? "app.quit.keepOpen" : os === "macos" ? "app.quit.keepRunningMac" : "app.quit.keepRunning");

/** The link under the Send later picker's warning (SchedulePicker.tsx); null = no link (there is no tray to keep it in; the warning sentence stays, it is true). */
export const scheduleKeepKey = (os: Os, tray = true) => (!tray ? null : os === "macos" ? "compose.schedule.keepInMenuBar" : "compose.schedule.keepInTray");

/** The third bullet of the Welcome screen. */
export const welcomeKeepKey = (os: Os, tray = true) => (os === "macos" ? "app.welcome.point.menuBar" : !tray ? "app.welcome.point.noTray" : "app.welcome.point.tray");

/** Settings > Filters intro. */
export const filtersIntroKey = (tray = true) => (tray ? "settings.filters.intro" : "settings.filters.introNoTray");

/** The title of the Settings tab that holds notifications and the tray (the entry of the navigation, the heading, the search page entry). No tray = startup; on a Mac the tray is the menu bar (D-019). */
export const trayTabTitleKey = (tray = true, os?: Os) => (!tray ? "settings.tray.titleNoTray" : os === "macos" ? "settings.tray.titleMenuBar" : "settings.tray.title");

// Settings > Notifications: three labels name the tray icon. On a Mac that icon lives in the menu bar, so the Mac texts say so (D-019); Windows and Linux keep the tray words.

/** The label of the "keep running when the window is closed" switch. */
export const keepRunningLabelKey = (os: Os) => (os === "macos" ? "settings.tray.keepRunningMenuBar" : "settings.tray.keepRunning");

/** The label of the tray icon's badge choice. */
export const trayBadgeLabelKey = (os: Os) => (os === "macos" ? "settings.tray.trayBadgeMenuBar" : "settings.tray.trayBadge");

/** The hint of the start-at-login switch when the system does not lock it. */
export const startsMinimizedKey = (os: Os) => (os === "macos" ? "settings.tray.startsMinimizedMenuBar" : "settings.tray.startsMinimized");

/** Windows: the start at sign-in shows the window unless "Start in the tray" is on, so the hint "Starts minimized to the tray" under the switch would be wrong there (1.0.10). Mac and Linux keep it. */
export const startsMinimizedHint = (os: Os) => os !== "windows";

/** The switch "Start in the tray" (Windows only: the entry of the start at sign-in gets `--minimized`, autostart.rs) is offered while the start at sign-in is on and there is a tray. */
export const startInTrayOffered = (os: Os, tray: boolean, autostartOn: boolean) => os === "windows" && tray && autostartOn;
