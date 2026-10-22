// The background a mail is read on. "original" (the default, in every app theme) shows the mail exactly as its sender designed it:
// white where the sender gave no colour, nothing recoloured. "dark" puts it on the dark surface (the recolouring is darkMail.ts).
// (hm-pend hides a dark mail until it is recoloured; its animation is the way out when nothing recolours it: 1.5 s, then the mail shows in the dark base colours.)
// The choice is a preference (`mailCanvas`), so it is remembered. Imports nothing, so a plain Node script can test it
// (scripts/test-mail-canvas.mjs).

export type MailCanvas = "original" | "dark";

export const DEFAULT_MAIL_CANVAS: MailCanvas = "original";

/** The dark surface a mail sits on in the "dark" presentation: the same in both app themes (it is the dark theme's own surface). */
export const DARK_CANVAS: [number, number, number] = [27, 28, 32];

/** A stored value as a canvas; anything unknown (an older file, a hand edit) is the default. */
export function resolveMailCanvas(v: unknown): MailCanvas {
  return v === "dark" ? "dark" : DEFAULT_MAIL_CANVAS;
}

export function toggleMailCanvas(c: MailCanvas): MailCanvas {
  return c === "dark" ? "original" : "dark";
}

/** Attributes of the frame's <html>: a mail that opens dark is created dark and hidden until recoloured (no flash of the original), one that opens original is plain. */
export function frameRootClass(c: MailCanvas): string {
  return c === "dark" ? ' class="hm-dark hm-pend"' : "";
}

/** The base style of the frame: the colours around the mail's own. Screen only for the dark ones, so printing always uses the original. */
export function frameBaseCss(): string {
  const [r, g, b] = DARK_CANVAS;
  return (
    `html{--hm-fg:#242424;--hm-link:#0f6cbd;--hm-bg:#ffffff}` +
    `@media screen{html.hm-dark{--hm-fg:#e6e6e6;--hm-link:#6cb8f6;--hm-bg:rgb(${r},${g},${b});color-scheme:dark}html.hm-dark img{filter:brightness(.9)}html.hm-pend body{visibility:hidden;animation:hm-show 0s linear 1.5s forwards}@keyframes hm-show{to{visibility:visible}}}`
  );
}
