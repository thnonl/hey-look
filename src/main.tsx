import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api";
import { applySavedLanguage } from "./bootLang";
import { installContextGuard } from "./contextGuard";

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
      <App />
    </React.StrictMode>,
  );
  return mock;
}

void boot().then(async (mock) => {
  // dev preview only: `#dark&cal=week&thread=t15` puts the mock app into a state (handy for screenshots)
  if (mock && window.location.hash.length > 1) {
    (await import("./devMock")).applyDemoHash();
  }
});
