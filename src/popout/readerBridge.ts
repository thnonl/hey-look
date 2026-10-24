// What makes the reading-pane components work in the reader window. The window has its own JS store (a web view of its own): it is
// filled once from the backend (accounts, folders, preferences, the AI flag, the conversation) and nothing in it is written back. The
// few store actions that would change something the main page owns are replaced here by a request to the main page
// (src/popout/mainRequests.ts): the mail background switch, the dialogs of the main window, a new message. Answering a message does the
// same through `answerVia` (src/actions.ts).
import { listen } from "@tauri-apps/api/event";
import { CANVAS_SESSION_EVENT } from "../mailCanvasSync";
import { answerVia } from "../actions";
import { api, type MessageFull } from "../api";
import { t } from "../i18n";
import { friendlyError, useStore, type Dialog } from "../store";
import { cancelTranslation } from "../translate";
import { Requester, UNREACHABLE, type Reply } from "./request";

/** The one requester of this window. */
export const requester = new Requester({ send: (id, kind, payload) => api.popoutRequest(id, kind, payload) });

/** The words a failed request is shown in: the main page did not answer, or the reason it gave. */
export function requestError(e: unknown): string {
  return e instanceof Error && e.message === UNREACHABLE ? t("app.popout.mainUnreachable") : friendlyError(e);
}

/** Ask the main page and show a failure as a toast of this window. Resolves to true when the main page did it. */
export async function askMain(kind: string, payload: unknown, timeoutMs?: number): Promise<boolean> {
  try {
    await requester.ask(kind, payload, timeoutMs);
    return true;
  } catch (e) {
    useStore.getState().showToast(() => requestError(e), undefined, "error");
    return false;
  }
}

/** The message a request carries to the main page (an answer needs its text and addresses); the conversation travels as Message-IDs. */
const idsOf = (thread: MessageFull[]) => thread.map((x) => x.messageId);

/** A day picked in an invitation card, for "show in calendar" (the card sets the day, then the module). */
let calendarDay: { y: number; m: number; d: number } | null = null;

export interface ReaderBridge {
  /** re-read the conversation (an invitation changed, a key was unlocked) */
  reload(): void;
}

/** Install the bridge; resolves, once answers can be heard, to the function that removes it. */
export async function installReaderBridge(b: ReaderBridge): Promise<() => void> {
  answerVia.reply = (m, all, thread) => void askMain("compose", { mode: all ? "replyAll" : "reply", message: m, threadMessageIds: idsOf(thread) }, 10_000);
  answerVia.forward = (m, thread) => void askMain("compose", { mode: "forward", message: m, threadMessageIds: idsOf(thread) }, 10_000);
  answerVia.importKey = async (m, index) => {
    if (await askMain("import-key", { messageId: m.id, index }, 60_000)) b.reload();
  };
  useStore.setState({
    // the main page is the only writer of the preferences: the one thing a reader changes is the mail background (REQ-W11)
    setPrefs: (patch) => {
      useStore.setState((s) => ({ prefs: { ...s.prefs, ...patch } }));
      if ("mailCanvas" in patch) void askMain("prefs", { mailCanvas: patch.mailCanvas });
    },
    // the light theme's session mail background (WP13g): shown here at once, owned by the main page, which tells every reader (`mail-canvas-session`)
    setMailCanvasSession: (v) => {
      useStore.setState({ mailCanvasSession: v });
      void askMain("canvas-session", { dark: v === "dark" });
    },
    // Show original and the picture viewer open in this window; Settings, the event dialog and the PGP key dialogs in the main window (REQ-R11)
    setDialog: (d: Dialog) => {
      if (d === null || d.type === "original") useStore.setState({ dialog: d });
      else void askMain("dialog", { dialog: d });
    },
    openCompose: async (c) => {
      if (!c) return;
      await askMain("compose-new", { init: { accountId: c.accountId, to: c.to, subject: c.subject, attachments: c.attachments } }, 30_000);
    },
    reloadMessages: async () => b.reload(),
    // an invitation card shows its event in the calendar of the main window
    setCalDate: (d) => {
      calendarDay = d;
    },
    setModule: (m) => {
      if (m === "calendar") void askMain("calendar", { day: calendarDay });
    },
    bumpCal: () => undefined,
  });
  const off = await listen<Reply>("popout-reply", (e) => requester.answer(e.payload));
  // the session choice of the main page: now (a window opened while it is dark starts dark), and at every change
  const offCanvas = await listen<{ dark?: unknown; theme?: unknown }>(CANVAS_SESSION_EVENT, (e) => {
    if (e.payload?.theme === true) return; // cleared by a switch of the app theme: this window clears its own when its theme changes (mailCanvasSync.ts)
    useStore.setState({ mailCanvasSession: e.payload?.dark === true ? "dark" : null });
  });
  void requester
    .ask("canvas-session", {})
    .then((r) => {
      const dark = (r as { dark?: unknown } | null)?.dark === true;
      // (a theme switch since the window opened has cleared it here; the main page clears its own the same way)
      useStore.setState({ mailCanvasSession: dark ? "dark" : null });
    })
    .catch(() => undefined);
  return () => {
    offCanvas();
    answerVia.reply = undefined;
    answerVia.forward = undefined;
    answerVia.importKey = undefined;
    off();
  };
}

/** The translations under way belong to this window: when it closes they stop and their requests are dropped (REQ-R12). */
export function cancelRunningTranslations() {
  for (const j of Object.values(useStore.getState().translations)) if (j.status === "running") cancelTranslation(j.key);
}
