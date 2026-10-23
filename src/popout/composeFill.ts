// A Reply / Forward that opens in a window of its own (1.0.7 W13.13): the window is made at once with the shell (header rows, "Preparing reply…") and the main window hands it the finished message
// when the headers, pictures and quote are ready. The window may be ready before or after that, so the hand-over waits for both: the message (main window) and the window's "I am listening"
// (`cw-fill-ready`, composeRequests.ts). The message travels as the event `popout-reply` with the id `shell-fill` (popout_reply: main window to one window).
// Pure (the transport is injected): scripts/test-answer-shell.mjs runs it.

/** The id the hand-over travels under; the window ignores every other `popout-reply`. */
export const FILL_ID = "shell-fill";

interface Slot<T> {
  value?: T;
  listening: boolean;
}

export class FillHub<T> {
  private slots = new Map<string, Slot<T>>();
  private readonly send: (label: string, value: T) => void;

  constructor(send: (label: string, value: T) => void) {
    this.send = send;
  }

  /** The main window has the finished message for the window `label`. */
  deliver(label: string, value: T): void {
    const slot = this.slot(label);
    slot.value = value;
    this.flush(label, slot);
  }

  /** The window `label` listens for its message now. */
  listening(label: string): void {
    const slot = this.slot(label);
    slot.listening = true;
    this.flush(label, slot);
  }

  /** Waiting slots (a window that never asked, a message nobody took): for tests. */
  get size(): number {
    return this.slots.size;
  }

  private slot(label: string): Slot<T> {
    let s = this.slots.get(label);
    if (!s) {
      s = { listening: false };
      this.slots.set(label, s);
      // (a handful of windows exist at the same time; an old waiting slot of a window that is gone goes)
      if (this.slots.size > 32) for (const k of this.slots.keys()) if (k !== label) return (this.slots.delete(k), s);
    }
    return s;
  }

  private flush(label: string, slot: Slot<T>): void {
    if (slot.value === undefined || !slot.listening) return;
    this.slots.delete(label);
    this.send(label, slot.value);
  }
}
