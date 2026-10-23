// A sent reply flags the original \Answered, a sent forward $Forwarded (1.0.7 W2.22 CF-18). The server side is Rust (`cargo test --lib`:
// a_sent_reply_flags_the_original_answered, a_sent_forward_flags_the_original_forwarded, a_flag_failure_does_not_fail_the_send,
// a_draft_names_the_message_it_answers_and_a_sent_message_does_not); this checks the page: Reply, Reply all and Forward say which message they answer,
// the reference rides with the message through every road it can take (draft, window, Undo, crash snapshot), and only a reference of ours is read back.
// Run: node --experimental-strip-types scripts/test-answers-flag.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeFromSnapshot, draftFromSnapshot, readAnswers } from "../src/recovery.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ok = { kind: "answered", accountId: "acc-1", messageId: "<orig@example.org>" };
assert.deepEqual(readAnswers(ok), ok);
assert.deepEqual(readAnswers({ ...ok, kind: "forwarded" }), { ...ok, kind: "forwarded" });
for (const bad of [null, undefined, "x", 3, {}, { ...ok, kind: "replied" }, { ...ok, accountId: "" }, { ...ok, messageId: "orig@example.org" }, { ...ok, messageId: "<a b@c>" }, { ...ok, messageId: '<a"b@c>' }, { ...ok, accountId: 5 }]) {
  assert.equal(readAnswers(bad), undefined, JSON.stringify(bad));
}
// extra fields of a damaged snapshot are not carried along
assert.deepEqual(readAnswers({ ...ok, evil: "x" }), ok);

// the crash snapshot: the form keeps it and the restored message and its draft have it again
const form = { v: 1, to: ["a@x.test"], cc: [], bcc: [], subject: "Re: hi", html: "<p>hello</p>", inReplyTo: "<orig@example.org>", references: [], replaces: null, isReply: true, encrypt: "off", sign: false, attachKey: false, confidential: false, answers: ok };
const loaded = (f) => ({ id: "s1", accountId: "acc-1", savedAt: 1, payload: JSON.stringify(f), files: [] });
assert.deepEqual(composeFromSnapshot(loaded(form)).answers, ok);
assert.deepEqual(draftFromSnapshot(loaded(form)).answers, ok);
assert.equal(composeFromSnapshot(loaded({ ...form, answers: undefined })).answers, undefined, "a snapshot of an older version has none");
assert.equal(composeFromSnapshot(loaded({ ...form, answers: { kind: "answered" } })).answers, undefined, "a damaged one is ignored, the message still opens");

// the wiring
const actions = read("src/actions.ts");
assert.ok(actions.includes('answers: answersRef("answered", m, h.messageId)'), "Reply and Reply all");
assert.ok(actions.includes('answers: answersRef("forwarded", m, h.messageId)'), "Forward");
assert.ok(/messageId \? \{ kind, accountId: m\.accountId, messageId \} : undefined/.test(actions), "the original's own account, not the account the answer is sent from");
const compose = read("src/components/Compose.tsx");
assert.ok(compose.includes("answers: init.answers,"), "buildDraft carries it (send, schedule, hold, save draft: one object)");
assert.ok(read("src/draftOpen.ts").includes("answers: rc?.answers ?? undefined"), "a saved reply opened from Drafts has it again");
assert.ok(compose.includes("...(init.answers ? { answers: init.answers } : {})"), "the crash snapshot keeps it");
assert.ok(!/answers:\s*undefined/.test(compose), "a window, Undo and a failed send keep it (initOf spreads the init)");
assert.ok(read("src/api.ts").includes("answers?: AnswersRef | null"), "draft_recipients tells the page");
console.log("test-answers-flag: ok");
