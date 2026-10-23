// The shell of a Reply / Reply all / Forward (1.0.7 W13.13, D-064): the compose opens at once with what is known and says "Preparing reply…" until the headers, the pictures and the quote
// are ready (actions.ts `openAnswer`). This is the small shared part, kept out of Compose.tsx and App.tsx (the editor stack is loaded lazily later, WP9d):
// when the status of a shell was shown (RULE-2: once shown it stays at least 300 ms, so the fill waits for the rest of it) and a paint to wait for (RULE-4: paint first, then work).

/** How long a status stays once it is on screen (REQ-13.13.2, the same minimum as the draft's, delayedFlag.ts). */
export const STATUS_MIN_MS = 300;
/**
 * A status appears when the work is not done 140 ms after the press: painted by 150 ms (RULE-2: "by 150 ms"), and a quick open (F-small: the whole message is there about 100 ms after the
 * press in a release build) never flashes it. Counted from the press, not from when the pane was built.
 */
export const STATUS_AFTER_MS = 140;
/** The longest a shell may stay: 5 s headers + 8 s pictures + 2 s (REQ-13.13.8). Then it is filled with what is there. */
export const SAFETY_MS = 15_000;
/** The window's own safety end (the hand-over from the main window may be lost): a little after the main window's. */
export const WINDOW_SAFETY_MS = SAFETY_MS + 5_000;

const shownAt = new Map<string, number>();

/** Compose calls it when the status of shell `id` is drawn. */
export function statusShown(id: string, now: number = Date.now()): void {
  if (!shownAt.has(id)) shownAt.set(id, now);
  if (shownAt.size > 32) for (const k of shownAt.keys()) { shownAt.delete(k); break; } // (a handful of shells exist at the same time)
}

/** Milliseconds that shell `id`'s status still has to stay on screen (0 when it was never shown or has been long enough). */
export function statusRemaining(id: string, now: number = Date.now()): number {
  const at = shownAt.get(id);
  return at === undefined ? 0 : Math.max(0, STATUS_MIN_MS - (now - at));
}

/** The shell is over (filled, discarded): forget it. */
export function shellDone(id: string): void {
  shownAt.delete(id);
}

/** Resolves after the next frame was painted (a frame callback, then a task: the browser has drawn what was set before). A window nobody sees gets no frames: 100 ms at most. */
export function afterPaint(): Promise<void> {
  return new Promise((done) => {
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        done();
      }
    };
    setTimeout(end, 100);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(end, 0));
  });
}

export const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
