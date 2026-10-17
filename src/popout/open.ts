// Open (or focus) a secondary window from the page of the main window (or of another secondary window: a reader opens a compose window).
// The backend creates the window and enforces the cap (popout.rs); this turns its answer into the toast of the spec (REQ-W6, C4).
import { api } from "../api";
import { t } from "../i18n";
import { friendlyError, useStore } from "../store";
import type { PopoutKind } from "./route";

/**
 * `key` makes the window unique (a conversation id, a draft id): asking again focuses the window that has it. `init` is kept in the backend
 * for the new page (`api.popoutInit`). Resolves to true when a window was created or focused; false after it told the person why not.
 */
export async function openPopout(kind: PopoutKind, key?: string | null, init?: unknown): Promise<boolean> {
  const toast = useStore.getState().showToast;
  try {
    const r = await api.popoutOpen(kind, key ?? null, init ?? null);
    if (r.status === "tooMany") {
      toast(t("app.popout.tooMany"), undefined, "error");
      return false;
    }
    return true;
  } catch (e) {
    toast(t("app.popout.openFailed", { error: friendlyError(e).replace(/\.$/, "") }), undefined, "error");
    return false;
  }
}
