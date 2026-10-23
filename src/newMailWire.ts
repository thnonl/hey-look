// (W13.2) The window side of "new mail": `mail-arrived` from the backend marks folders, and the window coming to the front looks at the folder that is on screen.
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import type { Arrivals } from "./newMail";

/** The main window is in front: visible and focused (a window in the tray or behind others is not). */
export const windowInFront = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** Listens for arrivals and for the window coming forward. Returns the function that stops both. */
export function watchNewMail(): () => void {
  const sub = listen<Arrivals>("mail-arrived", (e) => useStore.getState().noteArrivals(e.payload, windowInFront()));
  const looked = () => {
    if (windowInFront()) useStore.getState().lookedAtFolder();
  };
  const shown = listen("app-shown", looked);
  window.addEventListener("focus", looked);
  document.addEventListener("visibilitychange", looked);
  return () => {
    void sub.then((off) => off()).catch(() => undefined);
    void shown.then((off) => off()).catch(() => undefined);
    window.removeEventListener("focus", looked);
    document.removeEventListener("visibilitychange", looked);
  };
}
