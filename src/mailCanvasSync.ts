// The follow-the-app-theme rule of the mail background (1.0.7 WP13g, DEC-025), the parts that need a window: installed once per page (main.tsx), in the main window and in every other window.
//   - Any switch of the app theme (the setting through Settings / the command bar, or the OS when the setting is System) clears the light theme's session choice of the mail background
//     (store `mailCanvasSession`) and the composer's session choice of "Preview as recipient" (composePreview.ts `chosen`) of THIS window. Every window sees the same switch, so each clears its own;
//     the surfaces (reading pane, reader windows, composers) then show the start value again within the same frame (they read the theme, the stored choice and the session from the store).
//   - The session choice is shared by the main window and the reader windows: the main window owns it and tells the others (`mail-canvas-session`); a reader asks the main window to set it
//     (popout/readerBridge.ts, request `canvas-session`). A composer has no use for it (its preview starts light in the light theme whatever the reading pane shows).
// The rules themselves are pure (mailCanvas.ts, scripts/test-mail-canvas.mjs).
import { emit } from "@tauri-apps/api/event";
import { forgetPreview } from "./composePreview";
import { sessionAfterThemeChange, themeKey } from "./mailCanvas";
import { onOsDarkChange, osDark } from "./osTheme";
import { useStore } from "./store";

/** The event the main window sends when the session choice changes: payload `{ dark: boolean, theme?: true }` (`theme`: it was cleared by a switch of the app theme, which every window sees for itself, so a reader leaves it to that and does not flash the other background first). */
export const CANVAS_SESSION_EVENT = "mail-canvas-session";

const currentKey = () => themeKey(useStore.getState().prefs.theme, osDark());

let started = false;
/** How many switches of the app theme this page has seen; the composer reads it to put its preview back (a count, so two switches inside one render are not lost). */
let switches = 0;
const switchListeners = new Set<() => void>();
export const themeSwitches = (): number => switches;
export function onThemeSwitch(fn: () => void): () => void {
  switchListeners.add(fn);
  return () => void switchListeners.delete(fn);
}
/** True while the theme-switch rule itself is clearing the session choice (read by the broadcast below). */
let byTheme = false;

/** Installs the theme watch (every window) and, in the main window, the broadcast of the session choice. Once per page. */
export function installMailCanvasSync(main: boolean): void {
  if (started) return;
  started = true;
  let last = currentKey();
  const check = () => {
    const next = currentKey();
    if (next === last) return;
    const cleared = sessionAfterThemeChange(last, next, useStore.getState().mailCanvasSession);
    last = next;
    forgetPreview();
    switches++;
    if (cleared !== useStore.getState().mailCanvasSession) {
      byTheme = true;
      try {
        useStore.setState({ mailCanvasSession: cleared });
      } finally {
        byTheme = false;
      }
    }
    switchListeners.forEach((f) => f());
  };
  useStore.subscribe((s, prev) => {
    if (s.prefs.theme !== prev.prefs.theme) check();
  });
  onOsDarkChange(check);
  if (main) {
    useStore.subscribe((s, prev) => {
      if (s.mailCanvasSession !== prev.mailCanvasSession) void emit(CANVAS_SESSION_EVENT, byTheme ? { dark: false, theme: true } : { dark: s.mailCanvasSession === "dark" }).catch(() => undefined);
    });
  }
}
