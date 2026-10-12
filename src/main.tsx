import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function boot() {
  // `npm run dev` in a plain browser has no Tauri backend: use fake data so the UI can be previewed.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./devMock")).installMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
