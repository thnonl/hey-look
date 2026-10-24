// Checks src/replyTargets.ts: who Reply / Reply all go to (Reply-To, From, the original To / Cc), without your own addresses and without
// duplicates. Run: node --experimental-strip-types scripts/test-reply-targets.mjs
import assert from "node:assert/strict";
import { fallbackReferences, replyTargets } from "../src/replyTargets.ts";

const mine = new Set(["me@example.com", "me@gmail.com"]);
const base = { fromEmail: "x@ext.test", to: "me@example.com,y@ext.test", cc: "z@ext.test", mine, replyTo: [], all: false };
const go = (o) => replyTargets({ ...base, ...o });

// A-04: Reply goes to the sender
assert.deepEqual(go({}), { to: ["x@ext.test"], cc: [], viaReplyTo: null });

// A-05 (a): Reply all = From + To + Cc without me, no duplicates
assert.deepEqual(go({ all: true }), { to: ["x@ext.test", "y@ext.test"], cc: ["z@ext.test"], viaReplyTo: null });
// (b) to my own sent mail: the people I wrote to
assert.deepEqual(go({ fromEmail: "me@example.com", to: "a@ext.test,b@ext.test", cc: "c@ext.test" }), { to: ["a@ext.test", "b@ext.test"], cc: [], viaReplyTo: null });
assert.deepEqual(go({ fromEmail: "me@example.com", to: "a@ext.test,b@ext.test", cc: "c@ext.test", all: true }), { to: ["a@ext.test", "b@ext.test"], cc: ["c@ext.test"], viaReplyTo: null });
// (c) a quoted name in To
assert.deepEqual(go({ to: '"Doe, John" <j@x.test>, me@example.com', all: true }).to, ["x@ext.test", '"Doe, John" <j@x.test>']);

// BUG-07 / A-06: Reply-To wins over From (lists, no-reply senders)
const viaList = go({ fromEmail: "no-reply@ext.test", replyTo: ["Help Desk <help@ext.test>"] });
assert.deepEqual(viaList.to, ["Help Desk <help@ext.test>"]);
assert.deepEqual(viaList.viaReplyTo, { replyTo: ["Help Desk <help@ext.test>"], from: "no-reply@ext.test" }, "Compose says where the answer goes");
// several Reply-To addresses: all of them
assert.deepEqual(go({ replyTo: ["a@ext.test", "b@ext.test"] }).to, ["a@ext.test", "b@ext.test"]);
// Reply all: Reply-To, the original From, the original To / Cc minus mine, each once
const all = go({ fromEmail: "no-reply@ext.test", replyTo: ["help@ext.test"], to: "me@example.com, HELP@ext.test, y@ext.test", cc: "z@ext.test, Y@EXT.test, me@gmail.com", all: true });
assert.deepEqual(all.to, ["help@ext.test", "no-reply@ext.test", "y@ext.test"], "case-insensitive duplicates go, the first spelling stays");
assert.deepEqual(all.cc, ["z@ext.test"], "none of my addresses, nothing that is already in To");
// Reply-To that is the same address as From: no note
assert.equal(go({ replyTo: ["X@ext.test"] }).viaReplyTo, null);
assert.deepEqual(go({ replyTo: ["Xavier <X@ext.test>"] }).to, ["Xavier <X@ext.test>"]);
// a Reply-To that is one of my own addresses (a list that reflects my mail) is not used
assert.deepEqual(go({ replyTo: ["me@example.com"] }), { to: ["x@ext.test"], cc: [], viaReplyTo: null });
// on my own mail Reply-To is ignored
assert.deepEqual(go({ fromEmail: "me@gmail.com", to: "a@ext.test", replyTo: ["other@ext.test"] }).to, ["a@ext.test"]);
// nothing usable left: To is empty (Compose opens with an empty To)
assert.deepEqual(go({ fromEmail: "me@example.com", to: "me@gmail.com" }).to, []);

// Reply all with a Reply-To header (Mac QA 19A): the Reply-To address (valid, not mine) + the original From (when different) + the original To / Cc
// without my addresses, each once (upper / lower case alike); plain Reply stays Reply-To only
{
  const o = { fromEmail: "news@list.test", replyTo: ["Desk <desk@list.test>"], to: "me@example.com, a@ext.test", cc: "desk@LIST.test, b@ext.test, me@gmail.com" };
  assert.deepEqual(go({ ...o, all: false }).to, ["Desk <desk@list.test>"], "Reply: the Reply-To address only");
  assert.deepEqual(go({ ...o, all: false }).cc, []);
  const r = go({ ...o, all: true });
  assert.deepEqual(r.to, ["Desk <desk@list.test>", "news@list.test", "a@ext.test"], "Reply all: Reply-To, From, original To");
  assert.deepEqual(r.cc, ["b@ext.test"], "the Reply-To address that was also in Cc is in To only; mine are gone");
  assert.deepEqual(r.viaReplyTo, { replyTo: ["Desk <desk@list.test>"], from: "news@list.test" });
  // an invalid or my own Reply-To is not added: Reply all = From + To + Cc as before
  assert.deepEqual(go({ ...o, replyTo: [], all: true }).to, ["news@list.test", "a@ext.test"]);
  assert.deepEqual(go({ ...o, replyTo: ["me@example.com"], all: true }).to, ["news@list.test", "a@ext.test"]);
  // Reply-To equal to From: once
  assert.deepEqual(go({ ...o, replyTo: ["NEWS@list.test"], all: true }).to, ["NEWS@list.test", "a@ext.test"]);
}

// Mac QA round 20: a Reply-To that is one of the person's OWN accounts is not answered to (replyTargets.ts: `own`, the `asked` filter) - the probe
// with Reply-To qa2 looked like a lost Reply-To because qa2 was a second account of that profile. Several addresses: every non-own one stays, in order.
{
  const mine2 = new Set(["qa1@test.local", "qa2@test.local"]);
  const q = (o) => replyTargets({ fromEmail: "sender@test.local", to: "qa1@test.local", cc: "cc2@test.local,qa1@test.local", mine: mine2, replyTo: [], all: false, ...o });
  // Reply-To is an address that is not an account: Reply goes there, with the note; Reply all adds the sender and the others
  const ok = q({ replyTo: ["RC ReplyTo <qa9@test.local>"] });
  assert.deepEqual(ok.to, ["RC ReplyTo <qa9@test.local>"]);
  assert.deepEqual(ok.viaReplyTo, { replyTo: ["RC ReplyTo <qa9@test.local>"], from: "sender@test.local" });
  assert.deepEqual(q({ replyTo: ["RC ReplyTo <qa9@test.local>"], all: true }).to, ["RC ReplyTo <qa9@test.local>", "sender@test.local"]);
  // Reply-To is my own second account (qa2): it is dropped, the answer goes to the sender, no note
  const own = q({ replyTo: ["RC ReplyTo <qa2@test.local>"] });
  // (W8.6, owner decision 2026-10-18: keep - a Reply-To that is one of my own accounts is dropped; change these on purpose only)
  assert.deepEqual(own.to, ["sender@test.local"], "W8.6: a Reply-To that is my own account is dropped and the answer goes to the sender");
  assert.equal(own.viaReplyTo, null, "W8.6: and there is no Reply-To note");
  const ownAll = q({ replyTo: ["RC ReplyTo <qa2@test.local>"], all: true });
  assert.deepEqual([ownAll.to, ownAll.cc], [["sender@test.local"], ["cc2@test.local"]], "W8.6: the same for Reply all");
  // AC-8.6.1: own + another address: the other one only, and the note names it
  const mixed = q({ replyTo: ["qa2@test.local", "y@example.test"] });
  assert.deepEqual(mixed.to, ["y@example.test"], "W8.6: own + y@example.test: To y@example.test");
  assert.deepEqual(mixed.viaReplyTo, { replyTo: ["y@example.test"], from: "sender@test.local" }, "W8.6: the note names y@example.test");
  // two Reply-To addresses, one of them mine: only the other one (what Mac QA saw: "Replies go to qa3")
  const two = q({ replyTo: ["qa2@test.local", "qa3@test.local"] });
  assert.deepEqual(two.to, ["qa3@test.local"]);
  assert.deepEqual(two.viaReplyTo, { replyTo: ["qa3@test.local"], from: "sender@test.local" });
  // several addresses that are not mine: all of them, in the order of the header, and the note lists all of them
  const many = q({ replyTo: ["a@x.test", "B <b@x.test>", "c@x.test"], all: true });
  assert.deepEqual(many.to, ["a@x.test", "B <b@x.test>", "c@x.test", "sender@test.local"]);
  assert.deepEqual(many.viaReplyTo.replyTo, ["a@x.test", "B <b@x.test>", "c@x.test"]);
}

// QA 19A R19A-1: display names stay (the stored To / Cc keep bare addresses; the headers of the message carry the names)
const named = go({
  fromEmail: "john@x.test", fromName: "Doe, John", to: "me@example.com,ann@x.test", cc: "z@ext.test", all: true,
  headerFrom: '"Doe, John" <john@x.test>', headerTo: ["me@example.com", '"Lee, Ann" <ann@x.test>'], headerCc: ['"Zed Z" <z@ext.test>'],
});
assert.deepEqual(named.to, ['"Doe, John" <john@x.test>', '"Lee, Ann" <ann@x.test>'], "the quoted names are kept in To");
assert.deepEqual(named.cc, ['"Zed Z" <z@ext.test>'], "and in Cc");
// plain Reply: the sender keeps the name (from the header, else from the stored name)
assert.deepEqual(go({ fromEmail: "john@x.test", fromName: "Doe, John", headerFrom: '"Doe, John" <john@x.test>' }).to, ['"Doe, John" <john@x.test>']);
assert.deepEqual(go({ fromEmail: "john@x.test", fromName: "Doe, John" }).to, ['"Doe, John" <john@x.test>'], "no headers: the stored name");
assert.deepEqual(go({ fromEmail: "john@x.test", fromName: "John Doe" }).to, ["John Doe <john@x.test>"]);
assert.deepEqual(go({ fromEmail: "john@x.test", fromName: "john@x.test" }).to, ["john@x.test"], "a name that only repeats the address is no name");
assert.deepEqual(go({ fromEmail: "john@x.test", fromName: "" }).to, ["john@x.test"]);
// a header From of another address is not used for the sender
assert.deepEqual(go({ fromEmail: "john@x.test", headerFrom: "Other <other@x.test>" }).to, ["john@x.test"]);
// my own sent message: the people I wrote to, with their names
assert.deepEqual(go({ fromEmail: "me@example.com", to: "a@ext.test", headerTo: ['"Doe, John" <a@ext.test>'], all: false }).to, ['"Doe, John" <a@ext.test>']);
// the same person in To (with a name) and Cc (bare): once, the first spelling, never in both lists
const both = go({ all: true, headerTo: ["me@example.com", '"Doe, John" <j@x.test>'], headerCc: ["J@X.test", "k@x.test"], to: "me@example.com,j@x.test", cc: "j@x.test,k@x.test" });
assert.deepEqual(both.to, ["x@ext.test", '"Doe, John" <j@x.test>']);
assert.deepEqual(both.cc, ["k@x.test"]);
// headers that could not be read (empty lists): the stored addresses
assert.deepEqual(go({ all: true, headerTo: [], headerCc: [], headerFrom: null }), { to: ["x@ext.test", "y@ext.test"], cc: ["z@ext.test"], viaReplyTo: null });

// the fallback when the headers cannot be read: the ids of the thread, then the message
assert.deepEqual(fallbackReferences(["<a@x>", null, "<b@x>"], "<b@x>"), ["<a@x>", "<b@x>"]);
assert.deepEqual(fallbackReferences([], "<b@x>"), ["<b@x>"]);
assert.deepEqual(fallbackReferences([], null), []);
console.log("reply-targets: all checks passed");
