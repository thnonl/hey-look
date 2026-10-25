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
