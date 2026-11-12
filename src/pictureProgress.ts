// The progress of the pictures of one shown message (1.0.17): how many are still on their way, counted in the mail frame, and the one thin bar the reading pane draws from it.
// Pure rules plus one DOM reader; imports nothing.

/** The pictures of the frame that are not there yet: boxes that say they load (hidden-picture boxes, large inline pictures), pictures that wait for the backend, pictures still decoding. A failed one is done. */
export function countPendingPictures(doc: Document): number {
  let n = doc.querySelectorAll('.hl-bp[data-state="loading"], .hl-ph[aria-busy="true"], img[data-hl-wait]').length;
  for (const i of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) if (!i.hasAttribute("data-hl-wait") && !i.complete) n++;
  return n;
}

/** What the bar knows: `peak` pictures were on their way at most in the current round, `pending` still are, `cycle` counts the rounds (a round starts when pictures begin to load after none did). */
export type PicProgress = { peak: number; pending: number; cycle: number };
export const PIC_IDLE: PicProgress = { peak: 0, pending: 0, cycle: 0 };

/** The next state for a new count of pending pictures; the same object when nothing changed. */
export function stepProgress(p: PicProgress, pending: number): PicProgress {
  const n = Math.max(0, Math.floor(pending));
  if (n === p.pending) return p;
  if (n === 0) return { peak: p.peak, pending: 0, cycle: p.cycle }; // (the round is over: `peak` stays for the full bar)
  if (p.pending === 0) return { peak: n, pending: n, cycle: p.cycle + 1 };
  return { peak: Math.max(p.peak, n), pending: n, cycle: p.cycle };
}

/** Done / all of the round, 0..1; 1 when the round is over. */
export function progressValue(p: PicProgress): number {
  if (p.peak <= 0) return 0;
  return p.pending <= 0 ? 1 : Math.min(1, Math.max(0, (p.peak - p.pending) / p.peak));
}

/**
 * Reports the pending count of a frame document now and whenever it can have changed: boxes change state or are replaced (mutations), a picture ends loading (load / error do not bubble,
 * so they are caught on the way down). Calls are merged to one per 50 ms. Returns the stop function. The document is replaced by every rebuild of the frame: the caller watches the new one.
 */
export function watchPictures(doc: Document, report: (pending: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = () => {
    timer = undefined;
    if (!stopped) report(countPendingPictures(doc));
  };
  const soon = () => {
    if (timer === undefined) timer = setTimeout(run, 50);
  };
  const obs = typeof MutationObserver === "function" && doc.body ? new MutationObserver(soon) : null;
  obs?.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "aria-busy", "data-hl-wait", "src"] });
  doc.addEventListener("load", soon, true);
  doc.addEventListener("error", soon, true);
  report(countPendingPictures(doc));
  return () => {
    stopped = true;
    clearTimeout(timer);
    obs?.disconnect();
    doc.removeEventListener("load", soon, true);
    doc.removeEventListener("error", soon, true);
  };
}
