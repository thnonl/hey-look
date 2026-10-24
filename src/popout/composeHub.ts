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
import { showMain } from "./mainRequests";

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
      void popIn(env, p.init as ComposeInit);
      break;
    case "pop-in-result": {
      const pending = popIns.get(env.from);
      void (pending ?? Promise.resolve(false)).then((opened) => reply(env, { opened }));
      break;
    }
  }
  return true;
}

/** The "Move to main window" asks of the compose windows that wait for the main window's question, by window label. */
const popIns = new Map<string, Promise<boolean>>();
const reply = (env: Envelope, data: unknown) => void api.popoutReply(env.from, env.id, true, data, null).catch(() => undefined);

/**
 * A compose window moves its message back to the main window (W4.5): the main window comes forward (from the tray, restored when minimized) and opens the message in its inline
 * Compose. When the pane holds a message with changes the existing "unsent" question comes first; Keep writing leaves everything as it was. The window is told at once
 * when the question is open ("asking"), and asks for the result after it (it waits as long as the question is open).
 */
async function popIn(env: Envelope, init: ComposeInit): Promise<void> {
  const st = useStore.getState();
  showMain();
  const opening = st.openCompose(init).then(() => useStore.getState().compose === init);
  popIns.set(env.from, opening);
  const quick = await Promise.race([opening, new Promise<null>((r) => setTimeout(() => r(null), 150))]);
  if (quick === null) return reply(env, { state: "asking" });
  popIns.delete(env.from);
  reply(env, { opened: quick });
}

/** A window was ended because its page process died twice (W4.2): say so, and save what a compose window held. */
export function handlePopoutCrashed(p: { label?: unknown; kind?: unknown; recoveryId?: unknown }): void {
  useStore.getState().showToast(() => t("app.popout.crashed"), undefined, "error");
  if (p.kind === "compose" && typeof p.recoveryId === "string" && p.recoveryId) void recoverOne(p.recoveryId).catch(() => undefined);
}

/** The listeners of the main window: compose window requests and the count of open windows. Returns the function that removes them. */
export function startComposeHub(): () => void {
  const subs = [
    listen<Envelope>("popout-request", (e) => void handleComposeRequest(e.payload)),
    listen<{ compose?: number; reader?: number }>("popout-count", (e) => setPopoutCounts(e.payload)),
    listen<{ label?: unknown; kind?: unknown; recoveryId?: unknown }>("popout-crashed", (e) => handlePopoutCrashed(e.payload ?? {})),
  ];
  return () => subs.forEach((s) => void s.then((off) => off()).catch(() => undefined));
}
