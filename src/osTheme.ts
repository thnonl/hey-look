// "The OS is dark": one source for every page (1.0.7 W5.2). On Windows and macOS it is the engine's own media query, as always. On Linux the backend resolves the desktop's scheme itself
// (src-tauri/src/linuxtheme.rs: the desktop portal, then the GTK settings) because WebKitGTK's `prefers-color-scheme` did not follow a dark Plasma; the backend tells it with the command
// `os_color_scheme` once and the event `os-color-scheme` at every change. Until the backend has answered, and wherever it never does, the media query is used.
//
// The pure rule (which theme a setting shows for an OS scheme) is in osThemeLogic.ts, which a plain Node script tests (scripts/test-os-theme.mjs).
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

/** What the backend said about the desktop: `null` = nothing (Windows, macOS, Linux before the first answer). */
let backend: boolean | null = null;
const subscribers = new Set<() => void>();

const query = (): MediaQueryList | null => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null);

/** Is the OS dark now? The backend's answer on Linux, else the engine's media query. */
export function osDark(): boolean {
  return backend ?? query()?.matches ?? false;
}

/**
 * The value `applyPrefs` writes on the root element for the System setting: the resolved theme when the backend decides it (Linux), `null` where the CSS follows the media query by
 * itself (no `data-theme`: Windows and macOS stay exactly as they were).
 */
export function systemThemeAttribute(): "dark" | "light" | null {
  return backend === null ? null : backend ? "dark" : "light";
}

/** Calls `fn` when the OS scheme changes (the media query or the backend); returns the function that stops it. */
export function onOsDarkChange(fn: () => void): () => void {
  subscribers.add(fn);
  const q = query();
  q?.addEventListener("change", fn);
  return () => {
    subscribers.delete(fn);
    q?.removeEventListener("change", fn);
  };
}

function set(next: boolean | null): void {
  if (next === backend) return;
  backend = next;
  subscribers.forEach((f) => f());
}

/** Reads the backend's answer and listens for its changes (once per page). Never fails: a page without a backend, or one that does not know the command, keeps the media query. */
let started: Promise<void> | null = null;
export function startOsTheme(): Promise<void> {
  return (started ??= (async () => {
    try {
      await listen<{ dark?: unknown }>("os-color-scheme", (e) => set(typeof e.payload?.dark === "boolean" ? e.payload.dark : null));
    } catch {
      /* no event channel: the media query */
    }
    try {
      const v = await api.osColorScheme();
      set(typeof v?.dark === "boolean" ? v.dark : null);
    } catch {
      /* an old backend, or a window that may not ask: the media query */
    }
  })());
}
