// The press of Reply / Reply all / Forward shows on the button at once (1.0.7 W13.13, RULE-3a): while the answer is being opened the button is `aria-busy` with the small ring in place of its
// icon. In the pane the compose takes the place of the reading pane in the same moment; this matters when the answer opens in a window of its own (the pane stays). Kept apart from
// actions.ts and the store so the buttons need nothing else.
import { useSyncExternalStore } from "react";

/** How long a busy button stays once it is shown (RULE-2: no flicker). */
const HOLD_MS = 300;
/** key -> when it was pressed; a key that is over but not yet 300 ms old stays in until then */
const since = new Map<string, number>();
const ending = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

/** `key`: `answerKey(...)` of the answer. On: shown in the same frame as the press; off: it goes when 300 ms are over. */
export function setAnswerBusy(key: string, on: boolean): void {
  if (on) {
    clearTimeout(ending.get(key));
    ending.delete(key);
    if (!since.has(key)) since.set(key, Date.now());
    tell();
    return;
  }
  const at = since.get(key);
  if (at === undefined || ending.has(key)) return;
  const left = HOLD_MS - (Date.now() - at);
  const end = () => {
    since.delete(key);
    ending.delete(key);
    tell();
  };
  if (left <= 0) end();
  else ending.set(key, setTimeout(end, left));
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** True from the press of the answer `key` until its shell is open (and at least 300 ms). */
export function useAnswerBusy(key: string): boolean {
  return useSyncExternalStore(subscribe, () => since.has(key));
}
