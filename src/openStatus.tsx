import { useEffect, useReducer, useRef, useState } from "react";
import type { MessageFull } from "./api";
import { holdState } from "./statusHold";
import { useT } from "./i18n/react";

// "Opening message…" (1.0.7 W13.6, REQ-13.6.1 / 13.6.2): from the click that selects a conversation until the frame of its open message is visible (its first measurement) the body area
// under the subject shows the status block of the reader window. Shown only when the content is not on screen after 100 ms (a quick open never flashes), once shown it stays 300 ms,
// a newer selection replaces it at once (the block is keyed by the conversation), and it never stays: 20 s (RULE-5).

/** An HTML body of this many characters or more is "heavy": cleaning it takes long enough that the status must be painted BEFORE the work starts (RULE-4). */
export const HEAVY_HTML = 120_000;
/** The status never stays longer than this (RULE-5). */
export const OPEN_SAFETY_MS = 20_000;

export const isHeavy = (m: Pick<MessageFull, "html"> | undefined): boolean => (m?.html?.length ?? 0) >= HEAVY_HTML;

/** MessageBody tells that the frame of message `id` is visible (its first measurement is done). */
export const FRAME_SHOWN = "rp-shown";
export const announceFrame = (frame: HTMLElement, id: string) => frame.dispatchEvent(new CustomEvent<string>(FRAME_SHOWN, { bubbles: true, detail: id }));

/**
 * Is the open message of this conversation still on its way to the screen? `hasFrame` says which messages draw a frame (an encrypted message that needs its card does not).
 * True from the selection, while the messages are read, until the frame of the last (open) message is visible.
 */
export function useOpeningPending(key: string | null, messages: MessageFull[], hasFrame: (m: MessageFull) => boolean): boolean {
  const [framed, setFramed] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<string | null>(null); // the conversation whose open is over: a message that arrives later (not open, no frame) does not start the status again
  const last = messages[messages.length - 1];
  const waiting = !last || (hasFrame(last) && framed !== last.id);
  useEffect(() => {
    if (!last) {
      setFramed(null); // (a conversation opened again: its frame is new)
      setDoneFor(null);
    } else if (key && !waiting) setDoneFor(key);
  }, [key, last, waiting]);
  useEffect(() => {
    const on = (e: Event) => setFramed((e as CustomEvent<string>).detail ?? null);
    document.addEventListener(FRAME_SHOWN, on);
    return () => document.removeEventListener(FRAME_SHOWN, on);
  }, []);
  if (!key) return false;
  if (!last) return true;
  return doneFor !== key && waiting;
}

/**
 * The scrolling body area of the reading pane (`.rp-body`) with the status block over it while the open message is on its way: the area does not scroll then (`opening`), the block
 * covers it, and the messages are drawn underneath (they need their layout to measure). Key it by the conversation: a newer selection replaces the block at once.
 * `printing`: a message is being prepared for the print dialog (W13.14 A10): the same block with its own text, at once. `after` / `min` are 100 / 300 ms in the pane; the reader window passes 0 / 0 (it shows the status from the start). `heavy`: the work that follows is long, so the block is
 * on screen at once, before that work starts.
 */
export function RpBody({ pending, heavy = false, after = 100, min = 300, printing = false, bodyRef, children }: { pending: boolean; heavy?: boolean; after?: number; min?: number; printing?: boolean; bodyRef?: React.Ref<HTMLDivElement>; children: React.ReactNode }) {
  const t = useT();
  const [gaveUp, setGaveUp] = useState(false);
  const [late, setLate] = useState(false); // `after` ms of waiting are over
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const since = useRef(0);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setGaveUp(true), OPEN_SAFETY_MS);
    return () => clearTimeout(id);
  }, [pending]);
  const on = pending && !gaveUp;
  useEffect(() => {
    if (!on) return setLate(false);
    const id = setTimeout(() => setLate(true), after);
    return () => clearTimeout(id);
  }, [on, after]);
  const hold = holdState(since.current, printing || (on && (heavy || after === 0 || late)), min, Date.now()); // (printing: "Preparing to print…", at once, printStatus.ts)
  since.current = hold.since;
  useEffect(() => {
    if (hold.leftMs <= 0) return;
    const id = setTimeout(redraw, hold.leftMs + 5); // (the minimum is over: draw again without the block)
    return () => clearTimeout(id);
  }, [hold.leftMs]);
  const covered = hold.show;
  return (
    <div className={`rp-body${covered ? " opening" : ""}`} ref={bodyRef}>
      {covered && (
        <div className="reader-state rp-opening" role="status" aria-busy={on || printing || undefined}>
          <span className="busy-ring spin" aria-hidden />
          <span className="busy-dots" aria-hidden>···</span>
          <p className="muted">{printing ? t("reading.print.preparing") : t("reading.popout.loading")}</p>
        </div>
      )}
      {children}
    </div>
  );
}
