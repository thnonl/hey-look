// Dev aid for the secondary windows: with the dev flag (a dev build, or localStorage["heylook.popoutDev"] = "1" in a debug build's console)
// the main window gets `window.__heylookPopout`, so a window can be opened without UI: `__heylookPopout.open("compose")`.
// Nothing in the app calls this; without the flag nothing is installed.
import { api } from "../api";
import { openPopout } from "./open";
import type { PopoutKind } from "./route";
import { devFlagOn } from "./views";

export function installPopoutDev(): void {
  if (!devFlagOn()) return;
  (window as unknown as { __heylookPopout: unknown }).__heylookPopout = {
    open: (kind: PopoutKind, key?: string, init?: unknown) => openPopout(kind, key, init),
    focus: (label: string) => api.popoutFocus(label),
    close: (label: string) => api.popoutClose(label),
    saveAll: () => api.popoutSaveAll(),
  };
}
