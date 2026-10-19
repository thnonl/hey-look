// The unread numbers on the Focused / Other tabs of the Inbox (W13.12): pure helpers, no store and no DOM, so a node test can run them.
// The backend gives every Inbox row `unreadFocused` / `unreadOther` (`list_folders`, `inbox_unread` in lib.rs); the side menu and the tabs read
// the same `folders` state, so both change together.
import type { FolderInfo } from "./api.ts";

export interface TabCounts {
  focused: number;
  other: number;
}

type InboxRow = Pick<FolderInfo, "accountId" | "key" | "unread" | "unreadFocused" | "unreadOther">;

const num = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/** The tab numbers of the Inbox in view: one mailbox's row, or every mailbox's row added up (`accountId` null = Favorites > Inbox). A missing field is 0. */
export function tabCounts(folders: readonly InboxRow[], accountId: string | null): TabCounts {
  let focused = 0;
  let other = 0;
  for (const f of folders) {
    if (f.key !== "inbox" || (accountId !== null && f.accountId !== accountId)) continue;
    focused += num(f.unreadFocused);
    other += num(f.unreadOther);
  }
  return { focused, other };
}

/** The text of a number on a tab: nothing for 0, digits up to 99, then `99+` (the side menu's rule). Plain ASCII digits, no thousands separator. */
export function badgeText(n: number): string {
  const v = num(n);
  return v === 0 ? "" : v > 99 ? "99+" : String(v);
}

/**
 * The accessible name and the tooltip of a tab: only when it has unread conversations, both with the exact number (also above 99).
 * `name` is the tab's own name; `aria` and `tip` are the two translated messages (`mail.tabs.unreadAria`, `mail.side.unread`).
 */
export function tabLabels(
  n: number,
  name: string,
  aria: (params: { tab: string; n: number }) => string,
  tip: (params: { n: number }) => string,
): { label?: string; title?: string } {
  const v = num(n);
  return v === 0 ? {} : { label: aria({ tab: name, n: v }), title: tip({ n: v }) };
}

/**
 * One conversation turned read (delta -1) or unread (+1) in the Inbox: the Inbox row after the change. The tab number of its kind changes
 * (`bulk` = it has a List-Unsubscribe header: Other, else Focused); the side-menu number changes only when the conversation is counted there
 * (bulk mail only when `countsBulk`: "Count Other (bulk) mail" is on, or Focused Inbox is off). The refresh that follows confirms the numbers.
 */
export function withUnreadChange<T extends InboxRow>(row: T, bulk: boolean, delta: 1 | -1, countsBulk: boolean): T {
  const out = { ...row };
  if (bulk) out.unreadOther = Math.max(0, num(row.unreadOther) + delta);
  else out.unreadFocused = Math.max(0, num(row.unreadFocused) + delta);
  if (!bulk || countsBulk) out.unread = Math.max(0, row.unread + delta);
  return out;
}
