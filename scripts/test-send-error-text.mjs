// A send that the mail server (or the connection to it) refuses in its own words ("SMTP send failed: response error: incomplete response") is shown as a sentence
// first and the technical text as its detail (1.0.7 WP2a retest, UX-1): store.ts friendlyError, text `errors.sendRefused` in the 8 languages. The page checks of the
// real toast are in test-compose-restore.mjs (a subject with [smtpfail]). Run: node --experimental-strip-types scripts/test-send-error-text.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const store = read("src/store.ts");
// the wiring: after the patterns that have a sentence of their own (timeout, DNS, sign-in, certificate), before the generic cut
const at = (needle) => store.indexOf(needle);
assert.ok(at("errors.timeout") > 0 && at('t("errors.sendRefused"') > at("errors.certificate") && at('t("errors.sendRefused"') < at("return shortenError(raw);\n}\n\n/** Longer texts"), "the sentence is chosen after the specific ones and before the generic text");
assert.ok(store.includes("/^SMTP send failed:\\s*([\\s\\S]+)$/"), "it is the plain text of a refused send");
assert.ok(store.includes('t("errors.sendRefused", { detail: cutAtWord(detail, 120) })'), "the detail is the server's words, cut at a word when long");
assert.ok(store.includes('fullErrors.set(shown, t("errors.sendRefused", { detail }))'), "and the whole text stays for the tooltip");
// the Rust side keeps its text: the outbox retry rule (schedule.rs is_transient) reads it
assert.ok(read("src-tauri/src/smtp.rs").includes('format!("SMTP send failed: {detail}")'), "the backend text is unchanged");
// the sentence in every language, with the detail
const files = ["src/i18n/ns/errors.ts", ...readdirSync(new URL("../src/i18n/locales", import.meta.url)).map((l) => `src/i18n/locales/${l}/errors.ts`)];
assert.equal(files.length, 8);
for (const f of files) {
  const t = read(f);
  const m = [...t.matchAll(/"errors\.sendRefused": ("(?:[^"\\]|\\.)*"),/g)];
  assert.equal(m.length, 1, `${f}: errors.sendRefused`);
  for (const x of m) {
    const text = JSON.parse(x[1]);
    assert.ok(text.includes("{detail}") && !text.includes("SMTP send failed") && text.length > 40, `${f}: ${text}`);
  }
}
assert.match(read("src/i18n/ns/errors.ts"), /"errors\.sendRefused": "The mail server did not accept the message\. Try again in a moment; if it keeps failing, check the outgoing server in Settings\. \(Details: \{detail\}\)"/);
console.log("test-send-error-text: ok");
