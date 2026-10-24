// What a link that no program could open says and copies (W1.12, 1.0.7): an email link (mailto:) names the default mail app and copies only the address; any other link
// keeps the browser texts. And the macOS words: the quit question and the Send later picker say "menu bar" there, "tray" elsewhere.
// Run: node --experimental-strip-types scripts/test-open-failed-text.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { failedOpenText, linkToCopy, mailtoAddress } from "../src/openFailed.ts";
import { quitKeepKey, scheduleKeepKey } from "../src/trayWords.ts";
import { en } from "../src/i18n/en.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 1. the address of a mailto link
assert.equal(mailtoAddress("mailto:qa@example.test?subject=Hi"), "qa@example.test");
assert.equal(mailtoAddress("mailto:a%40b.test"), "a@b.test", "percent-decoded");
assert.equal(mailtoAddress("MAILTO:Qa@Example.test"), "Qa@Example.test", "any case of the scheme, the address as it is");
assert.equal(mailtoAddress("Mailto:a@b.test,c@d.test?cc=x@y.test&body=hi"), "a@b.test,c@d.test", "two addresses stay comma-separated");
assert.equal(mailtoAddress("mailto:a%2Cb@c.test"), "a,b@c.test");
assert.equal(mailtoAddress("mailto:%E3%81%82@b.test"), "あ@b.test", "UTF-8 percent-decoding");
assert.equal(mailtoAddress("mailto:50%@b.test"), "50%@b.test", "a stray % keeps the text");
assert.equal(mailtoAddress("  mailto:a@b.test "), "a@b.test");
assert.equal(mailtoAddress("mailto:?subject=Hi"), null, "no address: not worth copying");
assert.equal(mailtoAddress("mailto:"), null);
assert.equal(mailtoAddress("https://example.test/?u=mailto:a@b.test"), null);
assert.equal(mailtoAddress("xmailto:a@b.test"), null);

// 2. what is copied
assert.equal(linkToCopy("mailto:qa@example.test?subject=Hi"), "qa@example.test");
assert.equal(linkToCopy("https://example.test/a?b=c"), "https://example.test/a?b=c", "other links are copied whole");
assert.equal(linkToCopy("mailto:?subject=Hi"), "mailto:?subject=Hi", "a mailto link without an address is copied whole");

// 3. the text
assert.deepEqual(failedOpenText("mailto:qa@example.test?subject=Hi", true), { key: "updates.toast.mailtoFailedCopied" });
assert.deepEqual(failedOpenText("mailto:qa@example.test?subject=Hi", false), { key: "updates.toast.mailtoFailedNotCopied", vars: { address: "qa@example.test" } });
assert.deepEqual(failedOpenText("https://example.test/", true), { key: "updates.toast.openFailedCopied" });
assert.deepEqual(failedOpenText("https://example.test/", false), { key: "updates.toast.openFailedNotCopied", vars: { url: "https://example.test/" } });
const long = "a".repeat(120) + "@b.test";
assert.equal(failedOpenText(`mailto:${long}`, false).vars.address, long.slice(0, 100) + "…", "the address is cut to 100 characters + …");
assert.equal(failedOpenText("https://e.test/" + "x".repeat(200), false).vars.url.length, 101, "the url is cut the same way");
assert.equal(failedOpenText("mailto:a@b.test", false).vars.address, "a@b.test", "a short address is not cut");
assert.equal(en["updates.toast.mailtoFailedCopied"], "Couldn’t open your default mail app. The address is copied to the clipboard.");
assert.equal(en["updates.toast.mailtoFailedNotCopied"], "Couldn’t open your default mail app, and the address couldn’t be copied. The address: {address}");
assert.equal(en["updates.toast.openFailedCopied"], "Couldn’t open your browser. The link is copied to the clipboard.", "the browser texts are unchanged");

// 4. the wiring: openUpdateLink copies what linkToCopy says and shows what failedOpenText says
const updates = read("src/updates.ts");
const fn = updates.slice(updates.indexOf("export async function openUpdateLink"));
const body = fn.slice(0, fn.indexOf("\n}\n"));
assert.match(body, /const copied = await copyToClipboard\(linkToCopy\(url\)\)/);
assert.match(body, /failedOpenText\(url, copied\)/);

// 5. the macOS words
assert.equal(quitKeepKey("macos"), "app.quit.keepRunningMac");
assert.equal(scheduleKeepKey("macos"), "compose.schedule.keepInMenuBar");
for (const os of ["windows", "linux"]) {
  assert.equal(quitKeepKey(os), "app.quit.keepRunning");
  assert.equal(scheduleKeepKey(os), "compose.schedule.keepInTray");
}
assert.match(read("src/App.tsx"), /label: t\(quitKeepKey\(osNow\(\), usePlatform\.getState\(\)\.tray\)\), kind: "primary"/, "the quit question uses the per-system key");
assert.match(read("src/components/SchedulePicker.tsx"), /\{t\(keepKey\)\}<\/button>/, "the Send later picker uses the per-system key");
assert.equal(en["app.quit.keepRunningMac"], "Keep running in the menu bar");
assert.equal(en["compose.schedule.keepInMenuBar"], "Keep running in the menu bar");
assert.equal(en["app.quit.keepRunning"], "Keep running in tray", "Windows and Linux keep the tray words");
assert.equal(en["compose.schedule.keepInTray"], "Keep running in the tray");
// the Mac button fits on one line: the longest of the 8 languages is 30 characters (limit 36)
for (const lang of ["de", "es", "ja", "ru", "zh-Hans"]) {
  const src = read(`src/i18n/locales/${lang}/app.ts`);
  const m = /"app\.quit\.keepRunningMac": "([^"]+)"/.exec(src);
  assert.ok(m && m[1].length <= 36, `${lang}: the Mac button is at most 36 characters`);
}
console.log("open-failed-text: all checks passed");
