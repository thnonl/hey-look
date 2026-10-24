// The main window's side of a compose window's requests (composeRequests.ts has the kinds and the checks; the channel is `popout-request`,
// which the backend sends to `main` only, with the label of the caller stamped on it). Registered next to the reader's handler in App.tsx.
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { openDraftThread, picturesToEditor } from "../draftOpen";
import { t } from "../i18n";
import { friendlyError, useStore, type Dialog } from "../store";
import { fmtWhen } from "../util";
import { startCompose } from "./composeOpen";
import type { ComposeInit } from "../store";
import { parseComposeRequest } from "./composeRequests";
import { fills } from "./composeFills";
import { recoverOne } from "../composeRecovery";
import { setPopoutCounts } from "./popoutCount";

interface Envelope {
  id: string;
  from: string;
  kind: string;
  payload: unknown;
}

/**
 * Undo of "Scheduled for ...": the message leaves the outbox and is opened again as a new message (the way the pane does it). It is held first, so
 * the worker cannot send it in the moment between.
 */
async function undoScheduled(id: string): Promise<void> {
  const st = useStore.getState();
  try {
    const e = await api.outboxOpenForEdit(id);
    await api.cancelOutbox(id);
    const d = e.draft;
    await startCompose(
      {
        accountId: d.accountId,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyHtml: picturesToEditor(d.html, d.inline ?? []),
        inReplyTo: d.inReplyTo ?? null,
        references: d.references,
        attachments: d.attachments,
        security: d.security,
        meeting: d.meeting ? { ...d.meeting, on: true } : undefined,
        confidential: d.confidential,
        importance: d.importance,
        carried: true,
      },
      { shift: false },
    );
  } catch (err) {
    st.showToast(() => friendlyError(err), undefined, "error");
  }
  void st.refresh();
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
    case "scheduled":
      // (the same toast the pane makes: the main window owns the outbox, so Undo and View work here)
      st.showToast(
        () => t("compose.toast.scheduled", { when: fmtWhen(p.sendAt) }),
        () => void undoScheduled(p.outboxId),
        "success",
        [{ label: () => t("compose.toast.view"), run: () => void useStore.getState().setView("scheduled") }],
      );
      void st.refresh();
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
    case "fill-ready":
      fills.listening(env.from);
      break;
    case "pop-in":
      void import("./mainLazy").then((m) => m.popIn(env, p.init as ComposeInit));
      break;
    case "pop-in-result":
      void import("./mainLazy").then((m) => m.popInResult(env));
      break;
  }
  return true;
}

/** A window was ended because its page process died twice (W4.2): say so, and save what a compose window held. */
export function handlePopoutCrashed(p: { label?: unknown; kind?: unknown; recoveryId?: unknown }): void {
  // (it stays until it is closed: the person may be in another window, or the main window hidden in the tray, when it comes; D-095: an 8 s toast was gone before it was seen)
  useStore.getState().setStickyToast("popout-crashed", { text: () => t("app.popout.crashed"), kind: "error" });
  if (p.kind === "compose" && typeof p.recoveryId === "string" && p.recoveryId) void recoverOne(p.recoveryId).catch(() => undefined);
}

/** The listeners of the main window: compose window requests and the count of open windows. Returns the function that removes them. */
export function startComposeHub(): () => void {
  const subs = [
    listen<Envelope>("popout-request", (e) => void handleComposeRequest(e.payload)),
    listen<{ compose?: number; reader?: number }>("popout-count", (e) => setPopoutCounts(e.payload)),
    listen<{ what?: unknown; from?: unknown }>("data-changed", (e) => void import("./mainLazy").then((m) => m.handleDataChanged(e.payload ?? {}))),
    listen<{ label?: unknown; kind?: unknown; recoveryId?: unknown }>("popout-crashed", (e) => handlePopoutCrashed(e.payload ?? {})),
  ];
  return () => subs.forEach((s) => void s.then((off) => off()).catch(() => undefined));
}
