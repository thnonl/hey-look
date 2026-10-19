// Whom a stored draft is encrypted to (1.0.7 W2.4). The rule: an encrypted draft is for the account's own key only, whatever its recipients are, and with
// "Encrypt drafts" off nothing encrypted is stored (the page sends such a draft without `security`, so the backend appends a plain one, and the autosave
// does not run). The bytes themselves are checked in Rust (`cargo test --lib pgpstore`: an_encrypted_draft_is_for_the_own_key_only,
// a_draft_without_security_is_stored_plain_and_one_with_it_is_encrypted, a_moved_scheduled_message_is_stored_for_the_own_key_only); this checks that
// every road to the Drafts folder goes through those rules.
// Run: node --experimental-strip-types scripts/test-draft-encryption.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const compose = read("src/components/Compose.tsx");
const lib = read("src-tauri/src/lib.rs");

// the page decides "Encrypt drafts": off = no security on the draft that is saved, and no autosave while Encrypt is on
assert.ok(/const keepPrivate = !!d\.security\?\.encrypt && eff\(prefs, accountId, "pgpEncryptDrafts"\);/.test(compose));
assert.ok(/security: keepPrivate \? \{ encrypt: true, sign: false, attachPublicKey: false \} : undefined/.test(compose), "a draft is never signed and never for anybody's key but your own");
assert.ok(/plainWouldLeak: encOn && !eff\(prefs, accountId, "pgpEncryptDrafts"\)/.test(compose));
assert.ok(/f\.plainWouldLeak\) return false/.test(read("src/autosave.ts")), "no autosave of an encrypted message into a plain draft");

// the backend: one function makes the bytes of every draft; a sealed scheduled message is opened and encrypted again for the own key
const fn = lib.slice(lib.indexOf("THE RULE (W2.4)"), lib.indexOf("fn remember_draft_meeting("));
assert.ok(fn.includes("encrypted to your own key only") && fn.includes("build_secure(db, acc, &d, true)"), "draft mode: the own key only");
assert.ok(fn.indexOf("unseal_from_outbox") > 0 && fn.indexOf("unseal_from_outbox") < fn.indexOf("build_secure"), "a sealed message is unsealed before it is encrypted again");
assert.ok(!fn.includes("return base64::engine::general_purpose::STANDARD.decode(pre)"), "the sealed bytes (for the recipients) are never stored as a draft");
for (const road of ["fn save_draft_on", "fn save_recovered", "async fn outbox_to_draft"]) {
  const body = lib.slice(lib.indexOf(road));
  assert.ok(body.slice(0, 3500).includes("draft_bytes(") || road === "fn save_draft_on", `${road} makes its bytes with draft_bytes`);
}
assert.ok(lib.includes("let raw = draft_bytes(&db, &acc, &draft)?;") && lib.includes("save_draft_on(&db, &acc, &mut s, &raw, replaces)"), "Save draft, the autosave and the quit save: draft_bytes, then the append");

// D-025: nothing that encrypts, signs or decrypts a message is called with the database lock held (the folder list waits for the lock on the main thread:
// a draft with big pictures stopped the whole window). The functions take the shared database and lock it for their own lookups only.
assert.ok(!/(?:build_secure|plan_secure|seal_for_outbox|unseal_from_outbox|open_message)\(\s*&lock\(/.test(lib), "a secure build or an open with the lock held");
assert.ok(!/(?:build_secure|seal_for_outbox|unseal_from_outbox)\(\s*&c\b/.test(lib), "a secure build with a held connection");
assert.ok(/open_message\(c, &m\.id, &raw\)/.test(lib), "(the one open that still has a held connection: the display of a decrypted message, apply_pgp)");
assert.ok(/pub fn build_secure<A: Access/.test(read("src-tauri/src/pgpstore.rs")) && /pub fn plan_secure/.test(read("src-tauri/src/pgpstore.rs")), "the build is split: the plan needs the database, the build does not");

// "Move to Drafts" asks for a locked key (the draft is made with it) in all three places
const sched = read("src/components/ScheduledList.tsx");
for (const [name, src] of [["Compose", compose], ["ScheduledList", sched]]) {
  assert.ok(!src.includes("api.outboxToDraft("), `${name} does not call outboxToDraft directly`);
  assert.ok(src.includes("moveScheduledToDrafts("), `${name} moves through moveScheduledToDrafts`);
}
assert.equal((compose.match(/moveScheduledToDrafts\(/g) ?? []).length, 2, "the two Compose moves");
assert.ok(/PGP_LOCKED/.test(read("src/components/Pgp.tsx").slice(read("src/components/Pgp.tsx").indexOf("moveScheduledToDrafts"))));
console.log("test-draft-encryption: ok");
