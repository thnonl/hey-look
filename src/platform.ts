// Which system the app runs on, for the few words and keys that differ (Windows is the default and the reference).
import { create } from "zustand";
import { api } from "./api";
import { t } from "./i18n";

export type Os = "windows" | "macos" | "linux";

/** How a PDF attachment is previewed (src-tauri/src/pdfmode.rs): in a frame, in an object element (macOS / Linux experiment), or as a card that opens it in the default app. */
export type PdfView = "frame" | "object" | "card";

interface PlatformState {
  os: Os;
  /** a tray / menu-bar icon exists (false on Linux without a tray host: closing the window quits) */
  tray: boolean;
  /** a debug build: the test data folder it uses (shown in Settings > About) */
  testData: string | null;
  /** the PDF preview of this system; Windows draws the PDF, the others show a card unless the backend says otherwise */
  pdfView: PdfView;
  /** the macOS / Linux PDF experiment is on: the preview shows a readout of what the engine did with the PDF */
  pdfTest: boolean;
  /** a debug build with HEYLOOK_TEST_COPY_FAIL=1: every copy fails (QA of the error toasts) */
  copyFail: boolean;
  /** a debug build with HEYLOOK_TEST_OPEN_FAIL=1: opening a link in the browser always fails (QA of the "Couldn't open your browser" toasts) */
  openFail: boolean;
  /** a debug build with HEYLOOK_TEST_ACCOUNTS_DELAY_MS: the store waits this long before it takes the mailboxes (QA of New mail during the first seconds) */
  accountsDelayMs: number;
  /** who updates this copy: "snap" (Snap Store), "apt" (the Hey Look! APT repository), "msstore" (the Microsoft Store package); null when the app updates itself */
  managed: "snap" | "apt" | "msstore" | null;
  loaded: boolean;
}

export const usePlatform = create<PlatformState>(() => ({ os: "windows", tray: true, testData: null, pdfView: "frame", pdfTest: false, copyFail: false, openFail: false, accountsDelayMs: 0, managed: null, loaded: false }));

/** Read once at start (before the UI shows); an old backend or a plain browser keeps the Windows defaults. */
export async function loadPlatform(): Promise<void> {
  try {
    const i = await api.shellInfo();
    const os: Os = i.os === "macos" || i.os === "linux" ? i.os : "windows";
    // (an old backend does not say: the frame is only known to draw on Windows)
    const pdfView: PdfView = i.pdfView === "frame" || i.pdfView === "object" || i.pdfView === "card" ? i.pdfView : os === "windows" ? "frame" : "card";
    // (CSS that is for one system only: `:root[data-os="macos"]`, e.g. the ground colour at the top of a window whose title bar is transparent, D-092)
    document.documentElement.dataset.os = os;
    usePlatform.setState({ os, tray: i.tray, testData: i.testData ?? null, pdfView, pdfTest: i.pdfTest === true, copyFail: i.copyFail === true, openFail: i.openFail === true, accountsDelayMs: typeof i.accountsDelayMs === "number" ? i.accountsDelayMs : 0, managed: i.managed === "snap" || i.managed === "apt" || i.managed === "msstore" ? i.managed : null, loaded: true });
  } catch {
    usePlatform.setState({ loaded: true });
  }
}

export const osNow = (): Os => usePlatform.getState().os;
export const pdfViewNow = (): PdfView => usePlatform.getState().pdfView;

/** Where passwords are kept, as a phrase ("Saved in {store}"). */
export const credStore = (os: Os = osNow()) => t(os === "macos" ? "errors.os.credStore.macos" : os === "linux" ? "errors.os.credStore.linux" : "errors.os.credStore.windows");

/** A shortcut label for this system: `Ctrl+` becomes `Cmd+` on macOS, everything else stays. */
export const kbd = (label: string, os: Os = osNow()) => (os === "macos" ? label.replace(/\bCtrl\+/g, "Cmd+") : label);

/** The risky-file examples in the "Warn before opening programs and scripts" hint. */
export const riskyHint = (os: Os = osNow()) => t(os === "macos" ? "errors.os.risky.macos" : os === "linux" ? "errors.os.risky.linux" : "errors.os.risky.windows");
