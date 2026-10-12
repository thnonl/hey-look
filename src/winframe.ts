// Custom window frame state (Windows only; see src-tauri/src/winframe.rs for the native half).
// On macOS / Linux and in the browser mock `custom` stays false and nothing here touches the window.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { api, FrameInfo } from "./api";

export type Zone = "min" | "max" | "close";

/** The few window operations the title bar needs; the real one wraps Tauri, the mock supplies a fake. */
export interface WinApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(on: boolean): Promise<void>;
  isFocused(): Promise<boolean>;
  onResized(cb: () => void): Promise<() => void>;
  onFocusChanged(cb: (focused: boolean) => void): Promise<() => void>;
}

const tauriWindow = (): WinApi => {
  const w = getCurrentWindow();
  return {
    minimize: () => w.minimize(),
    toggleMaximize: () => w.toggleMaximize(),
    close: () => w.close(), // goes through CloseRequested: close-to-tray / scheduled-message guard
    isMaximized: () => w.isMaximized(),
    isFullscreen: () => w.isFullscreen(),
    setFullscreen: (on) => w.setFullscreen(on),
    isFocused: () => w.isFocused(),
    onResized: (cb) => w.onResized(cb),
    onFocusChanged: (cb) => w.onFocusChanged((e) => cb(e.payload)),
  };
};

/** Dev mock only: a pretend window so the title bar can be previewed in a browser (`?frame=win`). */
let simulated: WinApi | null = null;
export function setSimulatedWindow(w: WinApi) {
  simulated = w;
}
const win = (): WinApi => simulated ?? tauriWindow();

export interface FrameState {
  /** the OS title bar is gone and the app draws the window buttons */
  custom: boolean;
  /** Windows 11: the maximize button shows the Snap Layouts flyout */
  snap: boolean;
  /** the buttons are hit-tested by the OS (hover/press then arrive as `caption` events, not DOM events) */
  native: boolean;
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
  caption: { hot: Zone | null; down: Zone | null };
}

export const useFrame = create<FrameState>(() => ({
  custom: false,
  snap: false,
  native: false,
  maximized: false,
  fullscreen: false,
  focused: true,
  caption: { hot: null, down: null },
}));

const set = useFrame.setState;
let started = false;

/** Learns whether the frame is custom and keeps the window state in sync. Safe to call anywhere; a no-op without Tauri. */
export function initFrame(): void {
  if (started) return;
  started = true;
  void (async () => {
    let info: FrameInfo = { custom: false, snapLayouts: false };
    try {
      info = await api.frameInfo();
    } catch {
      return; // plain browser without the mock, or an old backend
    }
    if (!info.custom) return;
    document.documentElement.setAttribute("data-frame", "custom");
    set({ custom: true, snap: info.snapLayouts });

    const refresh = async () => {
      try {
        const w = win();
        const [maximized, fullscreen] = await Promise.all([w.isMaximized(), w.isFullscreen()]);
        set({ maximized, fullscreen });
      } catch {
        /* window is going away */
      }
    };
    let raf = 0;
    const soon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void refresh());
    };
    await refresh();
    try {
      const w = win();
      set({ focused: await w.isFocused() });
      await w.onResized(soon);
      await w.onFocusChanged((focused) => set({ focused }));
      await listen<{ hot: Zone | null; down: Zone | null }>("frame-caption", (e) => set({ caption: e.payload }));
    } catch {
      /* events are a nicety: the buttons still work */
    }
  })();
}

export const frameAction = {
  minimize: () => void win().minimize().catch(() => undefined),
  toggleMaximize: () => void win().toggleMaximize().catch(() => undefined),
  close: () => void win().close().catch(() => undefined),
  toggleFullscreen: () => {
    const { custom, fullscreen } = useFrame.getState();
    if (custom) void win().setFullscreen(!fullscreen).then(() => set({ fullscreen: !fullscreen })).catch(() => undefined);
  },
};

/** What the OS tooltip would say. */
export const zoneLabel = (z: Zone, maximized: boolean) => (z === "min" ? "Minimize" : z === "max" ? (maximized ? "Restore Down" : "Maximize") : "Close");
