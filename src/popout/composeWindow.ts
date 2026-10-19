// The life of a compose window, as pure functions (no Tauri, no store, no React), so scripts/test-popout.mjs can run every path:
// - `step`: the phases of the window around a send (editing -> counting down the Undo time -> sending -> over) and what the window does
//   about them (hide itself, show itself again, end itself). The window shows the editor in every phase: in "count" and "work" it is locked
//   and a toast "Sending... n s" with Undo (a toast "Sending..." in "work") says so (W13.1); when the person closes it then, it goes out of
//   sight and keeps running ("parked") until the message has gone, so the message still goes out at the end of the Undo time and a failure
//   can bring the editor back, unlocked, where it was;
// - `closeAction` / `runClose`: what the title bar's close button, Ctrl+W and Cmd+W do (Save / Discard / Cancel, REQ-C11);
// - `composeFlush`: what the window answers when the app quits or restarts for an update (REQ-C12).
// ComposeView.tsx wires them to the real pieces.

export type Phase = "edit" | "count" | "work" | "over";

export interface WinState {
  phase: Phase;
  /** out of sight but alive: its message is still in the Undo time or on its way */
  parked: boolean;
  /** sends that are running in this window */
  sends: number;
  /** when the person pressed Undo (ms): the cancel is on its way, so the window must not end yet */
  undoAt: number | null;
  /** when the Undo time ends (ms), while it runs */
  endsAt: number | null;
  /** Compose has handed over the function that takes the message back: the Undo button works */
  canUndo: boolean;
  /** an end is waiting for its grace time: a send that failed brings the editor back within it */
  ending: boolean;
}

export const START: WinState = { phase: "edit", parked: false, sends: 0, undoAt: null, endsAt: null, canUndo: false, ending: false };

/** After a send ends, the window waits this long before it ends: a failure brings the editor back right after (the schedule path ends the send first). */
export const GRACE_MS = 400;
/** After Undo is pressed, a send that ends in this time does not end the window: the cancel may still bring the editor back. */
export const UNDO_SETTLE_MS = 3000;

export type Ev =
  /**
   * Compose handed the message to the send ("sending": the Undo time in seconds, 0 for none or for a scheduled message). `lock`: the editor stays on
   * screen, locked, while the window waits (W13.1: a send); without it the editor is gone and the window goes out of sight (a scheduled message,
   * "Send now" of one: the window only waits for the work to end).
   */
  | { t: "handoff"; wait: number; now: number; lock?: boolean }
  | { t: "undo-offer" }
  | { t: "undo-start"; now: number }
  | { t: "tick"; now: number }
  /** Compose is open again in this window (Undo, a send that failed) */
  | { t: "reopen" }
  /** the message is over without a send (saved, discarded) */
  | { t: "end" }
  | { t: "sends"; n: number; now: number }
  | { t: "grace"; now: number }
  /** the person closes the window while it is not editing */
  | { t: "close" };

export type Fx = "park" | "show" | "destroy" | "grace";

export function step(s: WinState, e: Ev): { s: WinState; fx: Fx[] } {
  switch (e.t) {
    case "handoff": {
      const counting = e.wait > 0;
      // a send keeps the editor on screen, locked (W13.1), with or without an Undo time: nothing is hidden, the window ends when the server has answered.
      // Without the editor (a scheduled message): no Undo time = the window closes at once; it stays alive, hidden, until the work is over
      const hide = !counting && !e.lock;
      return {
        s: { ...s, phase: counting ? "count" : "work", endsAt: counting ? e.now + e.wait * 1000 : null, canUndo: false, undoAt: null, ending: false, parked: hide },
        fx: hide ? ["park"] : [],
      };
    }
    case "undo-offer":
      return { s: s.phase === "count" ? { ...s, canUndo: true } : s, fx: [] };
    case "undo-start":
      return { s: { ...s, undoAt: e.now }, fx: [] };
    case "tick":
      if (s.phase === "count" && s.endsAt !== null && e.now >= s.endsAt) return { s: { ...s, phase: "work", endsAt: null, canUndo: false }, fx: [] };
      return { s, fx: [] };
    case "reopen":
      return { s: { ...s, phase: "edit", endsAt: null, canUndo: false, undoAt: null, ending: false, parked: false }, fx: s.parked ? ["show"] : [] };
    case "end":
      return { s: { ...s, phase: "over", endsAt: null, canUndo: false, ending: false }, fx: ["destroy"] };
    case "sends": {
      const was = s.sends;
      const next = { ...s, sends: e.n };
      // the last running send ended while the window shows no editor: the window ends too (after the grace time, in case the editor comes back)
      if (was > 0 && e.n === 0 && (s.phase === "count" || s.phase === "work")) return { s: { ...next, ending: true }, fx: ["grace"] };
      return { s: next, fx: [] };
    }
    case "grace": {
      if (!s.ending) return { s, fx: [] };
      if (s.phase !== "count" && s.phase !== "work") return { s: { ...s, ending: false }, fx: [] };
      if (s.sends > 0) return { s: { ...s, ending: false }, fx: [] }; // another send started meanwhile
      if (s.undoAt !== null && e.now - s.undoAt < UNDO_SETTLE_MS) return { s, fx: ["grace"] }; // Undo is being cancelled: wait for the editor
      return { s: { ...s, phase: "over", ending: false, endsAt: null, canUndo: false }, fx: ["destroy"] };
    }
    case "close":
      if (s.phase === "over") return { s, fx: ["destroy"] };
      if (s.phase === "edit" || s.parked) return { s, fx: [] };
      return { s: { ...s, parked: true }, fx: ["park"] };
  }
}

/** Seconds left of the Undo time, as the card shows them (never below 1 while it runs). */
export function secondsLeft(endsAt: number | null, now: number): number {
  if (endsAt === null) return 0;
  return Math.max(1, Math.ceil((endsAt - now) / 1000));
}

// ---------------------------------------------------------------- closing the window (REQ-C11)

export interface CloseFacts {
  phase: Phase;
  /** the person changed something since it was opened or last saved */
  dirty: boolean;
  /** something worth a draft: text, a subject, a picture, a file or a meeting place of the person's (Compose's probe `draftContent`, W13.5; recipients alone are not) */
  hasContent: boolean;
  /** a file or picture is still being read into the message */
  attaching: boolean;
  /** the window edits a scheduled message (it is paused while it is open): it is not a draft, so it is never saved by the close */
  scheduled?: boolean;
}

export type CloseAction = "end" | "park" | "ask" | "ask-scheduled" | "attaching";

/**
 * - counting or sending: out of sight, the message goes on its way (REQ-C8);
 * - nothing changed, or nothing worth a draft (typed and deleted again, or only recipients, W13.5): closes without a question and without a draft;
 * - files still coming in: stays, the person is told;
 * - changed, with content: Save / Discard / Cancel;
 * - a scheduled message: nothing changed closes (the pause is released, the schedule stays); changed asks "Keep editing / Discard" like the pane does when it
 *   is left (compose.leave.scheduledTitle): a scheduled message is not a draft, and no content check applies (W2.10).
 */
export function closeAction(f: CloseFacts): CloseAction {
  if (f.phase === "count" || f.phase === "work") return "park";
  if (f.phase === "over") return "end";
  if (f.attaching) return "attaching";
  if (f.scheduled) return f.dirty ? "ask-scheduled" : "end";
  if (!f.dirty || !f.hasContent) return "end";
  return "ask";
}

export type CloseAnswer = "cancel" | "save" | "discard";

export interface CloseDeps {
  facts(): CloseFacts;
  /** Save / Discard / Cancel */
  ask(): Promise<CloseAnswer>;
  /** a scheduled message with unsaved changes: keep editing, or close and leave the schedule as it was */
  askScheduled?(): Promise<"keep" | "discard">;
  /** save to Drafts without a message of its own; false = it failed */
  save(): Promise<boolean>;
  /** "Your message isn't saved": keep writing, or close and discard */
  askFailed(): Promise<"keep" | "discard">;
  /** drop the snapshot (and the draft an autosave made of a new message; an opened draft is put back as it was opened). false: that failed, the window stays */
  discard(): Promise<boolean | void>;
  /** everything typed was deleted again (W2.3), or only recipients were typed (W13.5): drop the snapshot and the copy an autosave made of a new message, then the window ends */
  emptied?(): Promise<void>;
  park(): void;
  end(): void;
  attaching(): void;
  /** the draft was saved by the close: tell the main window ("Draft saved") */
  savedDraft(): void;
}

export type CloseOutcome = "ended" | "parked" | "attaching" | "cancelled" | "saved" | "discarded" | "kept";

export async function runClose(d: CloseDeps): Promise<CloseOutcome> {
  switch (closeAction(d.facts())) {
    case "park":
      d.park();
      return "parked";
    case "end": {
      const f = d.facts();
      if (f.phase === "edit" && f.dirty && !f.hasContent && !f.attaching) await d.emptied?.();
      d.end();
      return "ended";
    }
    case "attaching":
      d.attaching();
      return "attaching";
    case "ask-scheduled":
      if ((await d.askScheduled?.()) !== "discard") return "cancelled";
      d.end(); // (the window releases the pause as it ends; the changes are dropped, the schedule is what it was)
      return "discarded";
    case "ask":
      break;
  }
  const answer = await d.ask();
  if (answer === "cancel") return "cancelled";
  if (answer === "discard") {
    if ((await d.discard()) === false) return "kept"; // (an opened draft could not be put back: the window stays, Compose said why)
    d.end();
    return "discarded";
  }
  if (await d.save()) {
    d.savedDraft();
    d.end();
    return "saved";
  }
  if ((await d.askFailed()) === "keep") return "kept";
  if ((await d.discard()) === false) return "kept";
  d.end();
  return "discarded";
}

// ---------------------------------------------------------------- quit and update restart (REQ-C12)

export type FlushWhy = "quit" | "update";

export interface FlushDeps {
  phase(): Phase;
  dirty(): boolean;
  /** something worth a draft (see CloseFacts.hasContent) */
  hasContent(): boolean;
  /** the window edits a scheduled message: nothing is saved, its pause is released and the schedule stays (W2.10) */
  scheduled?(): boolean;
  release?(): Promise<void>;
  /** a changed message with nothing worth a draft: no draft, no question; the snapshot and the copy an autosave made of a new message go (W13.5) */
  emptied?(): Promise<void>;
  /** save to Drafts without a message of its own */
  save(): Promise<boolean>;
  /** "Your message isn't saved": keep writing, or quit (restart) and discard */
  ask(why: FlushWhy): Promise<"keep" | "discard">;
  showWindow(): void;
  dialog(open: boolean): void;
  /** the person chose to discard: the snapshot must not come back at the next start either */
  discarded(): Promise<void>;
  /** let a message in its Undo time go out now and wait for the sends under way */
  flushSends(): Promise<unknown>;
}

/**
 * What a compose window answers when the app is about to end. An editor with changes is saved to Drafts (quietly); when that fails the
 * window comes to the front and asks, and "keep writing" (false) cancels the whole quit. A window that shows the countdown, or that was
 * parked while its message goes out, sends now and waits for the server. Never sends a message that is still being written.
 */
export async function composeFlush(d: FlushDeps, why: FlushWhy): Promise<boolean> {
  const phase = d.phase();
  if (phase === "count" || phase === "work") {
    await d.flushSends();
    return true;
  }
  if (phase === "edit" && d.scheduled?.()) {
    await d.release?.(); // (changes are not saved: a scheduled message is not a draft; it goes out at its time)
    return true;
  }
  if (phase === "edit" && d.dirty() && !d.hasContent()) await d.emptied?.();
  if (phase === "edit" && d.dirty() && d.hasContent()) {
    if (await d.save()) return true;
    d.showWindow();
    d.dialog(true);
    let answer: "keep" | "discard" = "keep";
    try {
      answer = await d.ask(why);
    } finally {
      d.dialog(false);
    }
    if (answer === "keep") return false;
    await d.discarded();
  }
  return true;
}
