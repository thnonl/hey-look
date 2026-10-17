// "Hold Shift to do the opposite" (REQ-C1, C2) for every way of starting a message: the buttons of the ribbon and of the reading pane, the
// menu of a row, the keys R / A / F / C. They all end in `actions.ts` / `startCompose`, which have no event in their hands, so the modifier of
// the click or key press that is being handled is noted here, by one listener on the window (capture phase, so it runs before any component).
// A call that does not come from a click or a key (the tray, a notification, a restored message) passes `shift: false` itself.
// Pure core (the listener only calls `noteInput`), so scripts/test-popout.mjs runs it.
import { shiftOnly } from "./entry.ts";

/** How long a noted click or key stays "the one being handled". The calls that read it run synchronously inside the click, so this is generous. */
export const MODIFIER_WINDOW_MS = 700;

let last = { shift: false, at: 0 };

type Input = { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

/** Note the modifiers of an input event (Shift and nothing else counts: Ctrl+Shift+... are other shortcuts). */
export function noteInput(e: Input, now: number = Date.now()): void {
  last = { shift: shiftOnly(e), at: now };
}

/** Is the click or key press that is being handled a Shift one? */
export function shiftNow(now: number = Date.now()): boolean {
  return last.shift && now - last.at <= MODIFIER_WINDOW_MS;
}

/** Forget what was noted (tests). */
export function resetModifier(): void {
  last = { shift: false, at: 0 };
}

/** Start listening (the main window). Returns the function that stops it. */
export function installModifierTracking(): () => void {
  const on = (e: Event) => noteInput(e as MouseEvent | KeyboardEvent);
  const types = ["click", "auxclick", "keydown", "contextmenu"];
  for (const t of types) window.addEventListener(t, on, true);
  return () => {
    for (const t of types) window.removeEventListener(t, on, true);
  };
}
