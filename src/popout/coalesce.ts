// One gesture opens one window. A double click arrives as two clicks (and two synthetic clicks of a test tool as two as well), a key held down repeats:
// each of them asks the backend for the same window a few hundred milliseconds apart. The backend already answers "focus" for a key it has (a
// conversation, a draft, a reply), but not while that window is still being made, and not at all for a message without a key (New mail). So the
// page remembers what it asked a moment ago and gives the second ask the answer of the first. Imports nothing: scripts/test-popout.mjs runs it.

/** How long an identical ask counts as the same gesture. A second New mail the person really wants comes later than this. */
export const OPEN_COALESCE_MS = 700;

/** The identity of an ask: the kind of window and what it shows (`-` = nothing in particular: a new message). */
export function openId(kind: string, key: string | null | undefined): string {
  return `${kind}:${key ?? "-"}`;
}

export class Coalescer<T> {
  private seen = new Map<string, { at: number; value: T }>();

  private readonly windowMs: number;

  constructor(windowMs: number = OPEN_COALESCE_MS) {
    this.windowMs = windowMs;
  }

  /** The value of an identical ask made less than the window ago, else `make()` (remembered under `id`). */
  run(id: string, now: number, make: () => T): T {
    const prev = this.seen.get(id);
    if (prev && now - prev.at < this.windowMs) return prev.value;
    const value = make();
    this.seen.set(id, { at: now, value });
    // (the map stays small: only a handful of ids exist at the same time)
    if (this.seen.size > 32) for (const [k, v] of this.seen) if (now - v.at >= this.windowMs) this.seen.delete(k);
    return value;
  }

  /** The ask did not give a window (too many, an error): asking again at once is allowed. */
  forget(id: string): void {
    this.seen.delete(id);
  }
}
