// The default font of a message, from the preferences (Settings > Composing > Default font).
import type { Prefs } from "../prefs";
import type { BaseFont } from "./emailHtml";
import { DEFAULT_FONT_NAME, DEFAULT_FONT_SIZE, stackFor } from "./fonts";

export function baseFromPrefs(p: Pick<Prefs, "composeFontName" | "composeFontSize">): BaseFont {
  return { family: stackFor(p.composeFontName || DEFAULT_FONT_NAME), size: p.composeFontSize || DEFAULT_FONT_SIZE };
}
