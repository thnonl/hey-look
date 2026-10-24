// The macOS menu bar items that need the page (W5.11): the native menu (src-tauri/src/shell.rs) only tells a window what was chosen, the page does the work with the code it
// already has: Settings… opens Settings as the gear does, File > Print… prints the open message through the W5.3 path, Help opens help.html in the default browser.
// Print follows the window: every window that can print says on every change whether it shows a printable message (`mac_menu_state`), and the item is on only then.
// Cmd+P is the menu item's key on a Mac: no page handles it (a page that claimed it would print twice).
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { siteUrl } from "./aboutLinks";
import { api } from "./api";
import { usePlatform } from "./platform";
import { useStore } from "./store";
import { openUpdateLink, pendingVersion, useUpdates } from "./updates";

/** What the gear in the top bar does: Settings, or Settings > About when an update is waiting. One place, so the menu item and the button cannot differ. */
export function openSettingsLikeGear(): void {
  const st = useStore.getState();
  const version = pendingVersion(useUpdates.getState().update, st.prefs.skippedUpdate);
  if (version) useUpdates.getState().openSettingsAbout(false);
  else st.setDialog({ type: "settings" });
}

interface Printer {
  can: boolean;
  print: () => void;
}
let printer: Printer | null = null;
/** What the backend was told last (null: nothing yet, so the first report always goes). */
let reported: boolean | null = null;

function report(can: boolean): void {
  if (reported === can) return;
  reported = can;
  void api.macMenuState(can).catch(() => undefined);
}

/**
 * A window that can print (the main window with the reading pane, a reader window) says whether it shows a message that can be printed now, and how to print it. The backend switches
 * File > Print… on and off with the window that has the focus. Nothing happens off macOS.
 */
export function useMacPrint(can: boolean, print: () => void): void {
  const mac = usePlatform((s) => s.os === "macos");
  const printRef = useRef(print);
  printRef.current = print;
  useEffect(() => {
    if (!mac) return;
    printer = { can, print: () => printRef.current() };
    report(can);
  }, [mac, can]);
  // the window shows nothing printable any more when this goes (the reading pane is left, the reader closes)
  useEffect(() => {
    if (!mac) return;
    return () => {
      printer = null;
      report(false);
    };
  }, [mac]);
}

/** What the menu said. Print does nothing unless the window said it can (a stale click or a race with a selection change). */
export function macMenuEvent(item: "print" | "help" | "settings"): void {
  if (item === "print") {
    if (printer?.can) printer.print();
  } else if (item === "help") {
    void openUpdateLink(siteUrl("help.html")); // (an open that fails says so and copies the link, as everywhere)
  } else {
    openSettingsLikeGear();
  }
}

/** The menu's events (a plain browser has no Tauri: nothing). Settings is for the main window only: the backend shows it and sends the event there. */
export function installMacMenu(main: boolean): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void listen("mac-print", () => macMenuEvent("print")).catch(() => undefined);
  void listen("mac-help", () => macMenuEvent("help")).catch(() => undefined);
  if (main) void listen("mac-open-settings", () => macMenuEvent("settings")).catch(() => undefined);
}
