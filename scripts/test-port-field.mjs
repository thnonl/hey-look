// 1.0.7 D-006, no browser. Run: node --experimental-strip-types scripts/test-port-field.mjs
// The port boxes of Settings > Add account: the text -> port rule (digits only, no leading zeros, empty = 0, over 65535 refused), the box text, and that no port box is an
// <input type="number"> (ArrowUp / the mouse wheel on a focused number box add one: a typed SMTP port 31501 was reported saved as 31502).
import assert from "node:assert/strict";
import fs from "node:fs";
import { MAX_PORT, portFromText, portText } from "../src/portField.ts";

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

for (const p of [1, 25, 110, 143, 465, 587, 993, 995, 1143, 31500, 31501, 31502, 65535]) {
  eq(portFromText(String(p), 465), p, `typed ${p}`);
  eq(portText(p), String(p), `shown ${p}`);
  eq(portFromText(portText(p), 7), p, `round trip ${p}`);
}
eq(portFromText("", 465), 0, "empty = no port");
eq(portText(0), "", "no port = empty box (the placeholder shows)");
eq(portFromText("0", 465), 0);
eq(portFromText("0587", 465), 587, "leading zero");
eq(portFromText(" 31501 ", 465), 31501, "paste with blanks");
eq(portFromText("smtp:465", 1), 465, "paste with text");
eq(portFromText("-587", 1), 587, "no sign");
eq(portFromText("5.87", 1), 587, "no decimal point");
eq(portFromText("1e3", 1), 13, "no exponent: the digits 1 and 3");
eq(portFromText("65536", 465), 465, "over 65535: the previous port stays");
eq(portFromText("99999", 587), 587);
eq(portFromText("123456789012345678901234567890", 25), 25, "far too long");
eq(portFromText(String(MAX_PORT), 1), 65535);
eq(MAX_PORT, 65535);

const sd = fs.readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8");
const boxes = sd.split("\n").filter((l) => /settings\.add\.(imap|smtp)Port/.test(l) && l.includes("<input"));
eq(boxes.length, 2, "an IMAP and an SMTP port box");
for (const l of boxes) {
  assert.ok(!/type="number"/.test(l), l.trim());
  assert.ok(/type="text" inputMode="numeric"/.test(l), l.trim());
  assert.ok(/portFromText\(e\.target\.value, adv\.(imap|smtp)Port\)/.test(l) && /value=\{portText\(adv\.(imap|smtp)Port\)\}/.test(l), l.trim());
  n++;
}
// no other number box takes a port or an account setting
for (const f of fs.readdirSync(new URL("../src/components/", import.meta.url))) {
  if (!f.endsWith(".tsx")) continue;
  const src = fs.readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8");
  assert.ok(!/type="number"[^\n]*(Port|port)/.test(src), `${f}: a number box for a port`);
}
n++;
console.log(`ok - test-port-field (${n} checks)`);
