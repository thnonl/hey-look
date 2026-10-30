// The "sent" mark of Compose (1.0.11): after a send went through, the locked editor gives way for a moment to a check mark and "Message sent", then the pane (or the window) ends.
// Kept out of Compose.tsx so the timing can be tested (scripts/test-sent-mark.mjs).

/** How long the mark stays: about a second with the drawing animation. */
export const SENT_MARK_MS = 1000;
/** With reduced motion nothing is drawn, the mark is just there: a shorter, plain confirmation. */
export const SENT_MARK_MS_REDUCED = 600;

export const sentMarkMs = (reduced: boolean): number => (reduced ? SENT_MARK_MS_REDUCED : SENT_MARK_MS);

/** The system / browser asks for less motion (the stylesheet turns the animation off by itself; this only shortens the time the plain mark stays). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
