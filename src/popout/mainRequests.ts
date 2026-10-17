// The main page's side of the requests of the secondary windows (spec 3.3, REQ-S4): the backend sends `popout-request` to `main` only, with
// the label of the caller stamped on it. Each kind is checked first (requestKinds.ts), then done with the main page's own machinery:
// the intent layer and the Undo window of `act`, `setPrefs` (the only writer of the preferences), the dialogs, `replyTo` / `forward`.
// The answer goes back through the backend to that window (`popout_reply`).
import { forward, replyTo } from "../actions";
import { importKeyFromMessage } from "../components/Pgp";
import { api, MessageFull } from "../api";
import { calTz, today } from "../calendar";
import { friendlyError, useStore, type Dialog } from "../store";
import { parseRequest, type Envelope } from "./requestKinds";

/** Show the main window (it may be hidden in the tray) for something that needs it: a dialog, a message being written. */
const showMain = () => void api.showWindow().catch(() => undefined);

async function run(env: Envelope): Promise<unknown> {
  const p = parseRequest(env.kind, env.payload);
  if ("error" in p) throw new Error(p.error);
  const st = useStore.getState();
  switch (p.kind) {
    case "thread-action": {
      const { threadId, action, arg, label, view } = p.req;
      // the main page does it as it does for its own buttons: the intent layer for read / flag / pin, and for a move the Undo window with its
      // "Archived · Undo" toast (in the main window); the mail leaves the main list at once. `view` is the view the reader was opened from.
      await st.act([threadId], action, arg, label, view);
      return null;
    }
    case "prefs":
      st.setPrefs(p.patch);
      return null;
    case "compose": {
      // until the compose window exists (WP6b) an answer opens in the main window, as it does from the reading pane
      showMain();
      const m = p.req.message as unknown as MessageFull;
      const thread = p.req.threadMessageIds.map((messageId) => ({ messageId }) as unknown as MessageFull);
      // (not awaited: a message already being written asks its question in the main window; the reader has nothing to wait for)
      const go = p.req.mode === "forward" ? forward(m, thread) : replyTo(m, p.req.mode === "replyAll", thread);
      void go.catch((e) => st.showToast(friendlyError(e), undefined, "error"));
      return null;
    }
    case "import-key":
      await importKeyFromMessage({ id: p.messageId } as unknown as MessageFull, p.index);
      return null;
    case "compose-new":
      showMain();
      void st.openCompose(p.req);
      return null;
    case "dialog":
      showMain();
      st.setDialog(p.req.type === "settings" ? { type: "settings", tab: p.req.tab, focus: p.req.focus, nonce: Date.now() } : (p.req as unknown as Dialog));
      return null;
    case "calendar":
      showMain();
      st.setCalDate(p.day ?? today(calTz(st.prefs)));
      st.setModule("calendar");
      return null;
    case "show-main":
      showMain();
      return null;
  }
}

/** Handle one request and tell the window how it went. Never throws: a failure is the answer. */
export async function handlePopoutRequest(env: Envelope): Promise<void> {
  const from = env.from;
  try {
    const data = await run(env);
    await api.popoutReply(from, env.id, true, data, null);
  } catch (e) {
    await api.popoutReply(from, env.id, false, null, friendlyError(e)).catch(() => undefined);
  }
}
