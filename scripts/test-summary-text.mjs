// What Summarize sends, and whether anything was cut (v1.0.6 QA round 3, observation O-1: the Summarize card said nothing about a conversation that was
// cut, Translate said "Only the first 60,000 characters were translated"). Behaviour of src/summaryText.ts.
// Run: node --experimental-strip-types scripts/test-summary-text.mjs
import assert from "node:assert/strict";
import { SUMMARY_PER_MESSAGE, SUMMARY_TOTAL, summaryBody } from "../src/summaryText.ts";

const m = (n, head = "From: a") => ({ head, text: "x".repeat(n) });
// nothing cut
let r = summaryBody([m(100), m(200)]);
assert.equal(r.cut, false);
assert.equal(r.body, `From: a\n\n${"x".repeat(100)}\n\n-----\n\nFrom: a\n\n${"x".repeat(200)}`);
// exactly at the limit of a message: not cut; one more: cut, and the text is the first 4,000
assert.equal(summaryBody([m(SUMMARY_PER_MESSAGE)]).cut, false);
r = summaryBody([m(SUMMARY_PER_MESSAGE + 1)]);
assert.equal(r.cut, true);
assert.equal(r.body.length, "From: a\n\n".length + SUMMARY_PER_MESSAGE);
// many messages that are each short but together past 24,000: cut at 24,000
r = summaryBody(Array.from({ length: 12 }, () => m(3000)));
assert.equal(r.cut, true);
assert.equal(r.body.length, SUMMARY_TOTAL);
// the same without the text going past the total: not cut
assert.equal(summaryBody(Array.from({ length: 5 }, () => m(3000))).cut, false);
// no messages
assert.deepEqual(summaryBody([]), { body: "", cut: false });
console.log("test-summary-text: ok");
