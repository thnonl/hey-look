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

// the fallback when the headers cannot be read: the ids of the thread, then the message
assert.deepEqual(fallbackReferences(["<a@x>", null, "<b@x>"], "<b@x>"), ["<a@x>", "<b@x>"]);
assert.deepEqual(fallbackReferences([], "<b@x>"), ["<b@x>"]);
assert.deepEqual(fallbackReferences([], null), []);
console.log("reply-targets: all checks passed");
