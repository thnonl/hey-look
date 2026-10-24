// W8.7 (1.0.7, BA decision: keep): Reply on a conversation answers its NEWEST message, from the ribbon / the `r` key (replyLast) and from the row menu (answer in ListContextMenu.tsx). When that message is the
// person's own, the answer goes to the people it was sent to, Reply all adds that message's Cc only (AC-8.7.1); a forward to a third person that ends the conversation is answered to that person (AC-8.7.2).
// The recipients come from replyTargets with the fields of the chosen message (the same call as replyTo in actions.ts); the choice of the message is pinned in the source.
// Run: node --experimental-strip-types scripts/test-reply-last.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replyTargets } from "../src/replyTargets.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const mine = new Set(["qa@example.test"]);

// ---- AC-8.7.1: Alice -> QA (Cc Bob); QA replies to Alice only. The newest message is QA's own.
const thread1 = [
  { fromEmail: "alice@example.test", to: "qa@example.test", cc: "bob@example.test" },
  { fromEmail: "qa@example.test", to: "alice@example.test", cc: "" },
];
const targets = (msgs, all) => {
  const last = msgs[msgs.length - 1]; // what replyLast and the row menu take
  return replyTargets({ fromEmail: last.fromEmail, to: last.to, cc: last.cc, mine, replyTo: [], all });
};
assert.deepEqual(targets(thread1, false), { to: ["alice@example.test"], cc: [], viaReplyTo: null }, "AC-8.7.1: Reply on a conversation whose newest message is mine goes to Alice");
assert.deepEqual(targets(thread1, true), { to: ["alice@example.test"], cc: [], viaReplyTo: null }, "AC-8.7.1: Reply all: Alice, not Bob (the newest message did not have Bob)");
// the newest message had a Cc: Reply all keeps it
assert.deepEqual(targets([...thread1.slice(0, 1), { fromEmail: "qa@example.test", to: "alice@example.test", cc: "bob@example.test" }], true), { to: ["alice@example.test"], cc: ["bob@example.test"], viaReplyTo: null }, "Reply all adds the Cc of the newest message");

// ---- AC-8.7.2: Alice -> QA; QA forwards it to Carol (same conversation): Reply goes to Carol
const thread2 = [
  { fromEmail: "alice@example.test", to: "qa@example.test", cc: "" },
  { fromEmail: "qa@example.test", to: "carol@example.test", cc: "" },
];
assert.deepEqual(targets(thread2, false).to, ["carol@example.test"], "AC-8.7.2: the newest message is the forward: Reply goes to Carol (recorded as intended)");
assert.deepEqual(targets(thread2, true).to, ["carol@example.test"]);

// ---- the older message is NOT the one answered (the rule would give another result)
assert.deepEqual(replyTargets({ ...thread2[0], mine, replyTo: [], all: false }).to, ["alice@example.test"], "(for contrast) answering the first message would go to Alice");

// ---- source pins: the newest message, in both places; the comment names the rule
const actions = read("../src/actions.ts");
const fn = actions.slice(actions.indexOf("export function replyLast"), actions.indexOf("export function forwardLast"));
assert.match(fn, /const last = st\.messages\[st\.messages\.length - 1\];/, "replyLast answers the newest message");
assert.match(fn, /replyTo\(last,/, "replyLast answers that message");
assert.match(actions, /W8\.7 \(BA decision, 1\.0\.7: keep\)/, "the rule is written down above replyLast");
const menu = read("../src/components/ListContextMenu.tsx");
const answer = menu.slice(menu.indexOf("async function answer("), menu.indexOf("async function copyOf"));
assert.match(answer, /const last = msgs\[msgs\.length - 1\];/, "the row menu answers the newest message");
assert.match(answer, /replyTo\(last, kind === "replyAll", msgs\)/, "and passes the whole conversation");
const reply = read("../src/replyTargets.ts");
assert.match(reply, /const base = fromMe \? origTo : asked\.length \? asked : \[sender\];/, "a message of mine: the people it was sent to");
assert.match(reply, /W8\.6 \(owner decision 2026-10-18, 1\.0\.7 W8\.6: keep\)/, "W8.6 is written down above `asked`");
console.log("ok - test-reply-last");
