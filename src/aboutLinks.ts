// The links at the bottom of Settings > About (opened through openUpdateLink, which reports an open that fails).
// Loads in a plain Node script (scripts/test-about-links.mjs): the only import is the translator, with its extension.
import { getLang, t } from "./i18n/index.ts";

const SITE = "https://heylook.namthai.site/";
/** The folder of each language on the website (docs/<dir>/). English is the root page and the fallback for a language the site does not have. */
const SITE_DIR: Readonly<Record<string, string>> = { vi: "vi", fr: "fr", "zh-Hans": "zh", es: "es", ja: "ja", de: "de", ru: "ru" };

/** The address of a page of the website ("support.html") in a language (default: the language in use). */
export function siteUrl(page: string, lang: string = getLang()): string {
  const dir = SITE_DIR[lang];
  return SITE + (dir ? dir + "/" : "") + page;
}

/** The support page ("Buy me a coffee") in the language in use: Settings > About and the occasional support reminder open the same address. Read when the link is pressed. */
export const supportUrl = (): string => siteUrl("support.html");

export interface AboutLink {
  text: string;
  url: string;
}

// `text` and the Website / support `url` are read when the link is drawn or pressed, so they follow the language in use
export const ABOUT_LINKS: readonly AboutLink[] = [
  { get text() { return t("settings.about.website"); }, get url() { return siteUrl(""); } },
  { get text() { return t("settings.about.coffee"); }, get url() { return supportUrl(); } },
  { get text() { return t("settings.about.source"); }, url: "https://github.com/thnonl/hey-look" },
  // (Microsoft Store policy 10.5.1: the privacy policy is reachable inside the app; the page of the language in use, read when the link is pressed)
  { get text() { return t("settings.about.privacyPolicy"); }, get url() { return siteUrl("privacy.html"); } },
];
