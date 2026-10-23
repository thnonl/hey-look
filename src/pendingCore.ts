// A pending state that does not flash (1.0.7 W13.14, RULE-2 of spec-107-wp13e-feedback.md): `show` runs when the work has taken `after` ms, `hide` when it ended - not before the state had
// been on screen for `min` ms. `end()` is safe to call twice. Pure (the clock is a parameter), so scripts/test-pending-core.mjs checks the rule in plain Node; the app binds it to
// a sticky busy toast (pendingToast.ts) or to a store flag.
export interface Clock {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

export const realClock: Clock = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface Pending {
  /** the work is over: the pending state goes (after its minimum, when it was shown) */
  end(): void;
  /** is the state on screen now? */
  readonly shown: boolean;
}

export function startPending(show: () => void, hide: () => void, clock: Clock = realClock, after = 100, min = 300): Pending {
  let shownAt = 0;
  let ended = false;
  let hidden = false;
  const wait = clock.setTimeout(() => {
    if (ended) return;
    shownAt = clock.now();
    show();
  }, after);
  const off = () => {
    if (hidden) return;
    hidden = true;
    hide();
  };
  return {
    end() {
      if (ended) return;
      ended = true;
      clock.clearTimeout(wait);
      if (!shownAt) return;
      const left = min - (clock.now() - shownAt);
      if (left > 0) clock.setTimeout(off, left);
      else off();
    },
    get shown() {
      return shownAt > 0 && !hidden;
    },
  };
}
