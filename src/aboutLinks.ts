// The links at the bottom of Settings > About (opened through openUpdateLink, which reports an open that fails).
// Loads in a plain Node script (scripts/test-about-links.mjs): the only import is the translator, with its extension.
import { t } from "./i18n/index.ts";

export interface AboutLink {
  text: string;
  url: string;
}

// `text` is read when the link is drawn, so it follows the language in use
export const ABOUT_LINKS: readonly AboutLink[] = [
  { get text() { return t("settings.about.website"); }, url: "https://thnonl.github.io/hey-look/" },
  { get text() { return t("settings.about.coffee"); }, url: "https://thnonl.github.io/hey-look/support.html" },
  { get text() { return t("settings.about.source"); }, url: "https://github.com/thnonl/hey-look" },
];
