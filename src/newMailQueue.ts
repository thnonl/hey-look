// New mail never ends silently (W1.3, 1.0.7). A request to write a new message (the ribbon, the key `c`, the command bar, the tray / menu bar icon menu) that comes
// while the app cannot open one yet - the mailboxes are not read yet, which is the first second or so of a start - is kept and served as soon as the app can.
// Pure (the clock, the timer and everything the app does come in through `NewMailIO`), so scripts/test-new-mail-queue.mjs runs it with a fake clock.
//
//   - one kept request at most: more presses while it waits add nothing;
//   - the mailboxes are read and there is one at least: it is served once, at once;
//   - the mailboxes are read and there is none: it is dropped without a word (the Welcome screen is the answer);
//   - 30 s after the first press it is still not served: the waiting message is replaced by "Couldn't open a new message" with Retry, and the request is dropped.

/** What the app can do with a request now: `wait` = it cannot yet (the mailboxes are not read), `ready` = it can, `none` = it never can (no mailbox). */
export type Readiness = "wait" | "ready" | "none";

/** What the person is told: a spinner message while the request waits, an error after 30 s, nothing otherwise. */
export type Say = "waiting" | "failed" | null;

export interface NewMailIO<O> {
  ready(): Readiness;
  /** open the message (the options are the ones of the press that made the request) */
  serve(o: O): void;
  say(s: Say): void;
  now(): number;
  /** runs `f` once after `ms`; returns the function that cancels it */
  later(ms: number, f: () => void): () => void;
}

/** How long a kept request waits before it is given up. */
export const NEW_MAIL_WAIT_MS = 30_000;

export class NewMailQueue<O> {
  private pending: { o: O; since: number; stop: () => void } | null = null;
  /** the options of the last request: Retry makes the same one again */
  private last: O | null = null;

  private readonly io: NewMailIO<O>;

  constructor(io: NewMailIO<O>) {
    this.io = io;
  }

  /** A request is kept (waiting for the mailboxes). */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** The options for Retry: those of the last request. */
  retryOptions(): O | null {
    return this.last;
  }

  request(o: O): void {
    this.last = o;
    if (this.pending) {
      // a press while one is kept adds nothing; if the app can open it by now, the kept one is served (not a second)
      this.check();
      return;
    }
    const r = this.io.ready();
    if (r === "ready") {
      this.io.say(null); // (an error message of an earlier request goes)
      this.io.serve(o);
    } else if (r === "none") {
      this.io.say(null);
    } else {
      this.pending = { o, since: this.io.now(), stop: this.io.later(NEW_MAIL_WAIT_MS, () => this.timeout()) };
      this.io.say("waiting");
    }
  }

  /** Whatever the app can do may have changed (the mailboxes were read): serves or drops a kept request. */
  check(): void {
    const p = this.pending;
    if (!p) return;
    const r = this.io.ready();
    if (r === "wait") return;
    this.finish();
    if (r === "ready") this.io.serve(p.o);
  }

  private timeout(): void {
    const p = this.pending;
    if (!p) return;
    const r = this.io.ready();
    if (r !== "wait") return this.check(); // (it can be served after all)
    p.stop();
    this.pending = null;
    this.io.say("failed");
  }

  private finish(): void {
    const p = this.pending;
    if (!p) return;
    p.stop();
    this.pending = null;
    this.io.say(null);
  }
}
