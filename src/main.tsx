import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api";
import { applySavedLanguage } from "./bootLang";
import { GuardMenuHost } from "./components/GuardMenuHost";
import { installContextGuard } from "./contextGuard";
import { loadPlatform } from "./platform";
import { installMacPasteMatch, installPlainPasteKey } from "./plainPasteKey";
import PopoutRoot from "./popout/PopoutRoot";
import { installModifierTracking } from "./popout/modifier";
import { routeOf } from "./popout/route";

// One bundle, several windows: the main window has no query, a secondary window (compose / reader) is opened by the backend at ?w=<kind>
// (src/popout/route.ts). A secondary window mounts <PopoutRoot /> and never the app.
const route = routeOf(window.location.search);

async function boot(): Promise<boolean> {
  // `npm run dev` in a plain browser has no Tauri backend: use fake data so the UI can be previewed.
  // The dynamic imports of the dev-only modules sit directly inside `if (import.meta.env.DEV ...)`, a literal the production build removes,
  // so devMock.ts / devDarkCheck.ts are not emitted as chunks of a release build (scripts/bundle-budget.json `neverShipped`). The same for popout/dev.ts.
  const mock = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);
  if (import.meta.env.DEV && mock) {
    (await import("./devMock")).installMock();
  }
  // the saved language first: nothing is drawn, and no event handler exists yet, until it is applied (see bootLang.ts)
  await applySavedLanguage(api.getSetting);
  // the main window reads the system (and whether this is a debug build) in the store's init(); a secondary window has no init(), and the menu rules need it
  if (route.kind !== "main") await loadPlatform();
  installContextGuard(); // no native webview menu in a release build (see contextPolicy.ts)
  installPlainPasteKey(); // macOS: Cmd+Shift+V in a text box (WKWebView sends no paste event for it)
  installMacPasteMatch(); // macOS: Edit > Paste and Match Style (the menu item tells the focused window)
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
