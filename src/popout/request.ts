// A secondary window asks the main page for something the main page owns (REQ-S4, spec 3.3): mail state with its intent layer and Undo,
// the preferences, a dialog of the main window, a compose window. The request travels through the backend (`popout_request`, which stamps
// the window's label and sends it to `main` only); the main page answers with the event `popout-reply`. No answer within 5 s is a failure:
// the main page may be reloading (spec 5.5).
// Pure (the transport is injected), so scripts/test-popout.mjs runs it.

export interface Reply {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string | null;
}

const REQUEST_TIMEOUT_MS = 5000;
/** The error a request ends with when the main page did not answer in time. */
export const UNREACHABLE = "POPOUT_UNREACHABLE";

export interface RequesterDeps {
  /** hand the request to the backend; rejects when it refuses (not a live secondary window ...) */
  send(id: string, kind: string, payload: unknown): Promise<void>;
  timeoutMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Waiting {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

export class Requester {
  private seq = 0;
  private waiting = new Map<string, Waiting>();
  private deps: RequesterDeps;
  private prefix: string;

  constructor(deps: RequesterDeps, prefix = "r") {
    this.deps = deps;
    this.prefix = prefix;
  }

  /** Requests under way. */
  get pending(): number {
    return this.waiting.size;
  }

  ask<T = unknown>(kind: string, payload: unknown, timeoutMs?: number): Promise<T> {
    const id = `${this.prefix}${++this.seq}`;
    const setTimer = this.deps.setTimer ?? ((f, ms) => setTimeout(f, ms));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimer(() => {
        if (this.waiting.delete(id)) reject(new Error(UNREACHABLE));
      }, timeoutMs ?? this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
      this.waiting.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.deps.send(id, kind, payload).catch((e) => this.fail(id, e));
    });
  }

  /** The `popout-reply` event arrived. An answer nobody waits for (it came late) is dropped. */
  answer(r: Reply): void {
    const w = this.waiting.get(r.id);
    if (!w) return;
    this.settle(r.id, w);
    if (r.ok) w.resolve(r.data);
    else w.reject(new Error(r.error || "request failed"));
  }

  private fail(id: string, e: unknown) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.settle(id, w);
    w.reject(e instanceof Error ? e : new Error(String(e)));
  }

  private settle(id: string, w: Waiting) {
    (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(w.timer);
    this.waiting.delete(id);
  }
}
