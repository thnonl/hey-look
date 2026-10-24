// Settings > About: the three links (Website, Buy me a coffee, Source code) and that the page, README and site agree on them.
// Run: node --experimental-strip-types scripts/test-about-links.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ABOUT_LINKS, siteUrl, supportUrl } from "../src/aboutLinks.ts";
import { LANGUAGES } from "../src/i18n/languages.ts";
import { loadAllLanguages, setLangPref } from "../src/i18n/index.ts";
import { LANGS as SITE_LANGS } from "./generate-site-languages.mjs";

await loadAllLanguages(); // (the languages are chunks of their own: setLangPref needs them loaded)

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

assert.deepEqual(ABOUT_LINKS.map((l) => [l.text, l.url]), [
  ["Website", "https://heylook.namthai.site/"],
  ["Buy me a coffee", "https://heylook.namthai.site/support.html"],
  ["Source code", "https://github.com/thnonl/hey-look"],
  ["Privacy policy", "https://heylook.namthai.site/privacy.html"],
]);

// the support link opens the page of the language in use (W10.20): English at the root, the others in their folder of the site; read at the click, so a language switch counts
const SITE = "https://heylook.namthai.site/";
const dirOf = (code) => SITE_LANGS.find((l) => l.hreflang === code)?.dir; // the generator's list is the site's own
for (const l of LANGUAGES) {
  const dir = dirOf(l.code);
  assert.notEqual(dir, undefined, `${l.code}: the site has no folder for this app language (add it to SITE_DIR in src/aboutLinks.ts when the site gets one)`);
  const want = SITE + (dir ? dir + "/" : "") + "support.html";
  assert.ok(existsSync(new URL(`../docs/${dir ? dir + "/" : ""}support.html`, import.meta.url)), `${want} exists in docs/`);
  setLangPref(l.code);
  assert.equal(supportUrl(), want, `${l.code}: supportUrl()`);
  assert.equal(ABOUT_LINKS[1].url, want, `${l.code}: Settings > About link`);
  assert.equal(siteUrl("privacy.html"), want.replace("support.html", "privacy.html"), `${l.code}: siteUrl`);
}
// WP14 W14.5 (Microsoft Store policy 10.5.1 and 11.16): the privacy policy is a fourth link of Settings > About, and the AI Assistant tab links to the section "Content from the AI Assistant" of
// the help page, both in the language in use (the page of that language exists, and the help page has the section with the id the link points at)
for (const l of LANGUAGES) {
  const dir = dirOf(l.code);
  setLangPref(l.code);
  const folder = dir ? dir + "/" : "";
  assert.equal(ABOUT_LINKS[3].url, SITE + folder + "privacy.html", `${l.code}: Settings > About privacy policy link`);
  assert.ok(existsSync(new URL(`../docs/${folder}privacy.html`, import.meta.url)), `${l.code}: privacy.html exists`);
  assert.equal(siteUrl("help.html#ai-report"), SITE + folder + "help.html#ai-report", `${l.code}: the AI report link`);
  const help = read(`docs/${folder}help.html`);
  assert.equal((help.match(/<details class="hq" id="ai-report">/g) ?? []).length, 1, `${l.code}: help.html has the section id="ai-report" once`);
  assert.ok(help.includes(`<summary>${l.code === "en" ? "Content from the AI Assistant" : ""}`), `${l.code}: the section has a summary`);
}
setLangPref("en");
const dlgSrc = read("src/components/SettingsDialog.tsx");
assert.ok(dlgSrc.includes('siteUrl("help.html#ai-report")') && dlgSrc.includes('t("settings.ai.report")'), "the AI tab links to the report section of the help page");

assert.equal(siteUrl("support.html", "zh-Hans"), SITE + "zh/support.html");
assert.equal(siteUrl("support.html", "xx"), SITE + "support.html", "a language the site does not have falls back to English");
assert.equal(siteUrl("support.html", "en-XA"), SITE + "support.html", "the dev pseudo-locale uses the English page");
setLangPref("en"); // (the checks below, the README and the text of the links, are English)
assert.equal(ABOUT_LINKS[1].url, SITE + "support.html");
// the reminder's "Buy me a coffee" asks for the address when it is pressed, not once at start-up
const host = read("src/supportNudgeHost.ts");
assert.match(host, /openUpdateLink\(supportUrl\(\)\)/);
assert.ok(!/SUPPORT_URL/.test(host + read("src/aboutLinks.ts")), "no fixed English support address is left");

// the dialog draws exactly these through the helper that reports a failed open
const dlg = read("src/components/SettingsDialog.tsx");
const about = dlg.slice(dlg.indexOf("function AboutTab()"), dlg.indexOf("// ---------------------------------------------------------------- shell"));
assert.match(about, /ABOUT_LINKS\.map\(/);
assert.match(about, /openUpdateLink\(l\.url\)/);
assert.ok(!/GitHub repository/.test(dlg), "the old link text is gone");

// the README says the same, and the pages exist on the site
const readme = read("README.md");
assert.ok(readme.includes(`**Website:** ${ABOUT_LINKS[0].url}`));
assert.ok(readme.includes(`[buy me a coffee](${ABOUT_LINKS[1].url})`));
assert.ok(existsSync(new URL("../docs/support.html", import.meta.url)) && existsSync(new URL("../docs/index.html", import.meta.url)));

// the changelog has the section of the next version at the top
assert.match(read("CHANGELOG.md"), /^# Changelog\n\n## (1\.0\.7 \(unreleased\)|1\.0\.6 — )/); // (the version being worked on, or the last one released)
console.log("ok - test-about-links");
