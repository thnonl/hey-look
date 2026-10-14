/**
 * The timers that take a sticky toast away by themselves. One timer per toast key: arming a key again cancels its earlier timer,
 * so a second toast with the same key is not removed by the first one's timer (QA BUG-14: after two `Restart now` attempts the
 * second error toast went 20 s after it appeared, at the first one's 30 s).
 */
export const STICKY_MS = 30_000;

export function stickyTimers(remove: (key: string) => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancel = (key: string) => {
    const t = timers.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.delete(key);
  };
  return {
    /** Remove the toast `key` after `ms`, counted from now; an earlier timer of the same key is cancelled first. */
    arm(key: string, ms = STICKY_MS) {
      cancel(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          remove(key);
        }, ms),
      );
    },
    /** The toast is gone or replaced: its timer must not fire later. */
    cancel,
  };
}
