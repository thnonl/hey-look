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

/** What is wrong with a rule's target on this computer's folder lists (W6.2, 1.0.8): `no-junk` (it moves mail to Junk and there is no Junk folder), `no-folder` (its folder is not in the list of its mailbox); null: nothing. */
export type RuleProblem = "no-junk" | "no-folder";

/** Whether the saved folder list of `accountId` has the folder `key`. Unknown (the folders are not loaded yet for it) counts as yes. */
export function accountHasFolder(folders: readonly FolderLike[], accountId: string, key: string): boolean {
  const mine = folders.filter((f) => f.accountId === accountId);
  return mine.length === 0 || mine.some((f) => f.key === key && f.listed !== false);
}

/**
 * Whether a rule can work with the folders its mailbox has. A rule that moves mail to Junk needs a Junk folder in the saved list of its mailbox; a rule that moves to a folder needs
 * that folder; a rule for all mailboxes works wherever there is one, so it has the problem only when NO mailbox has it. Unknown folders (not loaded yet) are fine: nothing is blocked on a
 * guess. The rule list and the rule dialog (settings) use it; the backend skips a Junk rule the same way when it runs (`sync_impl`), so the mail stays where it is and no error is told.
 */
export function ruleTargetProblem(rule: { action: string; arg?: string | null; accountId?: string | null }, folders: readonly FolderLike[], accountIds: readonly string[]): RuleProblem | null {
  const dest = rule.action === "junk" ? "junk" : rule.action === "move" && rule.arg ? rule.arg : null;
  if (!dest) return null;
  const has = (a: string) => (dest === "junk" ? accountHasJunk(folders, a) : accountHasFolder(folders, a, dest));
  const problem: RuleProblem = dest === "junk" ? "no-junk" : "no-folder";
  if (rule.accountId) return has(rule.accountId) ? null : problem;
  return accountIds.length > 0 && accountIds.every((a) => !has(a)) ? problem : null;
}

/** Actions that move mail to Junk (`block` adds the sender to the blocked list and then moves the mail to Junk). */
export const JUNK_ACTIONS: ReadonlySet<string> = new Set(["junk", "block"]);
