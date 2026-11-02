// Checks src/fromAccount.ts: Reply and Forward are written from the account that received the message (QA round 20 Q3).
// Run: node --experimental-strip-types scripts/test-from-account.mjs
import assert from "node:assert/strict";
import { fromAccountFor, replyAccountFor } from "../src/fromAccount.ts";

const accts = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];
// received by a2, default a1: From is a2 (Forward like Reply)
assert.equal(fromAccountFor(accts, "a2", "a1"), "a2");
assert.equal(fromAccountFor(accts, "a3", undefined), "a3");
// a new message: the account the caller names, else the default, else the first
assert.equal(fromAccountFor(accts, undefined, "a2"), "a2");
assert.equal(fromAccountFor(accts, undefined, undefined), "a1");
// the account that received it is gone / cannot send: the default, then the first
assert.equal(fromAccountFor(accts, "zz", "a3"), "a3");
assert.equal(fromAccountFor(accts, "zz", "yy"), "a1");
assert.equal(fromAccountFor(accts.filter((a) => a.id !== "a2"), "a2", "a3"), "a3", "not allowed to send: the default");
// no account at all: what was asked for (Compose does not open without one)
assert.equal(fromAccountFor([], "a2", "a1"), "a2");
assert.equal(fromAccountFor([], undefined, undefined), "");
// 1.0.12 (owner): a message written TO a and copied (Cc) to b sits in both mailboxes; the answer goes out from the address it was written to
const two = [{ id: "a", email: "Nam@Gmail.com" }, { id: "b", email: "thn@gmail.com" }];
const msg = (accountId, to, fromEmail = "x@ext.test") => ({ accountId, fromEmail, to });
const from = (accounts, m, def) => fromAccountFor(accounts, replyAccountFor(accounts, m), def);
assert.equal(from(two, msg("b", "nam@gmail.com"), undefined), "a", "the Cc copy (in b) is answered from the To address a");
assert.equal(from(two, msg("a", "nam@gmail.com"), undefined), "a", "the To copy: the same");
assert.equal(from(two, msg("b", "Nam <NAM@gmail.com>, Bob <bob@ext.test>"), "b"), "a", "a name, other case, other recipients, and the default account b: still a");
assert.equal(from(two, msg("a", "nam@gmail.com, thn@gmail.com"), undefined), "a", "both in To: the opened copy (a)");
assert.equal(from(two, msg("b", "nam@gmail.com, thn@gmail.com"), undefined), "b", "both in To: the opened copy (b)");
assert.equal(from(two, msg("b", "list@ext.test"), "a"), "b", "nobody of mine in To (Cc, list, alias): the mailbox that holds the copy");
assert.equal(from(two, msg("a", ""), undefined), "a", "no To at all: the mailbox that holds the copy");
// a message I sent stays with the sending account, also when it went to my other account
assert.equal(from(two, msg("a", "thn@gmail.com", "nam@gmail.com"), undefined), "a", "sent by a to b: From stays a");
assert.equal(from(two, msg("b", "nam@gmail.com", "thn@gmail.com"), undefined), "b", "sent by b to a: From stays b");
// the To account was removed: the opened copy, else the default, else the first
assert.equal(from([two[1]], msg("b", "nam@gmail.com"), undefined), "b", "the To account is gone: the copy that is left");
assert.equal(from([two[1], { id: "c", email: "c@x.test" }], msg("zz", "nam@gmail.com"), "c"), "c", "gone everywhere: the default");
assert.equal(from([two[1], { id: "c", email: "c@x.test" }], msg("zz", "nam@gmail.com"), undefined), "b", "gone everywhere: the first");
assert.equal(replyAccountFor([], msg("a", "nam@gmail.com")), "a", "no accounts: unchanged");
console.log("test-from-account: ok");
