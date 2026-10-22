// A click on the notification of a new message opens that message wherever it is (1.0.7 D-051). The notification of a bulk message is in the Other tab of
// the Inbox, of another mailbox in that mailbox, of a snoozed one in Snoozed; the list the person was looking at is none of them, and a conversation the open
// list does not have cannot be shown. This is the decision only (pure, so scripts/test-notify-open.mjs runs it as it is); the store does it (`openNotified`).

/** What the backend says about where a conversation lives (`locate_thread`). */
export interface ThreadHome {
  accountId: string;
  /** "inbox", "snoozed" or the folder key of its newest message */
  folder: string;
  /** in the Inbox: the Focused list has a message of it / the Other list has one (both when it has both kinds) */
  focused: boolean;
  other: boolean;
}

/** The list the person is in. */
export interface ViewState {
  folder: string;
  accountId: string | null;
  search: string;
  filter: "all" | "unread" | "flagged";
  focus: "focused" | "other";
  /** Settings > Focused Inbox: with it off the Inbox has no tabs */
  focusedInbox: boolean;
}

export interface OpenPlan {
  /** the folder / mailbox to switch to; null = the open one is right (a unified Inbox shows every mailbox) */
  view: { folder: string; accountId: string } | null;
  /** the Inbox tab that has it; null = no tabs (Focused Inbox off, or not the Inbox) */
  focus: "focused" | "other" | null;
  /** a filter (Unread, Flagged) is on: it may be what hides the conversation, so it is cleared when the list still lacks it */
  clearFilter: boolean;
}

/** Where to go to show the conversation `home`, given the open view. The tab the person is in stays when it has the conversation. */
export function planOpen(home: ThreadHome, v: ViewState): OpenPlan {
  const same = v.folder === home.folder && (v.accountId === null || v.accountId === home.accountId) && !v.search.trim();
  const tabbed = home.folder === "inbox" && v.focusedInbox;
  const focus = !tabbed ? null : v.focus === "other" ? (home.other ? "other" : "focused") : home.focused ? "focused" : "other";
  return { view: same ? null : { folder: home.folder, accountId: home.accountId }, focus, clearFilter: v.filter !== "all" };
}
