// The right-click / ContextMenu-key menu of a mail list row: which conversations it acts on and which entries it has.
// Pure (no store, no DOM), so a script can test it (scripts/test-row-menu.mjs); components/ListContextMenu.tsx runs the entries
// through the same store actions as the ribbon, so behaviour is identical.
import { accountsOf, canMoveToJunk, folderVisible } from "./junk.ts";
import type { FolderLike } from "./junk.ts";

/** What a right-click on `clicked` acts on. `makeSelection`: the row is not part of the selection, so it becomes the only selected one first. */
export function contextTargets(
  clicked: string,
  checked: ReadonlySet<string>,
  selected: string | null,
  order: readonly string[],
): { ids: string[]; makeSelection: boolean } {
  if (checked.has(clicked)) {
    // the whole selection, in the order of the list (a checked conversation that is not in the list any more goes last)
    const at = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    return { ids: Array.from(checked).sort((a, b) => at(a) - at(b)), makeSelection: false };
  }
  // a lone open conversation is already "the selection"; any other row is selected first (the mail is not opened)
  return { ids: [clicked], makeSelection: !(checked.size === 0 && selected === clicked) };
}

export interface MenuThread {
  threadId: string;
  accountId: string;
  unread: number;
  flagged: boolean;
  pinned: boolean;
  confidential?: boolean;
}

export type RowAction =
  | "openWindow" | "reply" | "replyAll" | "forward"
  | "read" | "flag" | "pin" | "snooze" | "move"
  | "archive" | "delete" | "junk"
  | "copySender" | "copySubject";

/** Why an entry is off: `many` (it needs exactly one conversation), `mailbox` (the conversations are in several mailboxes), `junk` (no Junk folder), `draft` (a draft is edited, not answered), `confidential` (cannot be forwarded). */
export type Off = "many" | "mailbox" | "junk" | "draft" | "confidential";

/** Which text an entry shows: the ones whose label depends on the state of the conversations. */
export type Variant = "markRead" | "markUnread" | "flag" | "unflag" | "pin" | "unpin" | "trash" | "permanent";

export interface RowMenuEntry {
  action: RowAction;
  off?: Off;
  variant?: Variant;
}

/** One entry, or "-" for a divider. */
export type RowMenuItem = RowMenuEntry | "-";

/**
 * The entries for these conversations (the targets, in list order) in the open view `view` (the folder key). `mixed`/state rules:
 * read -> "Mark as read" when any of them is unread; flag / pin -> "Remove flag" / "Unpin" only when all of them have it.
 */
export function rowMenu(threads: readonly MenuThread[], ctx: { view: string; folders: readonly FolderLike[] }): RowMenuItem[] {
  const one = threads.length === 1;
  const ids = threads.map((t) => t.threadId);
  const draft = ctx.view === "drafts";
  const answer = (action: RowAction): RowMenuEntry => ({ action, ...(draft ? { off: "draft" as Off } : !one ? { off: "many" as Off } : {}) });
  const accounts = new Set(threads.map((t) => t.accountId));
  const noJunk = !canMoveToJunk(ctx.folders, accountsOf(threads, ids));
  const allFlagged = threads.length > 0 && threads.every((t) => t.flagged);
  const allPinned = threads.length > 0 && threads.every((t) => t.pinned);
  const forward = answer("forward");
  if (!forward.off && threads[0]?.confidential) forward.off = "confidential";
  return [
    answer("openWindow"), // (the reader window shows one conversation; in Drafts the draft is edited instead)
    "-",
    answer("reply"),
    answer("replyAll"),
    forward,
    "-",
    { action: "read", variant: threads.some((t) => t.unread > 0) ? "markRead" : "markUnread" },
    { action: "flag", variant: allFlagged ? "unflag" : "flag" },
    { action: "pin", variant: allPinned ? "unpin" : "pin" },
    { action: "snooze" },
    { action: "move", ...(accounts.size > 1 ? { off: "mailbox" as Off } : {}) },
    "-",
    { action: "archive" },
    { action: "delete", variant: ctx.view === "trash" ? "permanent" : "trash" },
    { action: "junk", ...(noJunk ? { off: "junk" as Off } : {}) },
    "-",
    { action: "copySender", ...(one ? {} : { off: "many" as Off }) },
    { action: "copySubject", ...(one ? {} : { off: "many" as Off }) },
  ];
}

/**
 * The folders "Move to" offers for a mailbox: the same rule as the ribbon's Move to menu - not the folder the mail is in (`scope`), not
 * Drafts / Sent, and no Junk where the mailbox has none.
 */
export function moveChoices<F extends FolderLike & { name: string }>(folders: readonly F[], accountId: string | undefined, scope: string | undefined): F[] {
  return folders.filter((f) => f.accountId === accountId && f.key !== scope && f.key !== "drafts" && f.key !== "sent" && folderVisible(folders, f.accountId, f.key));
}

/** The address "Copy sender address" copies: the latest message from someone else, else the latest message (a conversation you started yourself). null: nothing to copy. */
export function senderOf(messages: readonly { fromEmail: string }[], mine: ReadonlySet<string>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const e = messages[i].fromEmail;
    if (e && !mine.has(e.toLowerCase())) return e;
  }
  return messages[messages.length - 1]?.fromEmail || null;
}
