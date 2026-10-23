// Source check of the Compose recipient fields (QA BUG-9: Tab from To landed on the Cc and Bcc buttons, not on Subject).
// Run: node scripts/test-compose-tab-order.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// (the recipient field lives in RecipientField.tsx since WP9d; it comes first in the text, as it did in Compose.tsx)
const src = (readFileSync(new URL("../src/components/RecipientField.tsx", import.meta.url), "utf8") + readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// 1. The "Cc" / "Bcc" show-links are not in the Tab order, so the DOM order To -> Subject has no stop between them.
// (the visible texts are dictionary keys now: {t("compose.cc")} shows "Cc", {t("compose.bcc")} shows "Bcc")
const links = src.slice(src.indexOf('className="cf-links"'), src.indexOf('<label>{t("compose.subject")}</label>'));
for (const name of ["Cc", "Bcc"]) {
  const m = new RegExp(`<button[^
]*>\\{t\\("compose\\.${name.toLowerCase()}"\\)\\}</button>`).exec(links);
  assert.ok(m, `the ${name} link exists`);
  assert.match(m[0], /tabIndex=\{-1\}/, `${name} must not be a Tab stop`);
}
// the toggles stay reachable by keyboard
assert.match(src, /Ctrl\/Cmd\+Shift\+C \/ B show and focus them/);

// 2. In a recipient field Tab commits the text and then lets the browser move on (no preventDefault for Tab; Shift+Tab goes back).
const field = src.slice(src.indexOf('onKeyDown={(e) => {'), src.indexOf('} else if (e.key === "Backspace"'));
assert.match(field, /const moveOn = e\.key === "Tab";/);
assert.ok((field.match(/if \(!moveOn\) e\.preventDefault\(\);/g) ?? []).length === 2, "commit and pick keep the default Tab behaviour");
assert.ok(field.indexOf("commit(text)") > field.indexOf("moveOn"), "the text is committed");

// 3. The order of the fields in the DOM: From, To, (Cc, Bcc when shown), Subject.
const order = ['<label>{t("compose.from")}</label>', 'label={t("compose.to")}', 'label={t("compose.cc")}', 'label={t("compose.bcc")}', '<label>{t("compose.subject")}</label>'].map((k) => src.indexOf(k));
assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `field order ${order}`);
console.log("compose-tab-order: all checks passed");
