// The links at the bottom of Settings > About (opened through openUpdateLink, which reports an open that fails).
// Loads in a plain Node script (scripts/test-about-links.mjs): the only import is the translator, with its extension.
import { t } from "./i18n/index.ts";

/** The support page ("Buy me a coffee"): Settings > About and the occasional support reminder open the same address. */
export const SUPPORT_URL = "https://heylook.namthai.site/support.html";

export interface AboutLink {
  text: string;
  url: string;
}

// `text` is read when the link is drawn, so it follows the language in use
export const ABOUT_LINKS: readonly AboutLink[] = [
  { get text() { return t("settings.about.website"); }, url: "https://heylook.namthai.site/" },
  { get text() { return t("settings.about.coffee"); }, url: SUPPORT_URL },
  { get text() { return t("settings.about.source"); }, url: "https://github.com/thnonl/hey-look" },
];
