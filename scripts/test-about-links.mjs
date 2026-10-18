// Settings > About: the three links (Website, Buy me a coffee, Source code) and that the page, README and site agree on them.
// Run: node --experimental-strip-types scripts/test-about-links.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ABOUT_LINKS } from "../src/aboutLinks.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

assert.deepEqual(ABOUT_LINKS.map((l) => [l.text, l.url]), [
  ["Website", "https://thnonl.github.io/hey-look/"],
  ["Buy me a coffee", "https://thnonl.github.io/hey-look/support.html"],
  ["Source code", "https://github.com/thnonl/hey-look"],
]);

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
assert.match(read("CHANGELOG.md"), /^# Changelog\n\n## 1.0.6 — /);
console.log("ok - test-about-links");
