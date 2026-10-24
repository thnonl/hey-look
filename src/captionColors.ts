/**
 * The colours of the native title bar of the secondary windows (Windows 11, W4.3): the colour of the main window's band where its caption buttons are, in Light
 * and in Dark, with the text colour on it. Pure - the pieces are the two top bar modules - so scripts/test-caption-colors.mjs runs it as it is. Only the main
 * page calls it (store.ts `publishCaptionColors`): it is the writer of the preferences and the only one that knows the colour the person chose.
 *
 * The band is a 135deg gradient from `start` to `end` over the whole width of the bar, so the colour behind the caption buttons is a point on that line, very
 * near `end` (`t` = 1) in a wide window and a little before it in a narrow one: `t` is where the minimize button sits on the gradient line (store.ts measures it).
 */
import { darkTopBar } from "./topBarDark.ts";
import { blend, buttonAccent, ratio, topBarEnds } from "./topBarLight.ts";

export interface CaptionPair { bg: string; fg: string }
export interface CaptionColors { light: CaptionPair; dark: CaptionPair }

const BLACK = "#000000", WHITE = "#ffffff";

/** `fg` when it reads on `bg` at 4.5:1 or better, else black or white, whichever has the higher contrast (REQ-4.3.4). */
export function readableCaption(bg: string, fg: string): string {
  if (ratio(fg, bg) >= 4.5) return fg;
  return ratio(BLACK, bg) >= ratio(WHITE, bg) ? BLACK : WHITE;
}

/** Where a point of a box sits on the line of a 135deg CSS gradient (0 = the top left corner, 1 = the bottom right one). */
export function gradientT(x: number, y: number, width: number, height: number): number {
  const len = width + height;
  return len > 0 ? Math.min(1, Math.max(0, (x + y) / len)) : 1;
}

/** The caption pair of each theme for the primary colour (#rrggbb, the accent setting); `t` as in the module text (default: the end of the band). */
export function captionColors(primary: string, t = 1): CaptionColors {
  const at = (start: string, end: string) => (t >= 1 ? end : blend(start, end, Math.max(0, t)));
  const light = topBarEnds(buttonAccent(primary)); // (applyPrefs builds the light bar from the button accent)
  const dark = darkTopBar(primary);
  const lightBg = at(light.start, light.end), darkBg = at(dark.start, dark.end);
  return {
    light: { bg: lightBg, fg: readableCaption(lightBg, light.fg) },
    dark: { bg: darkBg, fg: readableCaption(darkBg, WHITE) },
  };
}
