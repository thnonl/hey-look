/**
 * "After archive / delete: open the next mail" (the After-action setting). The app moves the selection to the next conversation, and that
 * conversation is marked read as it opens. When the move is then refused by the server (the backend drops it during the Undo window) or
 * the person presses Undo, the mail comes back, but the selection had already moved on and the next mail had been marked read by the app,
 * not by the person. This keeps what is needed to put both back (pure, so a script can test it: scripts/test-auto-advance.mjs).
 *
 * The rule, kept simple: while the person is still on the mail the app advanced to, and no more than REVERT_WITHIN_MS have passed since
 * the app opened it, the person has not read it yet. Then
 *  - the selection goes back to the mail that was moved (it is back in the list), and
 *  - the mail the app advanced to goes back to unread when it was unread before the app opened it and the person did not set its read /
 *    unread state, flag it, move it ... themselves meanwhile (`touched`).
 * Past the time, or once the person selected something else, nothing is touched: they are reading, or have moved on.
 */

/** After this long on the next mail the person is taken to have read it: neither the selection nor its unread state is put back. */
export const REVERT_WITHIN_MS = 10_000;

export interface Advance {
  /** the mail the person moved away (selected when they pressed Archive / Delete) */
  from: string;
  /** where the app moved the selection: the next mail, or null (After-action "list", or nothing left) */
  to: string | null;
  /** the next mail was unread before the app opened it (so its opening, not the person, made it read) */
  wasUnread: boolean;
  /** when the app moved the selection */
  at: number;
  /** the person did something to `to` themselves (marked it, flagged it, moved it ...) */
  touched: boolean;
}

export interface RestorePlan {
  /** select this conversation again (the mail that was moved) */
  reselect: string | null;
  /** set this conversation unread again */
  markUnread: string | null;
}

/** The selection after the move: the mail that was selected moves away, `pick` is the next one (if any). */
export function startAdvance(from: string, to: string | null, nextUnread: boolean, now: number): Advance {
  return { from, to, wasUnread: to !== null && nextUnread, at: now, touched: false };
}

/** The person did something to these conversations (not the app's own mark-as-read on opening): the unread state is theirs now. */
export function touchAdvance(a: Advance, ids: readonly string[]): Advance {
  return a.to !== null && !a.touched && ids.includes(a.to) ? { ...a, touched: true } : a;
}

/**
 * What to put back when the mail came back (move refused, or Undo). `selected`: the current selection; `nextIsUnread`: whether the list
 * shows the next mail as unread now (it is not set unread again when it is).
 */
export function planRestore(a: Advance, now: number, selected: string | null, nextIsUnread: boolean): RestorePlan {
  const none: RestorePlan = { reselect: null, markUnread: null };
  if (selected !== a.to) return none; // the person went elsewhere: leave everything
  if (now - a.at > REVERT_WITHIN_MS) return none; // they have been on it long enough to have read it
  return { reselect: a.from, markUnread: a.to !== null && a.wasUnread && !a.touched && !nextIsUnread ? a.to : null };
}
