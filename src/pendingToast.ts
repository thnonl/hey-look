// The pending state of work that has no place of its own (a batch, a send, a save): a sticky info toast with a spinner (RULE-3d of spec-107-wp13e-feedback.md), shown after `after` ms and kept at least
// `min` ms. `key` is the toast's key: one at a time per work.
import { startPending, type Pending } from "./pendingCore";
import { useStore } from "./store";

export function pendingToast(key: string, text: string | (() => string), after = 100, min = 300): Pending {
  const st = () => useStore.getState();
  return startPending(
    () => st().setStickyToast(key, { text, kind: "info", busy: true, hideClose: true }),
    () => st().setStickyToast(key, null),
    undefined,
    after,
    min,
  );
}
