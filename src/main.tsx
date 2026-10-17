import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api";
import { applySavedLanguage } from "./bootLang";
import { installContextGuard } from "./contextGuard";
import PopoutRoot from "./popout/PopoutRoot";
import { installModifierTracking } from "./popout/modifier";
import { routeOf } from "./popout/route";

// One bundle, several windows: the main window has no query, a secondary window (compose / reader) is opened by the backend at ?w=<kind>
// (src/popout/route.ts). A secondary window mounts <PopoutRoot /> and never the app.
const route = routeOf(window.location.search);

async function boot(): Promise<boolean> {
  // `npm run dev` in a plain browser has no Tauri backend: use fake data so the UI can be previewed.
  const mock = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);
  if (mock) {
    (await import("./devMock")).installMock();
  }
  // the saved language first: nothing is drawn, and no event handler exists yet, until it is applied (see bootLang.ts)
  await applySavedLanguage(api.getSetting);
  installContextGuard(); // no native webview menu in a release build (see contextPolicy.ts)
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {route.kind === "main" ? <App /> : <PopoutRoot route={route} />}
    </React.StrictMode>,
  );
  return mock;
}

void boot().then(async (mock) => {
  // dev flag: lets a person open placeholder windows from the main window's console (window.__heylookPopout.open("compose"))
  if (route.kind === "main") void import("./popout/dev").then((m) => m.installPopoutDev());
  // "hold Shift to do the opposite" for starting a message: the click or key being handled is noted (popout/modifier.ts)
  if (route.kind === "main") installModifierTracking();
  // dev preview only: `#dark&cal=week&thread=t15` puts the mock app into a state (handy for screenshots)
  if (mock && window.location.hash.length > 1) {
    (await import("./devMock")).applyDemoHash();
  }
});
