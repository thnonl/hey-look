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

/** What `AdvanceTracker.mailBack` needs from the app (the store passes its own; a script passes fakes). */
export interface RestoreDeps {
  now: () => number;
  /** the conversation that is selected now */
  selected: () => string | null;
  /** the list shows this conversation as unread */
  isUnread: (id: string) => boolean;
  select: (id: string) => Promise<void>;
  markUnread: (id: string) => Promise<void>;
}

/** Most moves remembered (a move that went through leaves its record behind until it is pushed out). */
const KEEP = 50;

/**
 * The records of the moves in flight, and the ONE way back for every way a move can end badly: the folder check failed during the Undo
 * window, the server refused the MOVE after it, the move could not be queued, or the person pressed Undo. Each of them first makes the
 * mail reappear in the list (the caller's refresh), then calls `mailBack(token)`: within REVERT_WITHIN_MS of the advance and while the
 * person is still on the next mail, the selection goes back to the moved mail and the next mail goes back to unread (see above).
 * A failure that comes later than that leaves the selection where it is (the person is reading the next mail); the moved mail is back
 * in the list all the same, it only is not selected. A move that went through needs nothing.
 */
export class AdvanceTracker {
  private moves = new Map<string, Advance>();

  /** The app moved the selection after queueing the move `token`. */
  record(token: string, a: Advance) {
    this.moves.set(token, a);
    if (this.moves.size > KEEP) this.moves.delete(this.moves.keys().next().value as string);
  }

  /** The person did something to these conversations themselves (the app's own mark-as-read when it opens a mail is not that). */
  touch(ids: readonly string[]) {
    for (const [k, a] of this.moves) this.moves.set(k, touchAdvance(a, ids));
  }

  /** The move `token` did not stay done (any path above): put the selection and the next mail's unread state back if the rule allows. */
  async mailBack(token: string, deps: RestoreDeps): Promise<RestorePlan> {
    const a = this.moves.get(token);
    this.moves.delete(token);
    if (!a) return { reselect: null, markUnread: null };
    const plan = planRestore(a, deps.now(), deps.selected(), a.to !== null && deps.isUnread(a.to));
    if (plan.reselect) await deps.select(plan.reselect);
    if (plan.markUnread) await deps.markUnread(plan.markUnread);
    return plan;
  }
}
