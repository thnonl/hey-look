// The jump to a setting (1.0.7 W8.12, D-12.7): one code path for a result of Settings search and for the deep link `focus` (the "Open settings" of the remote-pictures
// banner, an AI problem ...). The page is already shown when this runs. Plain DOM, no React; the scroll is arithmetic (no smooth scrolling, no `behavior` value that
// WebKit 14 would refuse), and it never scrolls anything but `.settings-body`.
import type { EntryKind } from "./settingsIndex";

/** How long the highlight stays (ms); the CSS fades it out during the last 0.6 s unless the person asked for less motion. */
export const HIT_MS = 2400;

const CONTROL = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const timers = new WeakMap<Element, number>();

/** The setting's first control that can take the focus: the picked radio of a group of cards, else the first enabled control; the target itself when it is one. */
function firstControl(el: HTMLElement): HTMLElement | null {
  if (el.matches(CONTROL)) return el;
  return el.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? el.querySelector<HTMLElement>(CONTROL);
}

/** Puts `el` in the vertical middle of the settings body (at its top when it is taller than the body). */
function centre(el: HTMLElement): void {
  const body = el.closest<HTMLElement>(".settings-body");
  if (!body) return;
  const b = body.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.height >= body.clientHeight) body.scrollTop += r.top - b.top - 8;
  else body.scrollTop += r.top + r.height / 2 - (b.top + body.clientHeight / 2);
}

const settling = new WeakMap<Element, () => void>();
const STOP_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
/**
 * A page that is still drawing (a list that is read, a font that arrives) changes the height of what is above the setting after it was centred: for 800 ms the setting is
 * centred again when the page changes its size, unless the person has scrolled, clicked or pressed a key in the meantime.
 */
function settle(el: HTMLElement): void {
  const body = el.closest<HTMLElement>(".settings-body");
  const page = body?.firstElementChild;
  if (!body || !page || typeof ResizeObserver === "undefined") return;
  settling.get(body)?.();
  const ro = new ResizeObserver(() => (el.isConnected ? centre(el) : stop()));
  const timer = window.setTimeout(() => stop(), 800);
  function stop(): void {
    ro.disconnect();
    clearTimeout(timer);
    for (const ev of STOP_EVENTS) body!.removeEventListener(ev, stop, true);
    if (settling.get(body!) === stop) settling.delete(body!);
  }
  for (const ev of STOP_EVENTS) body.addEventListener(ev, stop, true);
  settling.set(body, stop);
  ro.observe(page);
}

/**
 * Shows the setting with id `set-<id>`: opens a closed <details> that holds it, scrolls it to the middle, lights it up for 2.4 s (a second jump to the same setting restarts the
 * light) and moves the focus to its first control. A row with no control that can be focused (a disabled switch, a plain text) and a heading take the focus themselves
 * (`tabindex="-1"`). Returns false when the page has no such element (yet).
 */
export function showSetting(id: string, kind: EntryKind = "row"): boolean {
  const el = document.getElementById(`set-${id}`);
  if (!el) return false;
  for (let d = el.parentElement?.closest("details"); d; d = d.parentElement?.closest("details")) if (!d.open) d.open = true;
  centre(el);
  settle(el);
  const old = timers.get(el);
  if (old) clearTimeout(old);
  el.classList.remove("set-hit");
  void el.offsetWidth; // (the animation starts again)
  el.classList.add("set-hit");
  timers.set(el, window.setTimeout(() => el.classList.remove("set-hit"), HIT_MS));
  let target = kind === "page" ? null : firstControl(el);
  if (!target) {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    target = el;
  }
  target.focus({ preventScroll: true });
  return true;
}
