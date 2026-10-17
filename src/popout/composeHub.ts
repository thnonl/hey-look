// The main window's side of a compose window's requests (composeRequests.ts has the kinds and the checks; the channel is `popout-request`,
// which the backend sends to `main` only, with the label of the caller stamped on it). Registered next to the reader's handler in App.tsx.
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { openDraftThread } from "../components/Compose";
import { t } from "../i18n";
import { useStore, type Dialog } from "../store";
import { parseComposeRequest } from "./composeRequests";
import { setPopoutCounts } from "./popoutCount";

interface Envelope {
  id: string;
  from: string;
  kind: string;
  payload: unknown;
}

/** Handle `env` when it is a compose window's request. Returns false for any other kind (the reader's handler takes those). */
export function handleComposeRequest(env: Envelope): boolean {
  const p = parseComposeRequest(env.kind, env.payload);
  if (p === null) return false;
  if ("error" in p || !env.from.startsWith("compose-")) return true; // refused: nothing is done
  const st = useStore.getState();
  switch (p.kind) {
    case "toast":
      // (the window made the text in the language in use there, which is the language in use here)
      st.showToast(p.text, undefined, p.level); // i18n-ok: made by the compose window, in the language in use
      break;
    case "draft-saved":
      st.showToast(
        () => t(p.plain ? "compose.toast.draftSavedPlain" : "compose.toast.draftSaved"),
        undefined,
        p.plain ? "info" : "success",
        [{ label: () => t("common.edit"), run: () => void openDraftThread(p.threadId, true) }],
      );
      break;
    case "dialog":
      // Settings and the key dialogs are the main window's: it comes forward (it may sit in the tray)
      void api.showWindow().catch(() => undefined);
      st.setDialog(p.dialog.type === "settings" ? { type: "settings", tab: p.dialog.tab, focus: p.dialog.focus, nonce: Date.now() } : (p.dialog as Dialog));
      break;
    case "sync":
      void st.sync();
      break;
    case "refresh":
      void st.refresh();
      break;
  }
  return true;
}

/** The listeners of the main window: compose window requests and the count of open windows. Returns the function that removes them. */
export function startComposeHub(): () => void {
  const subs = [
    listen<Envelope>("popout-request", (e) => void handleComposeRequest(e.payload)),
    listen<{ compose?: number; reader?: number }>("popout-count", (e) => setPopoutCounts(e.payload)),
  ];
  return () => subs.forEach((s) => void s.then((off) => off()).catch(() => undefined));
}
