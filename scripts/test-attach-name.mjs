// Attachment file names (O-05 / BUG-18): the composer's copy of the cleaning agrees with the backend's (same vectors as attach.rs).
// Run: node --experimental-strip-types scripts/test-attach-name.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NAME_MAX_BYTES, NAME_MAX_CHARS, outgoingName, outgoingNames } from "../src/attachName.ts";

const v = JSON.parse(readFileSync(new URL("./fixtures/attach-names.json", import.meta.url), "utf8"));
/** {U+XXXX} is that character, {rep:n:text} is text n times */
const expand = (s) =>
  s
    .replace(/\{U\+([0-9A-Fa-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\{rep:(\d+):([^}]*)\}/g, (_, n, t) => t.repeat(Number(n)));

assert.ok(v.outgoing.length > 30 && v.duplicates.length > 5);
for (const [input, want] of v.outgoing) {
  const i = expand(input);
  const w = expand(want);
  assert.equal(outgoingName(i), w, JSON.stringify(input));
  assert.equal(outgoingName(w), w, "idempotent: " + JSON.stringify(want));
  const got = outgoingName(i);
  assert.ok(Array.from(got).length <= NAME_MAX_CHARS && new TextEncoder().encode(got).length <= NAME_MAX_BYTES, got);
}
for (const [input, want] of v.duplicates) assert.deepEqual(outgoingNames(input.map(expand)), want.map(expand), JSON.stringify(input));

// the names of the plan (O-05)
assert.equal(outgoingName("..\\..\\Windows\\evil.bat"), "evil.bat");
assert.equal(outgoingName("/etc/passwd"), "passwd");
assert.equal(outgoingName("CON.txt"), "_CON.txt");

// the wiring: files are cleaned when they are attached and when a draft / forward brings its attachments in
const compose = readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8");
assert.ok(/filename: outgoingName\(f\.name \|\| "pasted-image\.png"\)/.test(compose), "attached files get the clean name");
assert.ok(/outgoingNames\(\(init\.attachments/.test(compose), "attachments of a draft / forward are shown under the clean name");
assert.ok(/filename: outgoingName\(picSel\.name/.test(compose), "a picture turned into an attachment gets the clean name");
console.log("test-attach-name: ok");
