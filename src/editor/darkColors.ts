// What the composer's dark preview surface shows for a colour the person picked (see previewColors.ts). Pure: a plain Node script tests it.
import { contrast, darkBg, lightText } from "../darkMail.ts";
import { DARK_CANVAS } from "../mailCanvas.ts";
import { parseRgb, rgbHex } from "./colors.ts";

/** What the dark surface shows for a picked text colour: the colour itself when it reads (WCAG AA), else a light one of the same hue. */
export function darkTextColor(hex: string, behind: [number, number, number] = DARK_CANVAS): string {
  const c = parseRgb(hex);
  if (!c) return hex;
  return contrast(c, behind) >= 4.5 ? hex : rgbHex(lightText(c, behind, 4.5));
}

/** What the dark surface shows for a picked highlight. */
export function darkHighlight(hex: string): string {
  const c = parseRgb(hex);
  return c ? rgbHex(darkBg(c)) : hex;
}
