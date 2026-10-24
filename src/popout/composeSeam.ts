// The few places where the Compose pane behaves differently in a window of its own. Compose.tsx asks `composeSeam()`: null in the main window
// (nothing changes there), the compose window's view (ComposeView.tsx) sets it for the life of its page. Everything else Compose does through
// the store, and the compose window gives it a store of its own (nothing is shared between web views).

export interface ComposeSeam {
  /**
   * The message is in its Undo time: `undo` takes it back. The window shows "Sending... n s" with an Undo button for it; the main window
   * shows a toast with Undo instead.
   */
  undoOffer(undo: () => void): void;
  /**
   * Send was pressed and the questions are answered: the window keeps the editor on screen, locked, and shows the Undo time as a toast of its own
   * (W13.1). `wait` = the Undo send time in seconds, 0 = none (the toast has no Undo and stays until the server answered).
   */
  lock(wait: number): void;
  /** The send was taken back (Undo) or failed: the same editor is unlocked in place. */
  unlock(): void;
  /** A save made a draft: the conversation it lives in (the lock of a draft follows it, so it cannot be open in two windows). */
  draftSaved(threadId: string): void;
  /** The message was scheduled (it is in the outbox, `outboxId`): the main window shows "Scheduled for ..." with Undo and View, this window ends. */
  scheduled(outboxId: string, sendAt: number): void;
  /**
   * The scheduled message this window holds paused (`outbox_open_for_edit`) is not this window's any more: it was rescheduled, sent now, deleted or moved
   * to Drafts. Whatever else ends the window releases the pause (the schedule stays), W2.10.
   */
  scheduledHandled(): void;
  /** The id under which this message writes its crash snapshot: the window tells the backend, which restores the message from it when the page process dies (W4.2). */
  recovery(id: string): void;
  /**
   * Move the message back to the main window (W4.5): `init` is the message as the window holds it (the same mapping as Pop out). Resolves to true when the main
   * window shows it in its inline Compose and this window has ended without a question, a toast or a save; false when it did not (the main window kept the message
   * it had, or did not answer): the window is as it was.
   */
  popIn(init: Record<string, unknown>): Promise<boolean>;
  /** The subject changed: it is the title of the window. */
  title(subject: string): void;
  /** Move the message being written to a window of its own; only the inline Compose has this (the window is the window already). */
  readonly inWindow: true;
}

let seam: ComposeSeam | null = null;

export const composeSeam = (): ComposeSeam | null => seam;

/** Returns the function that takes it away again (a page that is mounted twice in a row, React's strict mode, sets and clears it twice). */
export function setComposeSeam(s: ComposeSeam): () => void {
  seam = s;
  return () => {
    if (seam === s) seam = null;
  };
}
