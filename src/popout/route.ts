// Which window is this page in? One bundle serves the main window and every secondary window ("pop-out": compose, reader); the backend
// opens a pop-out at `index.html?w=<kind>&t=<token>` (popout.rs), and the main window has no query. The entry file (main.tsx) asks
// `routeOf` once and mounts either <App /> or <PopoutRoot />. Pure (no browser, no Tauri), so scripts/test-popout.mjs runs it.

export type PopoutKind = "compose" | "reader";

export type Route =
  /** the main window: the whole app */
  | { kind: "main" }
  /** a secondary window; `token` is the opaque value of the address that `popout_init` checks (REQ-S3: no personal data in the address) */
  | { kind: PopoutKind; token: string }
  /** an address that names no window kind: nothing is mounted (never a second copy of the app) */
  | { kind: "invalid"; value: string };

export type PopoutRoute = Extract<Route, { kind: PopoutKind }>;

export function routeOf(search: string): Route {
  const q = new URLSearchParams(search);
  const w = q.get("w");
  if (w === null || w === "" || w === "main") return { kind: "main" };
  if (w === "compose" || w === "reader") return { kind: w, token: q.get("t") ?? "" };
  return { kind: "invalid", value: w };
}

export function isPopout(route: Route): route is PopoutRoute {
  return route.kind === "compose" || route.kind === "reader";
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
