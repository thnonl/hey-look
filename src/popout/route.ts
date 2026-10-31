// Which window is this page in? One bundle serves the main window and every secondary window ("pop-out": compose, reader); the backend
// opens a pop-out at `index.html?w=<kind>&t=<token>` (popout.rs), and the main window has no query. The entry file (main.tsx) asks
// `routeOf` once and mounts either <App /> or <PopoutRoot />. Pure (no browser, no Tauri), so scripts/test-popout.mjs runs it.

export type PopoutKind = "compose" | "reader" | "event" | "settings" | "search" | "scheduled";

/** Every kind of secondary window (the same names as src-tauri/src/popout.rs `Kind`). */
export const POPOUT_KINDS: readonly PopoutKind[] = ["compose", "reader", "event", "settings", "search", "scheduled"];

export type Route =
  /** the main window: the whole app */
  | { kind: "main" }
  /** a secondary window; `token` is the opaque value of the address that `popout_init` checks (REQ-S3: no personal data in the address) */
  | { kind: PopoutKind; token: string }
  /** an address that names no window kind: nothing is mounted (never a second copy of the app) */
  | { kind: "invalid"; value: string };

export type PopoutRoute = Extract<Route, { kind: PopoutKind }>;

/** The kind a window label names (`reader-4` -> reader), the same rule as popout.rs `kind_of_label`; null for `main` and anything else. */
export function kindOfLabel(label: string | null | undefined): PopoutKind | null {
  const m = /^([a-z]+)-(\d+)$/.exec(label ?? "");
  return m && (POPOUT_KINDS as readonly string[]).includes(m[1]) ? (m[1] as PopoutKind) : null;
}

/** The label of this window as Tauri gave it to the page (injected before the page runs; null in a plain browser). */
export function ownLabel(): string | null {
  try {
    return (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * Which window is this page in? The address says (`?w=<kind>&t=<token>`); when the address has no query - a web view that opened the base address (1.0.12 BUG-L1: a reader window on Linux
 * ran as the main app and followed its selection) - the label of the window says, and the token is empty: `popout_init` then identifies the window by its label alone.
 */
export function routeOf(search: string, label: string | null = null): Route {
  const q = new URLSearchParams(search);
  const w = q.get("w");
  if (w === null || w === "" || w === "main") {
    const k = kindOfLabel(label);
    return k ? { kind: k, token: q.get("t") ?? "" } : { kind: "main" };
  }
  if ((POPOUT_KINDS as readonly string[]).includes(w)) return { kind: w as PopoutKind, token: q.get("t") ?? "" };
  return { kind: "invalid", value: w };
}

export function isPopout(route: Route): route is PopoutRoute {
  return (POPOUT_KINDS as readonly string[]).includes(route.kind);
}

/** Is this page a secondary window? (The main page has no `?w=`: whatever opens a message, a dialog or a window from a window does it as a window of its own.) */
export function inSecondaryWindow(search: string = typeof window === "undefined" ? "" : window.location.search, label: string | null = ownLabel()): boolean {
  return isPopout(routeOf(search, label));
}

/**
 * The placeholder pages show what they know (label, key, hand-off data) and a button that opens another window only when this is on:
 * always in a dev build (`npm run dev`), and in a release build when `localStorage["heylook.popoutDev"] === "1"` (set in the window's
 * devtools of a debug build). A person never sees it: nothing in the app opens a pop-out yet (WP6b / WP6c plug their views in).
 */
export function popoutDevEnabled(dev: boolean, stored: string | null): boolean {
  return dev || stored === "1";
}

/** The window title (REQ-W7): `{title} – Hey Look!`. An empty title is just the app name. */
export function popoutTitle(title: string): string {
  const t = title.trim();
  return t ? `${t} – Hey Look!` : "Hey Look!";
}
