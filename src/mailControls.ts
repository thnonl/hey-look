// With no account the app shows only the Welcome screen: nothing that reads, searches, syncs or writes mail is on screen,
// and none of its shortcuts or commands works. This file is the single place that says which is which.
// It imports nothing, so a plain Node script can test it (scripts/test-mail-controls.mjs).

/** Mail controls (search box, sync button, ribbon, folders, list, Compose) are shown only while at least one account exists. */
export const hasMailAccounts = (accountCount: number): boolean => accountCount > 0;

/** The command-bar entries of the zero-account state, in this order: Add account, Settings (with the About / update block) and the theme. */
export const NO_ACCOUNT_COMMANDS: readonly string[] = ["Add account", "Open settings", "Check for updates", "Theme: light", "Theme: dark", "Theme: system"];

/** The command-bar list for this account count: today's list (without `Add account`) with an account, exactly the 6 entries without one. */
export function commandsFor<T extends { label: string }>(accountCount: number, all: readonly T[]): T[] {
  if (hasMailAccounts(accountCount)) return all.filter((c) => c.label !== "Add account");
  return NO_ACCOUNT_COMMANDS.flatMap((l) => all.filter((c) => c.label === l));
}

export type Shortcut =
  | "command-bar" // Ctrl/Cmd+K (opens a list; without an account it holds only the non-mail commands)
  | "fullscreen" // F11: a window control
  | "sync" // F5
  | "mail-keys"; // everything else: /, c, j, k, e, #, r, a, f, Ctrl+A, Ctrl+Shift+S, Ctrl+1 / 2 ...

/** Whether a shortcut works for this account count. */
export function shortcutWorks(accountCount: number, s: Shortcut): boolean {
  if (s === "fullscreen" || s === "command-bar") return true;
  return hasMailAccounts(accountCount);
}
