// The drop of conversations on a folder (W4.7): what happens after the pointer was released. A chunk of its own, loaded on the first drop (the pointer logic stays in the folder pane).
import { api } from "./api";
import { dropAction, dropAllowed, type DragPayload } from "./dragDrop";
import { t } from "./i18n";
import { folderTitle } from "./prefs";
import { moveChoices } from "./rowMenu";
import { useStore } from "./store";

/** The drop of the conversations `taken` (asked of the registry at the drop) on the folder `key` of mailbox `acct`: exactly what the Move to menu and the buttons do (`act`: the Undo toast of the main window). */
export async function dropMail(taken: Promise<DragPayload | null>, acct: string, key: string): Promise<void> {
  const p = await taken;
  const st = useStore.getState();
  const moveKeys = (accountId: string) => moveChoices(st.folders, accountId, undefined).map((f) => f.key);
  if (!p || p.kind !== "mail" || !dropAllowed(p.items, { accountId: acct, key }, moveKeys)) return;
  const info = st.folders.find((f) => f.accountId === acct && f.key === key);
  const title = info ? folderTitle(info, st.folders) : key;
  const { action, arg } = dropAction(key);
  const label = action === "junk" ? () => t("mail.done.junk") : action === "trash" ? () => t("mail.done.trashed") : action === "archive" ? () => t("mail.done.archived") : () => t("mail.done.moved", { folder: title });
  await st.act(p.items.map((i) => i.threadId), action, arg, label, p.view);
  // a conversation that was dragged from a reader window: the window closes, as it does for its own move buttons (REQ-R6)
  if (p.from.startsWith("reader-")) void api.popoutClose(p.from).catch(() => undefined);
}
