import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api";
import { applySavedLanguage } from "./bootLang";
import { GuardMenuHost } from "./components/GuardMenuHost";
import { installContextGuard } from "./contextGuard";
import { loadPlatform } from "./platform";
import { onOsDarkChange, startOsTheme } from "./osTheme";
import { installMailCanvasSync } from "./mailCanvasSync";
import { applyPrefs, useStore } from "./store";
import { installMacMenu } from "./macMenu";
import { installMacPasteMatch, installPlainPasteKey } from "./plainPasteKey";
import { prefetchComposeWindow, prefetchReaderWindow, prefetchWindowView } from "./lazyViews";
import PopoutRoot from "./popout/PopoutRoot";
import { installModifierTracking } from "./popout/modifier";
import { routeOf } from "./popout/route";

// One bundle, several windows: the main window has no query, a secondary window (compose / reader) is opened by the backend at ?w=<kind>
// (src/popout/route.ts). A secondary window mounts <PopoutRoot /> and never the app.
const route = routeOf(window.location.search);
// a window's view (and the editor for a compose window) is asked for now, beside the language and the preferences, before React renders (REQ-9.2.3)
if (route.kind === "compose") prefetchComposeWindow();
else if (route.kind === "reader") prefetchReaderWindow();
else if (route.kind === "event" || route.kind === "settings" || route.kind === "search" || route.kind === "scheduled") prefetchWindowView(route.kind);

async function boot(): Promise<boolean> {
  // debug builds only (src-tauri/src/startup.rs boot_delay_*): HEYLOOK_TEST_BOOT_DELAY_MS keeps the start screen of index.html on the window that long, for the first
  // HEYLOOK_TEST_BOOT_DELAY_LOADS loads of the window (a reload keeps sessionStorage)
  const hold = (window as { __heylookBootDelay?: { ms: number; loads: number } }).__heylookBootDelay;
  if (hold) {
    let n = 0;
    try { n = Number(sessionStorage.getItem("heylook.bootDelayed") ?? 0); sessionStorage.setItem("heylook.bootDelayed", String(n + 1)); } catch { /* no storage: held once */ }
    if (n < hold.loads) await new Promise((r) => setTimeout(r, hold.ms));
  }
  // `npm run dev` in a plain browser has no Tauri backend: use fake data so the UI can be previewed.
  // The dynamic imports of the dev-only modules sit directly inside `if (import.meta.env.DEV ...)`, a literal the production build removes,
  // so devMock.ts / devDarkCheck.ts are not emitted as chunks of a release build (scripts/bundle-budget.json `neverShipped`). The same for popout/dev.ts.
  const mock = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);
  if (import.meta.env.DEV && mock) {
    (await import("./devMock")).installMock();
  }
  // Linux: what the OS scheme is comes from the backend (osTheme.ts, W5.2); asked before the first drawing, the answer waits for at most a second (never on Windows and macOS: no wait)
  void onOsDarkChange(() => applyPrefs(useStore.getState().prefs));
  const osAsked = startOsTheme();
  installMailCanvasSync(route.kind === "main"); // a switch of the app theme clears the light theme's session mail background and the composer's preview choice (WP13g)
  if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) await Promise.race([osAsked, new Promise((r) => setTimeout(r, 1200))]);
  // the saved language first: nothing is drawn, and no event handler exists yet, until it is applied (see bootLang.ts)
  await applySavedLanguage(api.getSetting);
  // the main window reads the system (and whether this is a debug build) in the store's init(); a secondary window has no init(), and the menu rules need it
  if (route.kind !== "main") await loadPlatform();
  installContextGuard(); // no native webview menu in a release build (see contextPolicy.ts)
  installPlainPasteKey(); // macOS: Cmd+Shift+V in a text box (WKWebView sends no paste event for it)
  installMacPasteMatch(); // macOS: Edit > Paste and Match Style (the menu item tells the focused window)
  installMacMenu(route.kind === "main"); // macOS: Settings…, File > Print… and Help of the menu bar (W5.11)
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {route.kind === "main" ? <App /> : <PopoutRoot route={route} />}
      <GuardMenuHost />
    </React.StrictMode>,
  );
  return mock;
}

void boot().then(async (mock) => {
  // dev flag: lets a person open placeholder windows from the main window's console (window.__heylookPopout.open("compose"))
  if (import.meta.env.DEV && route.kind === "main") void import("./popout/dev").then((m) => m.installPopoutDev());
  // "hold Shift to do the opposite" for starting a message: the click or key being handled is noted (popout/modifier.ts)
  if (route.kind === "main") installModifierTracking();
  // dev preview only: `#dark&cal=week&thread=t15` puts the mock app into a state (handy for screenshots)
  if (import.meta.env.DEV && mock && window.location.hash.length > 1) {
    (await import("./devMock")).applyDemoHash();
  }
});
