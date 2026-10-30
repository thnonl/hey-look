// Mail that was just moved shows in the folder it went to at once (1.0.11). The move itself is queued: it waits out the Undo time, then the server moves the message, then the local
// rows of the source folder go, and the copy in the target folder reaches this computer with the next sync of that folder (src-tauri `sync_after_move`, 1.5 s after the move and
// again while it is missing). So for the Undo time + the server round trip + the sync the mail was in no folder that could be opened. A "ghost" is the conversation as it left the
// source list, kept here for the target folder: the list of the target folder shows it (`mergeMoved`) and its numbers count it (`withMovedCounts`) until the real rows are there.
// No store and no DOM here, so a node test can run it (scripts/test-moved-in.mjs).
import type { FolderInfo, ThreadSummary } from "./api.ts";
import { withUnreadChange } from "./focusCounts.ts";

/** How long a ghost waits for its move after the Undo time (a slow server, a folder that has to be made) before it is given up. */
export const QUEUED_GRACE_MS = 120_000;
/** How long a ghost stays after the move is done, if the sync rounds never say that the copy arrived (they stop after about 100 s). */
export const COMMITTED_MS = 150_000;

/** The folder key a queued action puts mail into; null when the mail leaves for good (delete forever) or the action is not a move. */
export function destOf(action: string, arg?: string | null): string | null {
  switch (action) {
    case "archive":
    case "trash":
    case "junk":
    case "inbox":
      return action;
    case "block":
      return "junk";
    case "move":
      return arg || null;
    default:
      return null;
  }
}

export interface Ghost {
  /** the token of the queued move (`queue_action`) */
  token: string;
  /** the folder key the conversation goes to, in its own mailbox */
  dest: string;
  /** the conversation as the source list showed it, with `folder` = `dest` */
  thread: ThreadSummary;
  /** after this time (ms since epoch) the ghost is given up if nothing ended it */
  until: number;
  /** the server move is done (the Undo time is over): the numbers of the backend do not have the copy yet */
  committed: boolean;
}

/** What the open list is: the ghosts of the folder it shows are added to it. */
export interface MovedView {
  folder: string;
  /** one mailbox, or null for all */
  accountId: string | null;
  /** the Inbox tab: "focused" (no List-Unsubscribe header) or "other" (with one); null when the Inbox is not split or the folder is another */
  tab: "focused" | "other" | null;
  unreadOnly: boolean;
  flaggedOnly: boolean;
  /** a search is not a folder: no ghost */
  searching: boolean;
}

export class MovedIn {
  private items: Ghost[] = [];

  /** The conversations that left the source list for `dest`; `undoSecs` is the Undo time the move waits. */
  add(token: string, dest: string, threads: readonly ThreadSummary[], now: number, undoSecs: number): Ghost[] {
    const added = threads.map((t): Ghost => ({ token, dest, thread: { ...t, folder: dest }, until: now + undoSecs * 1000 + QUEUED_GRACE_MS, committed: false }));
    // (a conversation moved again before the first move was seen to land: the newest move owns it)
    this.items = this.items.filter((g) => !added.some((a) => a.thread.accountId === g.thread.accountId && a.thread.threadId === g.thread.threadId)).concat(added);
    return added;
  }

  /** Undo, a refused move or a dropped one: the mail stays where it was. Returns whether the token had ghosts. */
  drop(token: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((g) => g.token !== token);
    return this.items.length !== n;
  }

  /** The backend finished the moves of these conversations (`moves-committed`). */
  commit(threadIds: readonly string[], now: number): void {
    const ids = new Set(threadIds);
    for (const g of this.items) {
      if (!g.committed && ids.has(g.thread.threadId)) {
        g.committed = true;
        g.until = now + COMMITTED_MS;
      }
    }
  }

  /** The copies of the moved mail of this mailbox reached it (`moves-settled`): the committed ghosts of it are not needed any more. Returns whether any went. */
  settle(accountId: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((g) => !(g.committed && g.thread.accountId === accountId));
    return this.items.length !== n;
  }

  /** The list of a folder has these conversations: they are really there, their ghosts go. */
  landed(accountId: string | null, dest: string, threadIds: ReadonlySet<string>): void {
    this.items = this.items.filter((g) => !(g.dest === dest && (accountId === null || g.thread.accountId === accountId) && threadIds.has(g.thread.threadId)));
  }

  /** Ghosts that were given up. */
  expire(now: number): void {
    this.items = this.items.filter((g) => g.until > now);
  }

  /** Is this conversation a ghost of `dest` (the folder in view)? Used so that "the move is done" does not take the row out of the list it was just put in. */
  has(threadId: string, dest: string): boolean {
    return this.items.some((g) => g.dest === dest && g.thread.threadId === threadId);
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly Ghost[] {
    return this.items;
  }

  /** The ghosts the open list shows. */
  forView(v: MovedView): ThreadSummary[] {
    if (v.searching) return [];
    return this.items
      .filter((g) => g.dest === v.folder && (v.accountId === null || g.thread.accountId === v.accountId))
      .map((g) => g.thread)
      .filter((t) => (!v.unreadOnly || t.unread > 0) && (!v.flaggedOnly || t.flagged) && (v.tab === null || (v.tab === "other") === !!t.bulk));
  }
}

/**
 * The list of the target folder with its ghosts put in: each at the place its date has (the order of the list is kept; the Inbox keeps its pinned rows on top).
 * A conversation that is in the list already is not added twice.
 */
export function mergeMoved(list: readonly ThreadSummary[], ghosts: readonly ThreadSummary[], sortAsc: boolean, pinnedFirst: boolean): ThreadSummary[] {
  const out = [...list];
  const have = new Set(out.map((t) => t.threadId + "|" + t.accountId));
  for (const g of [...ghosts].sort((a, b) => (sortAsc ? a.lastDate - b.lastDate : b.lastDate - a.lastDate))) {
    if (have.has(g.threadId + "|" + g.accountId)) continue;
    have.add(g.threadId + "|" + g.accountId);
    let i = pinnedFirst && !g.pinned ? out.findIndex((t) => !t.pinned) : 0;
    if (i < 0) i = out.length;
    while (i < out.length && (sortAsc ? out[i].lastDate <= g.lastDate : out[i].lastDate >= g.lastDate)) i++;
    out.splice(i, 0, g);
  }
  return out;
}

/**
 * The folder rows with the ghosts counted: a conversation more in the target folder and, when it has unread mail, one more unread (the Inbox: the tab number of its kind and,
 * when counted there, the side-menu number). `countsBulk` as in `withThreadsGone`. Returns the same rows (not copies) that did not change.
 */
export function withMovedCounts<T extends Pick<FolderInfo, "accountId" | "key" | "unread" | "total" | "unreadFocused" | "unreadOther">>(
  folders: readonly T[],
  ghosts: readonly Pick<Ghost, "dest" | "thread">[],
  countsBulk: boolean,
): T[] {
  const out = [...folders];
  for (const { dest, thread: t } of ghosts) {
    const i = out.findIndex((f) => f.accountId === t.accountId && f.key === dest);
    if (i < 0) continue;
    const row = { ...out[i], total: out[i].total + 1 };
    out[i] = t.unread > 0 ? (dest === "inbox" ? withUnreadChange(row, !!t.bulk, 1, countsBulk) : { ...row, unread: row.unread + 1 }) : row;
  }
  return out;
}
