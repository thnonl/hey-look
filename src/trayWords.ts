// The two places that offer to keep the app running when the window is closed name where it stays: the icon in the tray (Windows, Linux) or in the
// menu bar (macOS). The dictionary keys per system; pure, so scripts/test-open-failed-text.mjs runs it as it is.
import type { Os } from "./platform";

/** The button of the quit question while messages are scheduled (App.tsx). */
export const quitKeepKey = (os: Os) => (os === "macos" ? "app.quit.keepRunningMac" : "app.quit.keepRunning");

/** The link under the Send later picker's warning (SchedulePicker.tsx). */
export const scheduleKeepKey = (os: Os) => (os === "macos" ? "compose.schedule.keepInMenuBar" : "compose.schedule.keepInTray");
