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
//   moves with Undo, the quit / tray / update logic. A view that needs one of them sends a request through the backend to the main page
//   (`popout_request`); events meant for the main page are sent to `main` only. (A compose window keeps the Undo-send timer of its own
//   message itself: when it is closed during the Undo time it goes out of sight and stays alive until the message has gone, ComposeView.tsx.)
// - Hand-off data (a compose body, attachments) is read once with `api.popoutInit(token)`; it lives in the backend until the window is
//   destroyed, so a reload of the page can read it again.
import type { ComponentType } from "react";
import { lazyView, LazyLoading } from "../lazy";
import { loadComposeWindowView, loadReaderWindowView } from "../lazyViews";
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
  /** the page was loaded again after its process died (W4.2) */
  reloaded?: boolean;
  /** a compose window: the id of the crash snapshot of its message, when the window reported one */
  recoveryId?: string | null;
}

export const devFlagOn = () => {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("heylook.popoutDev");
  } catch {
    /* no storage: off */
  }
  return popoutDevEnabled(import.meta.env.DEV, stored);
};

// The view of a window is a chunk of its own, fetched by main.tsx before React renders (the compose window also gets the editor with it, the reader window never does): until it is
// there the window shows the empty root of the loading step (PopoutRoot), with the loading look after 150 ms. A view that cannot be fetched shows Retry (there is no pane to fall back to).
const windowFrame = (_p: PopoutViewProps, late: boolean) => <div className="popout-root" data-popout="loading">{late ? <LazyLoading /> : null}</div>;
export const VIEWS: Record<PopoutKind, ComponentType<PopoutViewProps>> = {
  compose: lazyView({ key: "popout-compose", kind: "popout", load: loadComposeWindowView, pick: (m) => m.default, frame: windowFrame, retry: true }),
  reader: lazyView({ key: "popout-reader", kind: "popout", load: loadReaderWindowView, pick: (m) => m.default, frame: windowFrame, retry: true }),
};
