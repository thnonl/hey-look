// 1.0.8: "Loading…" under a list with one flagged message that never went away. A list that shows only part of the downloaded mail (the Flagged / Unread filter, the
// Focused / Other tab, the Unread view) is short however much older mail is downloaded; its end stays in view, so every finished pass of `loadMore` (up to 4 requests
// of 50 messages) started the next one, and the footer said "Loading…" while the whole mailbox was downloaded behind a list that did not change. A pass that brought
// mail but no new line to the list is the sign that the rest of the mailbox is not going to fill it either: the passes stop (as after a failure) and the footer's
// button asks again on demand.

export interface PassResult {
  /** messages the pass stored (all its requests together) */
  added: number;
  /** every mailbox of the view is exhausted or capped: nothing is left to ask for */
  done: boolean;
  /** lines in the list when the pass began / after its last refresh */
  rowsBefore: number;
  rowsAfter: number;
}

/**
 * What the end of a pass means for scrolling: "end" (nothing left to ask, the footer says so), "more" (the list grew: if its end is in view it asks again) or
 * "stalled" (no new line came of it: scrolling stops asking, the button still can).
 */
export function passVerdict(p: PassResult): "end" | "more" | "stalled" {
  if (p.done) return "end";
  return p.added > 0 && p.rowsAfter > p.rowsBefore ? "more" : "stalled";
}

/**
 * Does the end of the list ask for older mail by itself? Not while the whole list fits in the window: its end is in view from the start, so every pass started the next and "Loading…"
 * stood under two rows for as long as real servers took (QA 1.0.8: the Unread view of six mailboxes, 40 s and more). The sync fetched the newest 50 messages of a folder, so a list
 * that fits is almost always all there is; there the footer is the "Load older messages" button and the person presses it when they want older mail. A list that shows part of the
 * downloaded mail (a filter, a tab, the Unread view) also waits until it was scrolled (oldest first: until it can scroll), because its end is near even when the whole mailbox is long.
 */
export function mayPageByItself(p: { partial: boolean; sortAsc: boolean; scrollTop: number; fits: boolean }): boolean {
  if (p.fits) return false;
  if (!p.partial) return true;
  return p.sortAsc || p.scrollTop > 0;
}

/** How long the list waits for one request for older mail: the backend gives up a silent server after 20 s (connect) + 60 s (reading), so this ends a request that never answers. */
export const LOAD_OLDER_DEADLINE_MS = 90_000;

/** The promise, or a rejection after `ms` ("Loading…" must end whatever the server does; an answer that comes later is dropped). */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("the request timed out")), ms);
    p.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}
