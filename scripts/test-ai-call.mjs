// The AI Assistant calls other than the translation: Summarize and Write with AI run in a slot (src/aiCall.ts) that shows a running state,
// can be cancelled (the request is dropped at the backend), ignores a repeated click, and never applies an answer that comes after Cancel.
// Also: which errors earn one more try and the UI's own time limit.
// Run: node --experimental-strip-types scripts/test-ai-call.mjs
import assert from "node:assert/strict";
import { AI_TIMEOUT_MS, aiCallId, createAiSlot, isTransientAiError, requestWithTimeout, timeoutError } from "../src/aiCall.ts";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

/** a fake backend: every request waits for the test to answer it */
function fakeBackend() {
  const b = { calls: [], cancelled: [] };
  b.complete = (system, prompt, id) => new Promise((resolve, reject) => b.calls.push({ system, prompt, id, resolve, reject }));
  b.cancel = (id) => b.cancelled.push(id);
  return b;
}

// 1. ids: one per request, from the kind and the run; a different kind never collides
{
  assert.match(aiCallId("summarize", 3), /^summarize-[a-z0-9]+-3$/);
  assert.match(aiCallId("write", 3), /^write-[a-z0-9]+-3$/);
  assert.notEqual(aiCallId("summarize", 3), aiCallId("write", 3));
  assert.notEqual(aiCallId("summarize", 3), aiCallId("summarize", 4));
  assert.equal(aiCallId("translate", 1, "-2.1").endsWith("-1-2.1"), true);
}

// 2. which errors earn one more try: the connection or the provider failed. Not a timeout, a refusal, a missing setup, a cancel
{
  for (const e of [
    "AI_HTTP|status=500: x", "AI_HTTP|status=503|detail=overloaded: The AI Assistant returned an error (503): overloaded", "AI_HTTP|v=plain|status=502: x",
    "error sending request for url (https://api.example.com/v1/chat/completions)", "error decoding response body", new Error("connection reset"), "",
  ]) assert.equal(isTransientAiError(e), true, String(e));
  for (const e of [
    "AI_HTTP|status=400: x", "AI_HTTP|status=401|detail=bad key: x", "AI_HTTP|status=404: x", "AI_HTTP|status=429|detail=slow down: x", "AI_HTTP|v=plain|status=403: x",
    "AI_TIMEOUT|secs=180: x", "AI_TIMEOUT_TOTAL|mins=15: x", "AI_NOT_CONFIGURED: x", "AI_CANCELLED: x", "AI_BAD_RESPONSE: x", new Error("AI_HTTP|status=422: x"),
  ]) assert.equal(isTransientAiError(e), false, String(e));
}

// 3. a call: running while it waits, the text when it answers, then the slot is free again; a second click meanwhile starts nothing
{
  const b = fakeBackend();
  const slot = createAiSlot(b, "summarize");
  assert.equal(slot.running, false);
  const first = slot.start("sys", "prompt");
  assert.ok(first, "started");
  assert.equal(slot.running, true);
  assert.equal(slot.start("sys", "prompt"), null, "a repeated click does not start a duplicate");
  assert.equal(slot.start("other", "other"), null);
  await tick();
  assert.equal(b.calls.length, 1, "one request");
  assert.deepEqual([b.calls[0].system, b.calls[0].prompt], ["sys", "prompt"]);
  assert.match(b.calls[0].id, /^summarize-/);
  b.calls[0].resolve("the summary");
  assert.deepEqual(await first, { text: "the summary" });
  assert.equal(slot.running, false);
  const second = slot.start("sys", "prompt");
  assert.ok(second, "a new call after the first ended");
  assert.notEqual(await Promise.race([tick(5).then(() => "waiting"), second]), "x");
  b.calls[1].resolve("again");
  assert.deepEqual(await second, { text: "again" });
  assert.notEqual(b.calls[1].id, b.calls[0].id, "every call has its own id");
  assert.deepEqual(b.cancelled, [], "nothing was cancelled");
}

// 4. an error of the backend is the outcome (the screen shows it)
{
  const b = fakeBackend();
  const slot = createAiSlot(b, "write");
  const p = slot.start("s", "p");
  await tick();
  b.calls[0].reject(new Error("AI_HTTP|status=503|detail=overloaded: The AI Assistant returned an error (503): overloaded"));
  const out = await p;
  assert.ok(out && "error" in out);
  assert.match(out.error.message, /^AI_HTTP\|status=503/);
  assert.equal(slot.running, false);
}

// 5. Cancel: the request is dropped at the backend with its own id; the outcome is null; an answer or an error that still comes is ignored
{
  const b = fakeBackend();
  const slot = createAiSlot(b, "write");
  assert.equal(slot.cancel(), false, "nothing to cancel");
  assert.deepEqual(b.cancelled, []);
  const p = slot.start("s", "p");
  await tick();
  const id = b.calls[0].id;
  assert.equal(slot.cancel(), true);
  assert.deepEqual(b.cancelled, [id], "the backend is told to drop exactly that request");
  assert.equal(slot.running, false, "the running state is over at once");
  assert.equal(slot.cancel(), false, "a second Cancel does nothing");
  b.calls[0].resolve("an answer that was already on its way");
  assert.equal(await p, null, "not applied");
  // the dropped request ends with AI_CANCELLED at the backend: that is not an error the person is shown
  const q = slot.start("s", "p");
  await tick();
  assert.equal(slot.cancel(), true);
  b.calls[1].reject(new Error("AI_CANCELLED: The AI Assistant request was cancelled."));
  assert.equal(await q, null);
}

// 6. a new call after Cancel while the old one is still answering: the old answer cannot touch the new call
{
  const b = fakeBackend();
  const slot = createAiSlot(b, "summarize");
  const a = slot.start("s", "p");
  await tick();
  slot.cancel();
  const c = slot.start("s", "p"); // the person clicks again at once
  assert.ok(c, "a call is allowed after Cancel");
  await tick();
  assert.notEqual(b.calls[0].id, b.calls[1].id);
  b.calls[0].resolve("late answer of the cancelled call");
  assert.equal(await a, null);
  assert.equal(slot.running, true, "the new call is still running: the old one did not end it");
  assert.equal(slot.start("s", "p"), null, "and a click still starts nothing");
  b.calls[1].resolve("answer of the new call");
  assert.deepEqual(await c, { text: "answer of the new call" });
  assert.equal(slot.running, false);
}

// 7. the UI's own limit behind the backend's 180 s: the request is dropped and the coded timeout is the error
{
  assert.ok(AI_TIMEOUT_MS > 180_000 && AI_TIMEOUT_MS <= 240_000);
  const e = timeoutError(190_000);
  assert.equal(e.message, "AI_TIMEOUT|secs=190: The AI Assistant didn’t answer within 190 seconds.");
  const b = fakeBackend();
  await assert.rejects(requestWithTimeout(b, "id-1", "s", "p", 30), /^Error: AI_TIMEOUT\|secs=0: /);
  assert.deepEqual(b.cancelled, ["id-1"], "the request is dropped at the backend");
  const slot = createAiSlot(b, "summarize", 1000);
  const p = slot.start("s", "p");
  await tick();
  const out = await p;
  assert.ok(out && "error" in out);
  assert.match(out.error.message, /^AI_TIMEOUT\|secs=1: The AI Assistant didn’t answer within 1 seconds\.$/);
  assert.equal(b.cancelled.at(-1), b.calls.at(-1).id);
  assert.equal(slot.running, false);
  // answering in time clears the timer
  const ok = fakeBackend();
  const fast = requestWithTimeout(ok, "id-2", "s", "p", 50);
  await tick();
  ok.calls[0].resolve("in time");
  assert.equal(await fast, "in time");
  await tick(80);
  assert.deepEqual(ok.cancelled, []);
}

// 8. two slots of one kind (two Compose windows) running at once have different request ids: the backend takes a second call with the
// same id for a restart of the first and would end the first as cancelled
{
  const b = fakeBackend();
  const one = createAiSlot(b, "write");
  const two = createAiSlot(b, "write");
  const p1 = one.start("s", "p");
  const p2 = two.start("s", "p");
  await tick();
  assert.equal(b.calls.length, 2);
  assert.notEqual(b.calls[0].id, b.calls[1].id);
  one.cancel();
  assert.deepEqual(b.cancelled, [b.calls[0].id], "cancelling one leaves the other");
  assert.equal(two.running, true);
  b.calls[1].resolve("two");
  assert.deepEqual(await p2, { text: "two" });
  b.calls[0].resolve("one");
  assert.equal(await p1, null);
}

console.log("ok - test-ai-call");
