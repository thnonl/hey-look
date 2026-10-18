// Which text names the problem with a recipient's key (1.0.7 W2.6): a key that can only sign is no longer reported as "no public key". The choice is the
// pure module src/keyStatus.ts; the wiring (strip, chip popover, status type, the three texts in the 8 languages) is checked in the sources.
// Run: node --experimental-strip-types scripts/test-key-status.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { keyProblemKey } from "../src/keyStatus.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// the three places a recipient problem is told, per status
assert.equal(keyProblemKey("missing", "strip"), "compose.sec.noKey");
assert.equal(keyProblemKey("expired", "strip"), "compose.sec.theirExpired");
assert.equal(keyProblemKey("revoked", "strip"), "compose.sec.theirRevoked");
assert.equal(keyProblemKey("signOnly", "strip"), "compose.sec.theirSignOnly");
assert.equal(keyProblemKey("missing", "chipTitle"), "compose.rcpt.keyMissing");
assert.equal(keyProblemKey("expired", "chipTitle"), "compose.rcpt.keyExpired");
assert.equal(keyProblemKey("revoked", "chipTitle"), "compose.rcpt.keyRevoked");
assert.equal(keyProblemKey("signOnly", "chipTitle"), "compose.rcpt.keySignOnly");
assert.equal(keyProblemKey("missing", "chipHelp"), "compose.rcpt.missingHelp");
assert.equal(keyProblemKey("expired", "chipHelp"), "compose.rcpt.unusableHelp", "expired and revoked keep their help");
assert.equal(keyProblemKey("revoked", "chipHelp"), "compose.rcpt.unusableHelp");
assert.equal(keyProblemKey("signOnly", "chipHelp"), "compose.rcpt.signOnlyHelp");
// anything else reads as a missing key (as before the new status)
assert.equal(keyProblemKey("ok", "strip"), "compose.sec.noKey");
assert.equal(keyProblemKey(undefined, "chipTitle"), "compose.rcpt.keyMissing");

// wiring
const api = read("src/api.ts");
assert.match(api, /export type KeyStatus = "ok" \| "missing" \| "expired" \| "revoked" \| "signOnly";/);
const compose = read("src/components/Compose.tsx");
assert.ok(compose.includes('keyProblemKey(keys[keyPop].status, "chipTitle")') && compose.includes('keyProblemKey(keys[keyPop].status, "chipHelp")'), "the chip popover uses the status");
assert.ok(compose.includes('keyProblemKey(st, "strip")') && /st === "expired" \|\| st === "revoked" \|\| st === "signOnly"/.test(compose), "the strip names the status of the first recipient with a problem");
assert.ok(!compose.includes('"compose.rcpt.keyExpired"') && !compose.includes('"compose.sec.theirExpired"'), "the texts are not chosen by hand any more");
const rust = read("src-tauri/src/pgpstore.rs");
assert.ok(rust.includes('(None, Some(Unusable::NoEncryptionKey)) =>') && rust.includes('status: "signOnly".into()'), "the backend reports signOnly");
assert.ok(read("src/devMock.ts").includes('status: "signOnly"'), "the dev preview has a sign-only recipient (sign-only@...)");

// the texts are in every language, and they are the agreed ones for English
const en = read("src/i18n/ns/compose.ts");
assert.match(en, /"compose\.sec\.theirSignOnly": "Can’t encrypt for \{addr\}: their key can only sign, not encrypt\."/);
assert.match(en, /"compose\.rcpt\.keySignOnly": "The key for \{addr\} can only sign, not encrypt"/);
assert.match(en, /"compose\.rcpt\.signOnlyHelp": "This key can check signatures but can’t encrypt\. Ask for a public key that can encrypt, or import it from a file\."/);
const files = ["src/i18n/ns/compose.ts", ...readdirSync(new URL("../src/i18n/locales", import.meta.url)).map((l) => `src/i18n/locales/${l}/compose.ts`)];
assert.equal(files.length, 6);
for (const f of files) {
  const t = read(f);
  const n = (t.match(/"compose\.(sec\.theirSignOnly|rcpt\.keySignOnly|rcpt\.signOnlyHelp)":/g) ?? []).length;
  assert.equal(n, f.includes("/ns/") ? 9 : 3, `${f}: the three texts (English, Vietnamese and French live in ns/)`);
}
console.log("test-key-status: ok");
