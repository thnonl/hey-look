// "Open in new window" for a conversation (REQ-R1): the double-click on a row, Shift+Enter on a focused row, the row's context menu, the button of
// the reading pane and the command bar all end here. One window per conversation: asking again focuses the window that has it (REQ-R2,
// `Registry::request` in popout.rs, keyed by the conversation id).
import type { ThreadSummary } from "../api";
import { useStore } from "../store";
import { openPopout } from "./open";
import { readerAllowed, type ReaderInit } from "./readerLogic";

/** `view`: the folder / view key of the main window the row is in. Resolves to true when a window was opened or focused. */
export async function openReader(t: Pick<ThreadSummary, "threadId" | "accountId" | "folder" | "subject">, view: string): Promise<boolean> {
  if (!readerAllowed(view, t.folder)) return false;
  const init: ReaderInit = { threadId: t.threadId, accountId: t.accountId, folder: t.folder, view, subject: t.subject, listAccount: useStore.getState().accountId };
  return openPopout("reader", t.threadId, init);
}
