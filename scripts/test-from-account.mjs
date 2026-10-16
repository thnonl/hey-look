// Checks src/fromAccount.ts: Reply and Forward are written from the account that received the message (QA round 20 Q3).
// Run: node --experimental-strip-types scripts/test-from-account.mjs
import assert from "node:assert/strict";
import { fromAccountFor } from "../src/fromAccount.ts";

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
console.log("test-from-account: ok");
