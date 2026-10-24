// What the Confidential banner and the Print Screen toast say on each system (1.0.7 W8.8e). Windows and macOS keep the screen out of capture (SetWindowDisplayAffinity, NSWindowSharingNone);
// Linux has no equivalent (platform limit P-02), so its banner says so and Print Screen shows no "turned off" toast. Pure, so scripts/test-conf-ui.mjs can run it without a window.

export type ConfOs = "windows" | "macos" | "linux";

/** The text of the banner above a Confidential message. */
export const confNoteKey = (os: ConfOs) => (os === "linux" ? ("reading.protect.noteLinux" as const) : ("reading.protect.note" as const));

/** Does Print Screen get the "screen capture is turned off" toast: only where capture really is blocked. */
export const captureToastOn = (os: ConfOs) => os !== "linux";
