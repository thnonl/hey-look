// Checks src/recipients.ts: the one parser for typed, pasted, dropped and reopened recipient lists, the IME guard and the duplicate rule.
// Inputs are the compose test plan's (B-02, B-03, B-04, B-05, B-06, B-08, B-09, B-10). Run: node --experimental-strip-types scripts/test-recipients.mjs
import assert from "node:assert/strict";
import { addRecipients, addressOf, chipLabel, formatRecipient, hasRecipient, isImeEvent, openAtEnd, placeRecipients, recipientKey, splitRecipients } from "../src/recipients.ts";

const eq = (text, want, why) => assert.deepEqual(splitRecipients(text), want, why ?? JSON.stringify(text));

// B-02: separators, order, no empty chip
eq("a@x.test; b@y.test, c@z.test\nd@w.test;", ["a@x.test", "b@y.test", "c@z.test", "d@w.test"]);
eq("a@x.test\r\nb@y.test\r\n", ["a@x.test", "b@y.test"]);
eq(" , ; ,", []);
eq("", []);

// B-03 (CF-8): a comma in a quoted display name belongs to the name
eq('Ann Lee <ann@x.test>, "Doe, John" <john@y.test>', ["Ann Lee <ann@x.test>", '"Doe, John" <john@y.test>']);
eq('"Doe, John" <j@x.com>', ['"Doe, John" <j@x.com>']);
eq('"Doe; John" <j@x.com>; "Roe: Jane" <r@x.com>', ['"Doe; John" <j@x.com>', '"Roe: Jane" <r@x.com>']);
eq('"He said \\"hi, there\\"" <h@x.com>, b@y.com', ['"He said \\"hi, there\\"" <h@x.com>', "b@y.com"]);
eq('Doe, John <j@x.com>', ["Doe", "John <j@x.com>"], "an unquoted comma is a separator (RFC 5322); the first one is an invalid chip, nothing is lost");
// quoted local part and angle brackets
eq('<"a,b"@x.com>, c@y.com', ['"a,b"@x.com', "c@y.com"]);
// comments never split, and a comment can name a bare address
eq("john@x.com (Doe, John), b@y.com", ['"Doe, John" <john@x.com>', "b@y.com"]);
eq("Ann (the boss, really) <ann@x.test>", ["Ann <ann@x.test>"], "the name in front of the angle address wins over the comment");
eq("<ann@x.test>", ["ann@x.test"]);
// groups
eq("Team: a@x.com, b@y.com;", ["a@x.com", "b@y.com"]);
eq("undisclosed-recipients:;", []);
eq("mailto:ann@x.test", ["ann@x.test"]);
// text that is not an address stays as typed (an invalid chip), nothing disappears
eq("ann@, ann bob, ann@gmail", ["ann@", "ann bob", "ann@gmail"]);
eq('"unclosed <u@x.test>', ['"\\"unclosed" <u@x.test>'], "a quote that never closes is an ordinary character; the address is kept");

// B-04: one address, no separator
eq("ann@x.test", ["ann@x.test"]);
// B-05: Outlook / Excel column, name<TAB>address, CRLF rows
eq("Ann Lee\tann@x.test\r\nBob Roe\tbob@y.test\r\n", ["Ann Lee <ann@x.test>", "Bob Roe <bob@y.test>"]);
eq("ann@x.test\tbob@y.test", ["ann@x.test", "bob@y.test"]);
// addresses separated by blanks only; a name in front of a bare address
eq("a@x.test b@y.test", ["a@x.test", "b@y.test"]);
eq("Ann Lee ann@x.test", ["Ann Lee <ann@x.test>"]);
// B-09: IDN stays as typed (the backend turns the domain into punycode)
eq("user@bücher.example; δοκιμή@example.test", ["user@bücher.example", "δοκιμή@example.test"]);
// B-10: names with specials are quoted, once
assert.equal(formatRecipient('Nguyễn Văn "Bé" (HR), Đỗ', "e@x.test"), '"Nguyễn Văn \\"Bé\\" (HR), Đỗ" <e@x.test>');
eq(formatRecipient('Nguyễn Văn "Bé" (HR), Đỗ', "e@x.test"), ['"Nguyễn Văn \\"Bé\\" (HR), Đỗ" <e@x.test>'], "stable when parsed again");
assert.equal(formatRecipient("山田 太郎", "y@x.test"), "山田 太郎 <y@x.test>");
assert.equal(formatRecipient("O'Brien \\ Jr", "o@x.test"), '"O\'Brien \\\\ Jr" <o@x.test>');
assert.equal(formatRecipient("a\r\nBcc: evil@x.test", "o@x.test"), '"a Bcc: evil@x.test" <o@x.test>', "a line break in a name cannot start a header");
assert.equal(formatRecipient("  ", "o@x.test"), "o@x.test");

// the address of a recipient is the part in the last angle brackets (as split_mailbox in smtp.rs)
assert.equal(addressOf('"Doe <x@y.z>" <j@x.com>'), "j@x.com");
assert.equal(addressOf("Ann <ann@x.test>"), "ann@x.test");
assert.equal(addressOf(" ann@x.test "), "ann@x.test");
assert.equal(chipLabel('"Doe, John" <j@x.com>'), "Doe, John <j@x.com>");
assert.equal(chipLabel("<a@b.c>"), "a@b.c");
assert.equal(chipLabel("a@b.c"), "a@b.c");

// typing: a `,` typed inside a quoted name / comment / angle address is part of it
assert.ok(openAtEnd('"Doe'));
assert.ok(openAtEnd('Ann (the'));
assert.ok(openAtEnd("Ann <ann@x"));
assert.ok(!openAtEnd('"Doe, John"'));
assert.ok(!openAtEnd("ann@x.test"));
assert.ok(!openAtEnd('"never closed\nb@x.test'), "a quote does not run over a line break");

// IME (CF: Enter that confirms a composition must not make a chip)
assert.ok(isImeEvent({ isComposing: true, key: "Enter", keyCode: 13 }));
assert.ok(isImeEvent({ key: "Enter", keyCode: 229 }), "Safari: composition has ended, keyCode is still 229");
assert.ok(isImeEvent({ key: "Process", keyCode: 229 }));
assert.ok(isImeEvent({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } }), "React synthetic event");
assert.ok(!isImeEvent({ key: "Enter", keyCode: 13, isComposing: false }));
assert.ok(!isImeEvent({ key: ",", keyCode: 188 }));

// duplicates (CF-17): case-insensitive, first spelling kept, also the ones already in the field
assert.deepEqual(addRecipients(["Ann@X.test"], ["ann@x.test", "Bob <bob@y.test>", "BOB@Y.TEST", "ann@x.test"]), ["Ann@X.test", "Bob <bob@y.test>"]);
assert.deepEqual(addRecipients([], ["ann@x.test", "ann@x.test"]), ["ann@x.test"]);
assert.deepEqual(addRecipients(["ann bob"], ["ANN BOB"]), ["ann bob"], "invalid entries too");
assert.equal(recipientKey('"Doe, John" <J@X.com>'), "j@x.com");
// BUG-15 (CF-28): To may be empty when Cc or Bcc has someone; a message with nobody is still refused
assert.ok(hasRecipient({ to: ["a@x.test"], cc: [], bcc: [] }));
assert.ok(hasRecipient({ to: [], cc: ["a@x.test"], bcc: [] }));
assert.ok(hasRecipient({ to: [], cc: [], bcc: ["a@x.test"] }));
assert.ok(!hasRecipient({ to: [], cc: [], bcc: [] }));
// R19A-2: an address lives in ONE field, the first of To, Cc, Bcc that has it
{
  const F = (to = [], cc = [], bcc = []) => ({ to, cc, bcc });
  // adding to Cc what is in To: not added, the note says where it is
  let r = placeRecipients(F(["a@x.test"]), "cc", ["b@x.test", "A@X.test"]);
  assert.deepEqual(r.fields, F(["a@x.test"], ["b@x.test"]));
  assert.deepEqual(r.skipped, [{ addr: "A@X.test", in: "to" }]);
  assert.deepEqual(r.moved, []);
  // Bcc: To wins over Cc wins over Bcc (the earliest field is named)
  r = placeRecipients(F(["a@x.test"], ["c@x.test"]), "bcc", ["c@x.test", "a@x.test", "d@x.test"]);
  assert.deepEqual(r.fields.bcc, ["d@x.test"]);
  assert.deepEqual(r.skipped, [{ addr: "c@x.test", in: "cc" }, { addr: "a@x.test", in: "to" }]);
  // a name in the chip does not make it another person; the note shows the address
  r = placeRecipients(F(["Ann <a@x.test>"]), "cc", ['"Lee, Ann" <A@x.test>']);
  assert.deepEqual(r.fields.cc, []);
  assert.deepEqual(r.skipped, [{ addr: "A@x.test", in: "to" }]);
  // adding to To what is in Cc / Bcc: it moves up, the later field loses it, and it is said
  r = placeRecipients(F([], ["a@x.test", "b@x.test"], ["a@x.test", "c@x.test"]), "to", ["a@x.test"]);
  assert.deepEqual(r.fields, F(["a@x.test"], ["b@x.test"], ["c@x.test"]));
  assert.deepEqual(r.moved, [{ addr: "a@x.test", from: "cc" }, { addr: "a@x.test", from: "bcc" }]);
  assert.deepEqual(r.skipped, []);
  r = placeRecipients(F([], ["a@x.test"], ["a@x.test"]), "cc", ["a@x.test", "z@x.test"]);
  assert.deepEqual(r.fields, F([], ["a@x.test", "z@x.test"], ["a@x.test"]), "an address already in this field stays; Bcc is not touched by a field that was not changed for it");
  // removing a chip and adding nothing new changes nothing else
  r = placeRecipients(F(["a@x.test", "b@x.test"], ["a@x.test"]), "to", ["a@x.test"]);
  assert.deepEqual(r.fields, F(["a@x.test"], ["a@x.test"]));
  assert.deepEqual([r.skipped, r.moved], [[], []]);
  // a paste of several addresses, some known: the others are added in order
  r = placeRecipients(F(["a@x.test"]), "cc", addRecipients([], splitRecipients("b@x.test; a@x.test, c@x.test")));
  assert.deepEqual(r.fields.cc, ["b@x.test", "c@x.test"]);
  assert.equal(r.skipped.length, 1);
}

console.log("recipients: all checks passed");
