// The background a mail is read on. "original" (the default, in every app theme) shows the mail exactly as its sender designed it:
// white where the sender gave no colour, nothing recoloured. "dark" puts it on the dark surface (the recolouring is darkMail.ts).
// (hm-pend hides a dark mail until it is recoloured; its animation is the way out when nothing recolours it: 1.5 s, then the mail shows in the dark base colours.)
// The choice is a preference (`mailCanvas`), so it is remembered - in the dark app theme. In the light app theme (1.0.7 WP13g, DEC-025) the mail is always shown on its original (light)
// background whatever is stored; the button there only sets a session override (`MailCanvasSession`, never saved) that any switch of the app theme clears (mailCanvasSync.ts).
// Imports nothing, so a plain Node script can test it (scripts/test-mail-canvas.mjs).

export type MailCanvas = "original" | "dark";

/** The light theme's session-only choice: "dark" (the person pressed the button while the app is Light) or none. Never stored. */
export type MailCanvasSession = "dark" | null;

export type ThemeSetting = "system" | "light" | "dark";

/** Is the app theme dark: the setting "dark", or "system" with the OS dark. */
export function themeIsDark(theme: ThemeSetting | string, osDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && osDark);
}

/** The background a mail is shown on (REQ-13.15.1/2/4): the light theme shows the original unless this session chose dark; the dark theme shows the stored choice. */
export function effectiveCanvas(themeDark: boolean, stored: MailCanvas, session: MailCanvasSession): MailCanvas {
  if (themeDark) return stored;
  return session === "dark" ? "dark" : "original";
}

/** The background for a surface that has no session override (the composer's "Preview as recipient" start): light in the light theme, the stored choice in the dark one. */
export function canvasForTheme(themeDark: boolean, stored: MailCanvas): MailCanvas {
  return effectiveCanvas(themeDark, stored, null);
}

/** What the button does (REQ-13.15.2): in the dark theme it stores the other choice, in the light theme it sets (or takes off) the session override and stores nothing. */
export function pressCanvas(themeDark: boolean, stored: MailCanvas, session: MailCanvasSession): { pref?: MailCanvas; session?: MailCanvasSession } {
  if (themeDark) return { pref: toggleMailCanvas(stored) };
  return { session: effectiveCanvas(false, stored, session) === "dark" ? null : "dark" };
}

/** The session override after the app theme (setting or resolved scheme) may have changed: any change clears it (REQ-13.15.3). */
export function sessionAfterThemeChange(prevKey: string, nextKey: string, session: MailCanvasSession): MailCanvasSession {
  return prevKey === nextKey ? session : null;
}

/** What counts as "the theme": the setting and the scheme it resolves to now. */
export function themeKey(theme: ThemeSetting | string, osDark: boolean): string {
  return `${theme}|${themeIsDark(theme, osDark) ? "dark" : "light"}`;
}

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
