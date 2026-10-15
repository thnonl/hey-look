// Which system the app runs on, for the few words and keys that differ (Windows is the default and the reference).
import { create } from "zustand";
import { api } from "./api";
import { t } from "./i18n";

export type Os = "windows" | "macos" | "linux";

interface PlatformState {
  os: Os;
  /** a tray / menu-bar icon exists (false on Linux without a tray host: closing the window quits) */
  tray: boolean;
  /** a debug build: the test data folder it uses (shown in Settings > About) */
  testData: string | null;
  loaded: boolean;
}

export const usePlatform = create<PlatformState>(() => ({ os: "windows", tray: true, testData: null, loaded: false }));

/** Read once at start (before the UI shows); an old backend or a plain browser keeps the Windows defaults. */
export async function loadPlatform(): Promise<void> {
  try {
    const i = await api.shellInfo();
    usePlatform.setState({ os: i.os === "macos" || i.os === "linux" ? i.os : "windows", tray: i.tray, testData: i.testData ?? null, loaded: true });
  } catch {
    usePlatform.setState({ loaded: true });
  }
}

export const osNow = (): Os => usePlatform.getState().os;

/** Where passwords are kept, as a phrase ("Saved in {store}"). */
export const credStore = (os: Os = osNow()) => t(os === "macos" ? "errors.os.credStore.macos" : os === "linux" ? "errors.os.credStore.linux" : "errors.os.credStore.windows");

/** A shortcut label for this system: `Ctrl+` becomes `Cmd+` on macOS, everything else stays. */
export const kbd = (label: string, os: Os = osNow()) => (os === "macos" ? label.replace(/\bCtrl\+/g, "Cmd+") : label);

/** The risky-file examples in the "Warn before opening programs and scripts" hint. */
export const riskyHint = (os: Os = osNow()) => t(os === "macos" ? "errors.os.risky.macos" : os === "linux" ? "errors.os.risky.linux" : "errors.os.risky.windows");
