/**
 * F-12: the conversation that is open in the reading pane must stay open when reading it takes it out of the list. Under the
 * Unread filter (or the Unread / Starred view) marking the open mail as read - the "mark as read" delay, the ribbon button, another
 * device - makes the next list read leave it out; the pane looks its conversation up in that list and fell back to "Select an item
 * to read". The open conversation is therefore put back at the place it had, until the person leaves it (see `select`).
 */
import type { ThreadSummary } from "./api";

/**
 * The list to show after a re-read: `fresh` (what the server answered), plus the open conversation when `fresh` left it out.
 * Only when the re-read is of the very same view (`sameView`: same folder, mailbox, search, filter, ...) - a changed filter or folder
 * is the person leaving it, and must not hold anything back. `kept` tells the caller which row was held so it can drop it again.
 */
export function holdOpenThread(
  fresh: ThreadSummary[],
  shown: ThreadSummary[],
  openId: string | null,
  sameView: boolean,
): { threads: ThreadSummary[]; kept: string | null } {
  if (!openId || !sameView || fresh.some((t) => t.threadId === openId)) return { threads: fresh, kept: null };
  const at = shown.findIndex((t) => t.threadId === openId);
  if (at < 0) return { threads: fresh, kept: null };
  const threads = [...fresh];
  threads.splice(Math.min(at, threads.length), 0, shown[at]);
  return { threads, kept: openId };
}
