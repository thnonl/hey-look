// The views of the secondary windows, by kind. This is where WP6b (compose) and WP6c (reader) plug in: replace the entry of their kind
// in VIEWS with the real component. Everything around it is done by <PopoutRoot> (src/popout/PopoutRoot.tsx): the preferences, the theme,
// the language, the answer to a quit, the shortcut that closes the window and the "ready" signal that shows it.
//
// Which state a view may use, and how (the rule for both kinds):
// - Per window (its own JS store, nothing shared with other web views): what is on screen, the text being written, dialogs, toasts, the
//   selection. A view may create its own zustand store; it must not import and mount the main page's `useStore` data as if it were
//   loaded (`useStore.init()` is never called in a secondary window, so accounts, folders and threads are empty there).
// - Shared through the backend, read with `api.*` commands (the allowlist is src-tauri/capabilities/popout.json): accounts, folders, a
//   thread's messages, signatures, templates, contacts, the settings. Refresh on the broadcast events `mail-synced`, `outbox-changed`,
//   `calendar-changed` and `prefs-changed`.
// - Owned by the main page and asked for, never done here: the `prefs` blob (only the main page writes it), read / flag / pin intents,
//   moves with Undo, the Undo-send timer and `sendsInFlight`, the quit / tray / update logic. A view that needs one of them sends a request
//   through the backend to the main page (WP6b adds `popout_request`); events meant for the main page are sent to `main` only.
// - Hand-off data (a compose body, attachments) is read once with `api.popoutInit(token)`; it lives in the backend until the window is
//   destroyed, so a reload of the page can read it again.
import type { ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../i18n/react";
import { DevPanel } from "./devPanel";
import { popoutDevEnabled } from "./route";
import type { PopoutKind } from "./route";

export interface PopoutViewProps {
  kind: PopoutKind;
  /** the window label, `compose-<n>` / `reader-<n>` */
  label: string;
  /** what the window shows when only one window may show it (a conversation, a draft); null when there is no such rule */
  keyOf: string | null;
  /** the hand-off data the opener left in the backend */
  init: unknown;
}

const close = () => void getCurrentWindow().close().catch(() => undefined);

export const devFlagOn = () => {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("heylook.popoutDev");
  } catch {
    /* no storage: off */
  }
  return popoutDevEnabled(import.meta.env.DEV, stored);
};

/** Stands in for a view that does not exist yet. A person cannot reach it (nothing opens a window yet); the dev flag shows what it knows. */
function Placeholder({ kind, label, keyOf, init }: PopoutViewProps) {
  const t = useT();
  const dev = devFlagOn();
  return (
    <div className="popout-root" data-popout={kind} data-label={label}>
      {dev && <DevPanel kind={kind} label={label} keyOf={keyOf} init={init} />}
      <p>
        <button className="btn" onClick={close}>{t("common.close")}</button>
      </p>
    </div>
  );
}

export const VIEWS: Record<PopoutKind, ComponentType<PopoutViewProps>> = {
  compose: Placeholder, // WP6b
  reader: Placeholder, // WP6c
};
