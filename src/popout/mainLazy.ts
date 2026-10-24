// The parts of the main page's side of the windows that run rarely and are loaded when they run (the first Next / Previous in a reader window, the first Move to main window of a
// compose window, the first change of the accounts made in another window): a chunk of its own, so the first chunk of the app stays small (W4.4, W4.5, W4.6).
import { api } from "../api";
import { orderAccounts } from "../accountOrder";
import { useStore, type ComposeInit } from "../store";
import { neighborOf, rowWindowTarget, type Neighbor } from "./readerLogic";
import { showMain } from "./mainRequests";
import type { Envelope, NeighborsReq } from "./requestKinds";

/**
 * The conversations before and after the one a reader window shows (W4.4, REQ-4.4.3): in the main window's list as it is now when that holds it (its order, sort,
 * search and filter), else in the list of the view the window was opened from, read like the main list (the mailbox selection of that time, the sort and the
 * conversation setting, no search, no Unread / Flagged filter). Rows a reader cannot show (drafts, Scheduled) are skipped; no wrap.
 */
export async function neighborsFor(r: NeighborsReq): Promise<{ prev: Neighbor | null; next: Neighbor | null }> {
  const st = useStore.getState();
  let rows = st.threads;
  let view = st.folder;
  if (!rows.some((x) => x.threadId === r.threadId)) {
    view = r.view || r.folder;
    rows = await api.listThreads({ accountId: r.listAccount, folder: view, search: "", focus: null, flat: !st.prefs.conversations, unreadOnly: false, flaggedOnly: false, sortAsc: st.prefs.sortAsc, scope: "current" });
  }
  const can = (x: { folder: string }) => rowWindowTarget(view, x.folder) === "reader";
  const pick = (dir: 1 | -1): Neighbor | null => {
    const n = neighborOf(rows, r.threadId, dir, can);
    return n ? { threadId: n.threadId, accountId: n.accountId, folder: n.folder, subject: n.subject, view } : null;
  };
  return { prev: pick(-1), next: pick(1) };
}


/** The "Move to main window" asks of the compose windows that wait for the main window's question, by window label. */
const popIns = new Map<string, Promise<boolean>>();
const reply = (env: Envelope, data: unknown) => void api.popoutReply(env.from, env.id, true, data, null).catch(() => undefined);

/**
 * A compose window moves its message back to the main window (W4.5): the main window comes forward (from the tray, restored when minimized) and opens the message in its inline
 * Compose. When the pane holds a message with changes the existing "unsent" question comes first; Keep writing leaves everything as it was. The window is told at once
 * when the question is open ("asking"), and asks for the result after it (it waits as long as the question is open).
 */
export async function popIn(env: Envelope, init: ComposeInit): Promise<void> {
  const st = useStore.getState();
  showMain();
  const opening = st.openCompose(init).then(() => useStore.getState().compose === init);
  popIns.set(env.from, opening);
  const quick = await Promise.race([opening, new Promise<null>((r) => setTimeout(() => r(null), 150))]);
  if (quick === null) return reply(env, { state: "asking" });
  popIns.delete(env.from);
  reply(env, { opened: quick });
}


/** The result of a Move to main window that said "asking": when the person has answered the question of the main window. */
export function popInResult(env: Envelope): void {
  const pending = popIns.get(env.from);
  void (pending ?? Promise.resolve(false)).then((opened) => reply(env, { opened }));
}

/**
 * Another window changed accounts or the calendar connections (the Settings window, W4.6, `data-changed`): the lists of this window are read again the way they are after its own
 * changes, and a mailbox that is new is synced. The changes this window made itself are followed by its own code.
 */
export async function handleDataChanged(p: { what?: unknown; from?: unknown }): Promise<void> {
  if (typeof p.from !== "string" || p.from === "main") return;
  const st = useStore.getState();
  if (p.what === "accounts") {
    const known = new Set(st.accounts.map((a) => a.id));
    const list = await api.listAccounts().catch(() => null);
    if (!list) return;
    useStore.setState({ accounts: orderAccounts(list, useStore.getState().prefs.accountOrder) });
    void api.listFolders().then((folders) => useStore.setState({ folders })).catch(() => undefined);
    for (const a of list) if (!known.has(a.id)) void api.syncAccount(a.id).catch(() => undefined);
    void st.refresh();
  } else if (p.what === "calendar") {
    void st.loadCalSources();
    st.bumpCal();
  }
}

