/**
 * Junk is the one standard folder the app never creates: "Mark as junk" on a mailbox whose server has no Junk folder only fails
 * ("Couldn't find the Junk folder"). So where the account's saved folder list (the `listed` flag of `list_folders`) names no Junk folder,
 * the Junk row is hidden and the actions that move mail to Junk ("Mark as junk", "Block sender", "Move to > Junk") are off, with a hint.
 * Archive and Trash stay: they are created on first use (F-14). A Junk folder the server gains later is named by the next sync, which
 * rewrites the saved list, and the row and the actions come back by themselves. Pure, so a script can test it (scripts/test-junk-folder.mjs).
 */

export interface FolderLike {
  accountId: string;
  key: string;
  /** the saved folder list names a server folder for this row (absent in older data: counts as named) */
  listed?: boolean;
}

/** Whether `accountId` has a Junk folder in its saved list. Unknown (the folders are not loaded yet for it) counts as yes: nothing is blocked on a guess. */
export function accountHasJunk(folders: readonly FolderLike[], accountId: string): boolean {
  const mine = folders.filter((f) => f.accountId === accountId);
  if (mine.length === 0) return true;
  return mine.some((f) => f.key === "junk" && f.listed !== false);
}

/** Whether a row of the folder pane / a folder choice is offered: every row but Junk always; Junk where the account (any account, for the all-mailboxes view) has one. */
export function folderVisible(folders: readonly FolderLike[], accountId: string | null, key: string): boolean {
  if (key !== "junk") return true;
  if (accountId !== null) return accountHasJunk(folders, accountId);
  const accounts = new Set(folders.map((f) => f.accountId));
  return accounts.size === 0 || [...accounts].some((a) => accountHasJunk(folders, a));
}

/** Whether mail of these accounts can be moved to Junk: every one of them has a Junk folder. */
export function canMoveToJunk(folders: readonly FolderLike[], accountIds: readonly string[]): boolean {
  return accountIds.every((a) => accountHasJunk(folders, a));
}

/** The accounts of these conversations (those not in the list are left out: nothing is decided on a guess). */
export function accountsOf(threads: readonly { threadId: string; accountId: string }[], ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const th = threads.find((x) => x.threadId === id);
    if (th) out.add(th.accountId);
  }
  return [...out];
}

/** Actions that move mail to Junk (`block` adds the sender to the blocked list and then moves the mail to Junk). */
export const JUNK_ACTIONS: ReadonlySet<string> = new Set(["junk", "block"]);
