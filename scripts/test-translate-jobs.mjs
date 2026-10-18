// F-19: translation jobs of messages (src/translateJobs.ts): start, finish, fail, cancel, switching to another mail and back, a second
// start ignored, an answer that comes after a cancel ignored, the toast rules, the hard timeout. A long mail is translated in parts
// (sections 15-21): success in order, a part that fails and the retry that goes on from it, cancel stopping the rest, the automatic second
// try, the total time, and the runner (src/translateRun.ts) with fake requests.
// Run: node --experimental-strip-types scripts/test-translate-jobs.mjs
import assert from "node:assert/strict";
import {
  cancelJob, closeToast, elapsedLabel, failJob, finishJob, jobFor, jobKey, MAX_FINISHED, removeJob, settleToast, slowHint, SLOW_HINT_MS,
  startJob, TRANSLATE_TIMEOUT_MS, withTimeout, aiJobId, nextPart, partDone, partPrompt, totalTimeoutError, RETRY_DELAY_MS, TRANSLATE_TOTAL_MS,
} from "../src/translateJobs.ts";
import { runParts } from "../src/translateRun.ts";

const spec = (messageId, lang = "German", extra = {}) => ({
  messageId, threadId: `t-${messageId}`, folder: "inbox", accountId: "a1", subject: `Subject ${messageId}`, lang, langKey: `reading.lang.${lang.toLowerCase()}`, text: "Hello", ...extra,
});
let run = 0;
const start = (jobs, s, now = 1000) => startJob(jobs, s, now, ++run);

// 1. start: a running job, keyed by message and language
{
  const r = start({}, spec("m1"));
  assert.equal(r.start, true);
  const j = r.jobs[r.key];
  assert.equal(j.status, "running");
  assert.equal(j.key, jobKey("m1", "German"));
  assert.equal(j.startedAt, 1000);
  assert.equal(j.toastClosed, false);
  assert.equal(jobFor(r.jobs, "m1")?.key, r.key);
  assert.equal(jobFor(r.jobs, "other"), undefined);
}

// 2. a second start of the same message + language is ignored (running); another language or message is a job of its own
{
  const a = start({}, spec("m1"));
  const b = start(a.jobs, spec("m1"));
  assert.equal(b.start, false);
  assert.equal(b.jobs, a.jobs, "state untouched");
  const c = start(b.jobs, spec("m1", "French"));
  assert.equal(c.start, true);
  const d = start(c.jobs, spec("m2"));
  assert.equal(d.start, true);
  assert.equal(Object.keys(d.jobs).length, 3);
}

// 3. finish: the result is kept (cache); starting again shows it and does not request again
{
  const a = start({}, spec("m1"));
  const run1 = a.jobs[a.key].run;
  const f = finishJob(a.jobs, a.key, run1, "Hallo");
  assert.equal(f.applied, true);
  assert.equal(f.jobs[a.key].status, "done");
  assert.equal(f.jobs[a.key].result, "Hallo");
  const again = start(f.jobs, spec("m1"));
  assert.equal(again.start, false, "cached: no new request");
  assert.equal(again.jobs[a.key].result, "Hallo");
  // a finished job does not finish twice
  assert.equal(finishJob(f.jobs, a.key, run1, "other").applied, false);
}

// 4. fail: the error is kept for the box; Retry (start again) runs a new request with a new run number; the old run is ignored
{
  const a = start({}, spec("m1"));
  const run1 = a.jobs[a.key].run;
  const f = failJob(a.jobs, a.key, run1, "The AI Assistant didn’t answer.");
  assert.equal(f.applied, true);
  assert.equal(f.jobs[a.key].status, "failed");
  assert.equal(f.jobs[a.key].error, "The AI Assistant didn’t answer.");
  const retry = start(f.jobs, spec("m1"));
  assert.equal(retry.start, true);
  const j = retry.jobs[a.key];
  assert.equal(j.status, "running");
  assert.equal(j.error, undefined);
  assert.notEqual(j.run, run1);
  assert.equal(finishJob(retry.jobs, a.key, run1, "late answer of the first try").applied, false, "the first try's answer is stale");
  assert.equal(finishJob(retry.jobs, a.key, j.run, "ok").applied, true);
}

// 5. cancel: the job is gone; an answer or an error that still comes is ignored; a later start works
{
  const a = start({}, spec("m1"));
  const run1 = a.jobs[a.key].run;
  const jobs = cancelJob(a.jobs, a.key);
  assert.equal(jobFor(jobs, "m1"), undefined);
  assert.equal(finishJob(jobs, a.key, run1, "late").applied, false);
  assert.equal(failJob(jobs, a.key, run1, "late error").applied, false);
  assert.deepEqual(jobs, {});
  const b = start(jobs, spec("m1"));
  assert.equal(b.start, true);
  assert.equal(finishJob(b.jobs, a.key, run1, "the cancelled one's answer").applied, false, "not even after a new start");
  // cancel only touches a running job
  const done = finishJob(b.jobs, a.key, b.jobs[a.key].run, "x").jobs;
  assert.equal(cancelJob(done, a.key), done);
  assert.equal(cancelJob({}, "nope").constructor, Object);
}

// 6. switch away and return: the job is per message, not per pane; what the pane shows for a message comes from the jobs alone
{
  let jobs = start({}, spec("m1")).jobs;
  jobs = start(jobs, spec("m2")).jobs; // the person opens another mail and translates that too
  assert.equal(jobFor(jobs, "m1")?.status, "running", "back on m1: the progress is there");
  const k1 = jobKey("m1", "German");
  jobs = finishJob(jobs, k1, jobs[k1].run, "Hallo m1").jobs; // finished while the person was elsewhere
  assert.equal(jobFor(jobs, "m1")?.result, "Hallo m1", "back on m1: the translation is there");
  assert.equal(jobFor(jobs, "m2")?.status, "running", "m2 still running");
  // several languages of one mail: a running one wins, else the newest
  jobs = start(jobs, spec("m1", "French")).jobs;
  assert.equal(jobFor(jobs, "m1")?.lang, "French");
  const kf = jobKey("m1", "French");
  jobs = finishJob(jobs, kf, jobs[kf].run, "Bonjour").jobs;
  assert.equal(jobFor(jobs, "m1")?.lang, "French", "newest finished");
  jobs = start(jobs, spec("m1", "German")).jobs; // the cached German one is asked for again: shown, newest
  assert.equal(jobFor(jobs, "m1")?.lang, "German");
}

// 7. hide translation / dismiss: finished and failed jobs go; a running one is not removed that way
{
  const a = start({}, spec("m1"));
  assert.equal(removeJob(a.jobs, a.key), a.jobs, "running: use cancel");
  const f = finishJob(a.jobs, a.key, a.jobs[a.key].run, "x").jobs;
  assert.deepEqual(removeJob(f, a.key), {});
  const e = failJob(a.jobs, a.key, a.jobs[a.key].run, "boom").jobs;
  assert.deepEqual(removeJob(e, a.key), {});
}

// 8. closing the toast only marks the job; it goes on
{
  const a = start({}, spec("m1"));
  const jobs = closeToast(a.jobs, a.key);
  assert.equal(jobs[a.key].toastClosed, true);
  assert.equal(jobs[a.key].status, "running");
  assert.equal(closeToast(jobs, a.key), jobs, "twice: unchanged");
  assert.equal(closeToast({}, "nope").constructor, Object);
}

// 9. what the toast does when the job ends
{
  assert.equal(settleToast("done", true, false), "close", "looking at that mail: the toast just closes");
  assert.equal(settleToast("done", true, true), "close");
  assert.equal(settleToast("done", false, false), "ready", "elsewhere: Translation ready + Show");
  assert.equal(settleToast("done", false, true), "ready", "even after the running toast was closed by hand");
  assert.equal(settleToast("failed", true, false), "error", "the toast becomes the error with Retry");
  assert.equal(settleToast("failed", false, false), "error");
  assert.equal(settleToast("failed", false, true), "none", "toast closed by hand: the box in the mail has the error");
}

// 10. finished translations are capped; the oldest go first, a running job never
{
  let jobs = start({}, spec("running")).jobs;
  for (let i = 0; i < MAX_FINISHED + 5; i++) {
    const r = start(jobs, spec(`d${i}`));
    jobs = finishJob(r.jobs, r.key, r.jobs[r.key].run, `t${i}`).jobs;
  }
  const done = Object.values(jobs).filter((j) => j.status === "done");
  assert.equal(done.length, MAX_FINISHED);
  assert.ok(!jobs[jobKey("d0", "German")], "oldest dropped");
  assert.ok(jobs[jobKey(`d${MAX_FINISHED + 4}`, "German")], "newest kept");
  assert.equal(jobs[jobKey("running", "German")].status, "running");
}

// 11. the hint after 5 s, the elapsed label
{
  assert.equal(SLOW_HINT_MS, 5000);
  assert.equal(slowHint(1000, 1000 + 4999), false);
  assert.equal(slowHint(1000, 1000 + 5000), true);
  assert.equal(elapsedLabel(0), "0:00");
  assert.equal(elapsedLabel(7400), "0:07");
  assert.equal(elapsedLabel(65_000), "1:05");
  assert.equal(elapsedLabel(-5), "0:00");
}

// 12. the hard timeout: never a spinner for ever. The backend gives up at 180 s; the UI's own limit is behind it
{
  assert.ok(TRANSLATE_TIMEOUT_MS > 180_000, "the backend's coded error comes first");
  assert.ok(TRANSLATE_TIMEOUT_MS <= 240_000);
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 30, () => new Error("AI_TIMEOUT")), /AI_TIMEOUT/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, () => new Error("late")), "ok");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000, () => new Error("late")), /boom/);
  // a slow answer after the timeout does not reject twice or throw
  let resolveLate;
  const late = new Promise((r) => (resolveLate = r));
  await assert.rejects(withTimeout(late, 20, () => new Error("t")), /t/);
  resolveLate("too late");
  await new Promise((r) => setTimeout(r, 30));
}

// 13. the id of the backend request: one per start, so Cancel / the timeout drop exactly the request of that start (a Retry has its own)
{
  const a = start({}, spec("m1"));
  const first = a.jobs[a.key].run;
  const ids = new Set([aiJobId(first), aiJobId(first + 1), aiJobId(first + 2)]);
  assert.equal(ids.size, 3, "every start has its own id");
  assert.equal(aiJobId(first), aiJobId(first), "the same start always gives the same id (Cancel finds it)");
  assert.match(aiJobId(first), /^translate-[a-z0-9]+-\d+$/);
  // a cancelled job's request is dropped; the answer that still comes (an error from the backend, or a late result) is ignored
  const cancelled = cancelJob(a.jobs, a.key);
  assert.equal(failJob(cancelled, a.key, first, "AI_CANCELLED").applied, false);
  assert.equal(finishJob(cancelled, a.key, first, "late").applied, false);
  // Retry after a failure: new run, the old run's late answer is ignored
  const f = failJob(a.jobs, a.key, first, "boom").jobs;
  const retry = start(f, spec("m1"));
  assert.equal(retry.start, true);
  const second = retry.jobs[a.key].run;
  assert.notEqual(aiJobId(second), aiJobId(first));
  assert.equal(finishJob(retry.jobs, a.key, first, "stale").applied, false);
}

// 14. the error keeps what it came from, so it can be written again in another language; a retry / success clears it
{
  const a = start({}, spec("m1"));
  const r1 = a.jobs[a.key].run;
  const f = failJob(a.jobs, a.key, r1, "The AI Assistant didn’t answer within 180 seconds.", "AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.");
  assert.equal(f.jobs[a.key].errorSource, "AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.");
  const retry = start(f.jobs, f.jobs[a.key]); // Retry passes the failed job as the spec
  const r2 = retry.jobs[a.key].run;
  const ok = finishJob(retry.jobs, a.key, r2, "Hallo");
  assert.equal(ok.jobs[a.key].error, undefined);
  assert.equal(ok.jobs[a.key].errorSource, undefined);
  // a failure without a source (older callers) still works
  assert.equal(failJob(a.jobs, a.key, r1, "boom").jobs[a.key].errorSource, undefined);
}

// ---- a long mail, in parts -------------------------------------------------------------------------------------------------------------

/** three paragraphs of 7,000 characters: one part each (a second paragraph does not fit with the first) */
const LONG = ["P1", "P2", "P3"].map((p) => `${p} ${"w".repeat(6990)}`).join("\n\n");
const longSpec = (messageId = "L1", extra = {}) => spec(messageId, "German", { text: LONG, ...extra });

// 15. a start cuts the text into parts; a short mail is one part
{
  const a = start({}, longSpec());
  const j = a.jobs[a.key];
  assert.equal(j.parts.length, 3);
  assert.deepEqual(j.parts.map((p) => p.slice(0, 2)), ["P1", "P2", "P3"]);
  assert.deepEqual(j.seps, ["\n\n", "\n\n"]);
  assert.deepEqual(j.translated, []);
  assert.equal(j.truncated, false);
  assert.deepEqual({ ...nextPart(j), text: nextPart(j).text.slice(0, 2) }, { index: 0, total: 3, text: "P1" });
  const one = start({}, spec("short")).jobs[jobKey("short", "German")];
  assert.deepEqual(one.parts, ["Hello"]);
  assert.equal(partPrompt("German", 0, 1), "Translate the email into German. Output only the translation, keep the formatting and line breaks.", "one part: the prompt of the earlier versions");
  assert.match(partPrompt("German", 1, 3), /^Translate the email into German\. Output only the translation, keep the formatting and line breaks\. .*part 2\./);
  assert.match(partPrompt("German", 1, 3), /sent in 3 parts/);
}

// 16. the parts come back one by one, in order; the last one finishes the job with the pieces put together; wrong or late answers are ignored
{
  const a = start({}, longSpec());
  const r = a.jobs[a.key].run;
  let jobs = a.jobs;
  assert.equal(partDone(jobs, a.key, r + 99, "x").applied, false, "another start's answer");
  const p1 = partDone(jobs, a.key, r, "Eins");
  assert.deepEqual([p1.applied, p1.done], [true, false]);
  jobs = p1.jobs;
  assert.equal(jobs[a.key].status, "running");
  assert.deepEqual(jobs[a.key].translated, ["Eins"]);
  assert.equal(nextPart(jobs[a.key]).index, 1);
  const p2 = partDone(jobs, a.key, r, "Zwei");
  jobs = p2.jobs;
  assert.equal(nextPart(jobs[a.key]).index, 2);
  const p3 = partDone(jobs, a.key, r, "Drei\n");
  assert.deepEqual([p3.applied, p3.done], [true, true]);
  assert.equal(p3.jobs[a.key].status, "done");
  assert.equal(p3.jobs[a.key].result, "Eins\n\nZwei\n\nDrei", "the original layout between the parts");
  assert.equal(partDone(p3.jobs, a.key, r, "again").applied, false, "a finished job takes no more");
  // dedupe per message + language still holds: running -> ignored, done -> shown again, no request
  assert.equal(start(a.jobs, longSpec()).start, false);
  assert.equal(start(p3.jobs, longSpec()).start, false);
  assert.equal(start(p3.jobs, longSpec("L1", { lang: "French" })).start, true, "another language is its own job");
}

// 17. a part fails: the parts done are kept, Retry goes on from the failed one, the late answer of the old start is ignored
{
  const a = start({}, longSpec());
  const r1 = a.jobs[a.key].run;
  let jobs = partDone(a.jobs, a.key, r1, "Eins").jobs;
  jobs = failJob(jobs, a.key, r1, "boom", "AI_HTTP|status=503: x").jobs;
  assert.equal(jobs[a.key].status, "failed");
  assert.deepEqual(jobs[a.key].translated, ["Eins"], "part 1 is kept");
  const retry = start(jobs, jobs[a.key]); // Retry passes the failed job as the spec
  assert.equal(retry.start, true);
  const j = retry.jobs[a.key];
  assert.equal(j.status, "running");
  assert.deepEqual(j.translated, ["Eins"], "not redone");
  assert.equal(nextPart(j).index, 1, "goes on with part 2");
  assert.equal(j.error, undefined);
  assert.equal(j.errorSource, undefined);
  assert.notEqual(j.run, r1);
  assert.equal(partDone(retry.jobs, a.key, r1, "late").applied, false, "the failed start's late answer");
  let jobs2 = partDone(retry.jobs, a.key, j.run, "Zwei").jobs;
  jobs2 = partDone(jobs2, a.key, j.run, "Drei").jobs;
  assert.equal(jobs2[a.key].result, "Eins\n\nZwei\n\nDrei");
  // another text (the mail changed) starts over; so does a job that was dismissed
  const changed = start(jobs, { ...jobs[a.key], text: LONG + " more" });
  assert.deepEqual(changed.jobs[a.key].translated, []);
  assert.deepEqual(start(removeJob(jobs, a.key), longSpec()).jobs[a.key].translated, []);
}

// 18. cancel: the job is gone, nothing of it applies, and the next start is from part 1
{
  const a = start({}, longSpec());
  const r = a.jobs[a.key].run;
  const jobs = partDone(a.jobs, a.key, r, "Eins").jobs;
  const cancelled = cancelJob(jobs, a.key);
  assert.deepEqual(cancelled, {});
  assert.equal(partDone(cancelled, a.key, r, "Zwei").applied, false);
  assert.equal(failJob(cancelled, a.key, r, "AI_CANCELLED").applied, false);
  const again = start(cancelled, longSpec());
  assert.deepEqual(again.jobs[a.key].translated, [], "from part 1");
  assert.equal(partDone(again.jobs, a.key, r, "stale").applied, false);
}

// 19. ids: one request per part and per automatic second try, so Cancel and the timeout drop exactly that request
{
  const ids = new Set([aiJobId(5, 0), aiJobId(5, 1), aiJobId(5, 1, 1), aiJobId(5), aiJobId(6, 1)]);
  assert.equal(ids.size, 5);
  assert.match(aiJobId(5, 1), /^translate-[a-z0-9]+-5-1$/);
  assert.match(aiJobId(5, 1, 1), /^translate-[a-z0-9]+-5-1\.1$/);
  assert.match(aiJobId(5), /^translate-[a-z0-9]+-5$/, "without a part: as in the earlier versions");
}

// 20. the total time, and the cap
{
  assert.ok(TRANSLATE_TOTAL_MS > TRANSLATE_TIMEOUT_MS, "longer than one request");
  assert.ok(TRANSLATE_TOTAL_MS >= 5 * 180_000, "five requests at the full 180 s fit");
  assert.ok(TRANSLATE_TOTAL_MS <= 30 * 60_000, "a spinner never runs for hours");
  assert.equal(RETRY_DELAY_MS, 1500);
  assert.match(totalTimeoutError().message, /^AI_TIMEOUT_TOTAL\|mins=15: /);
  const big = start({}, spec("big", "German", { text: "paragraph. ".repeat(10000) })).jobs[jobKey("big", "German")];
  assert.equal(big.truncated, true, "110,000 characters: the first 60,000 are translated");
  assert.ok(big.parts.length >= 8 && big.parts.length <= 9);
  const retry = start(failJob({ [big.key]: big }, big.key, big.run, "x").jobs, big);
  assert.equal(retry.jobs[big.key].truncated, true, "a retry keeps the notice");
}

// ---- the runner, with fake requests ----------------------------------------------------------------------------------------------------

/**
 * Drives runParts the way src/translate.ts does, with a store of one job and a model that is a function of (part number, try).
 * `answer(info)` returns a string, throws, or returns a promise (to hold a request open).
 */
function harness(answer, text = LONG) {
  const a = start({}, longSpec("R" + ++run, { text }));
  const key = a.key;
  const h = { jobs: a.jobs, key, run: a.jobs[key].run, requests: [], aborted: [], sleeps: [], inFlight: null, open: 0, maxOpen: 0, clock: 0, tries: new Map() };
  h.deps = {
    job: () => (h.jobs[key]?.run === h.run ? h.jobs[key] : undefined),
    complete: async (system, prompt, id) => {
      const part = Number(/this is part (\d+)\./.exec(system)?.[1] ?? 1);
      const attempt = (h.tries.get(part) ?? 0) + 1;
      h.tries.set(part, attempt);
      h.requests.push({ id, part, attempt, text: prompt });
      h.open++;
      h.maxOpen = Math.max(h.maxOpen, h.open);
      try {
        return await answer({ part, attempt, id, prompt });
      } finally {
        h.open--;
      }
    },
    abort: (id) => h.aborted.push(id),
    flying: (id) => (h.inFlight = id),
    settle: (o) => {
      const msg = o.error instanceof Error ? o.error.message : String(o.error);
      const res = "part" in o ? partDone(h.jobs, key, h.run, o.part) : failJob(h.jobs, key, h.run, msg, msg);
      if (!res.applied) return false;
      h.jobs = res.jobs;
      return h.jobs[key].status === "running";
    },
    now: () => h.clock,
    sleep: async (ms) => void h.sleeps.push(ms),
  };
  h.go = (deps = {}) => runParts(h.run, { ...h.deps, ...deps });
  return h;
}
const ok = ({ part }) => `T${part}`;
const tick = () => new Promise((r) => setTimeout(r, 1));

// 21a. success: three requests, one at a time, in order, each with its own id and the text of its part
{
  const h = harness(ok);
  await h.go();
  assert.deepEqual(h.requests.map((q) => q.part), [1, 2, 3]);
  assert.deepEqual(h.requests.map((q) => q.text.slice(0, 2)), ["P1", "P2", "P3"]);
  assert.equal(h.maxOpen, 1, "never two requests at once: the order is the order of the parts");
  assert.equal(new Set(h.requests.map((q) => q.id)).size, 3);
  assert.equal(h.jobs[h.key].status, "done");
  assert.equal(h.jobs[h.key].result, "T1\n\nT2\n\nT3");
  assert.equal(h.inFlight, null);
  assert.deepEqual(h.sleeps, []);
  // a short mail: one request with the earlier prompt
  const one = harness(({ part }) => `ok${part}`, "Hello");
  await one.go();
  assert.equal(one.requests.length, 1);
  assert.equal(one.jobs[one.key].result, "ok1");
}

// 21b. one automatic second try on a network error or a 5xx answer (own id, after a short wait), then the error
{
  const h = harness(({ part, attempt }) => {
    if (part === 2 && attempt === 1) throw new Error("AI_HTTP|status=503|detail=overloaded: The AI Assistant returned an error (503): overloaded");
    return `T${part}`;
  });
  await h.go();
  assert.equal(h.jobs[h.key].status, "done", "the second try worked");
  assert.deepEqual(h.requests.map((q) => `${q.part}.${q.attempt}`), ["1.1", "2.1", "2.2", "3.1"]);
  assert.deepEqual(h.sleeps, [RETRY_DELAY_MS]);
  assert.notEqual(h.requests[1].id, h.requests[2].id, "the second try has its own id");
  assert.match(h.requests[2].id, /-1\.1$/);
  assert.equal(h.jobs[h.key].result, "T1\n\nT2\n\nT3");
  // a plain network error is tried again too
  const n = harness(({ part, attempt }) => {
    if (part === 1 && attempt === 1) throw "error sending request for url (https://api.example.com/v1/chat/completions)";
    return `T${part}`;
  });
  await n.go();
  assert.equal(n.jobs[n.key].status, "done");
  assert.equal(n.requests.length, 4);
  // not twice: the second failure ends the job with that error; the parts before it are kept
  const bad = harness(({ part }) => {
    if (part === 2) throw new Error("AI_HTTP|status=502: The AI Assistant returned an error (502).");
    return `T${part}`;
  });
  await bad.go();
  assert.equal(bad.jobs[bad.key].status, "failed");
  assert.equal(bad.requests.filter((q) => q.part === 2).length, 2, "one try and one second try");
  assert.equal(bad.requests.some((q) => q.part === 3), false, "part 3 was never asked for");
  assert.deepEqual(bad.jobs[bad.key].translated, ["T1"]);
  assert.match(bad.jobs[bad.key].errorSource, /^AI_HTTP\|status=502/);
}

// 21c. no second try for what trying again cannot mend: a refusal (4xx), no setup, a timeout, a cancel, an unreadable answer
{
  for (const code of [
    "AI_HTTP|status=401|detail=Incorrect API key: The AI Assistant returned an error (401): Incorrect API key",
    "AI_HTTP|status=429|detail=Rate limit: The AI Assistant returned an error (429): Rate limit",
    "AI_HTTP|v=plain|status=404: The AI Assistant returned an error (404).",
    "AI_NOT_CONFIGURED: AI not configured",
    "AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.",
    "AI_CANCELLED: The AI Assistant request was cancelled.",
    "AI_BAD_RESPONSE: The AI Assistant sent an answer the app can’t read.",
  ]) {
    const h = harness(() => {
      throw new Error(code);
    });
    await h.go();
    assert.equal(h.requests.length, 1, code);
    assert.equal(h.jobs[h.key].status, "failed", code);
    assert.deepEqual(h.sleeps, [], code);
  }
}

// 21d. a part fails twice; Retry (a new start of the failed job) asks for that part and the ones after it, never for the parts done
{
  let fail = true;
  const h = harness(({ part }) => {
    if (part === 2 && fail) throw new Error("AI_HTTP|status=500: The AI Assistant returned an error (500).");
    return `T${part}`;
  });
  await h.go();
  assert.equal(h.jobs[h.key].status, "failed");
  assert.deepEqual(h.requests.map((q) => q.part), [1, 2, 2]);
  fail = false;
  const retry = start(h.jobs, h.jobs[h.key]);
  assert.equal(retry.start, true);
  h.jobs = retry.jobs;
  h.run = retry.jobs[h.key].run;
  h.requests = [];
  h.tries = new Map([[1, 1]]); // (only the numbering of the fake's tries)
  await h.go();
  assert.deepEqual(h.requests.map((q) => q.part), [2, 3], "part 1 is not asked for again");
  assert.equal(h.jobs[h.key].status, "done");
  assert.equal(h.jobs[h.key].result, "T1\n\nT2\n\nT3", "part 1 from the first start, parts 2 and 3 from the retry");
}

// 21e. cancel while part 2 is under way: its request is dropped, the late answer is ignored, part 3 is never asked for
{
  let release;
  const h = harness(({ part }) => (part === 2 ? new Promise((r) => (release = r)) : `T${part}`));
  const done = h.go();
  while (!h.requests.some((q) => q.part === 2)) await tick();
  assert.equal(h.jobs[h.key].translated.length, 1);
  // what cancelTranslation does: the job goes, the request in flight is dropped
  const flying = h.inFlight;
  assert.match(flying, /-1$/, "the request of part 2 is the one in flight");
  h.jobs = cancelJob(h.jobs, h.key);
  h.aborted.push(flying);
  release("late answer of part 2");
  await done;
  assert.deepEqual(h.jobs, {}, "nothing came back to life");
  assert.deepEqual(h.requests.map((q) => q.part), [1, 2], "part 3 was never asked for");
  assert.deepEqual(h.aborted, [flying]);
  // an error that comes from the dropped request is ignored as well, and does not start a second try
  let rej;
  const g = harness(({ part }) => (part === 1 ? new Promise((_, r) => (rej = r)) : `T${part}`));
  const doneG = g.go();
  while (g.requests.length === 0) await tick();
  g.jobs = cancelJob(g.jobs, g.key);
  rej("error sending request"); // a non-coded error would be tried again if the job were still current
  await doneG;
  assert.equal(g.requests.length, 1, "no second try for a cancelled job");
  assert.deepEqual(g.jobs, {});
  // a cancel during the wait before the second try ends it without another request
  const w = harness(() => {
    throw new Error("AI_HTTP|status=503: x");
  });
  await w.go({ sleep: async (ms) => { w.sleeps.push(ms); w.jobs = cancelJob(w.jobs, w.key); } });
  assert.equal(w.requests.length, 1);
  assert.deepEqual(w.jobs, {});
}

// 21f. a restart while the old run is still waiting: the old run stops, only the new one writes
{
  let release;
  const h = harness(({ part }) => (part === 1 ? new Promise((r) => (release = r)) : `T${part}`));
  const old = h.go();
  while (h.requests.length === 0) await tick();
  const failed = failJob(h.jobs, h.key, h.run, "x").jobs; // as if it had failed and been retried: the run number changed
  h.jobs = start(failed, longSpec(h.jobs[h.key].messageId)).jobs;
  release("answer of the old start");
  await old;
  assert.deepEqual(h.jobs[h.key].translated, [], "the old start's answer was not applied");
  assert.equal(h.requests.length, 1, "the old run asked for nothing more");
}

// 21g. the total time: counted from the start of the run, shared by all the parts; the parts done are kept
{
  const five = ["P1", "P2", "P3", "P4", "P5"].map((p) => `${p} ${"w".repeat(6990)}`).join("\n\n");
  const h = harness(({ part }) => {
    h.clock += 6 * 60_000; // every part takes six minutes
    return `T${part}`;
  }, five);
  assert.equal(h.jobs[h.key].parts.length, 5);
  await h.go();
  assert.equal(h.jobs[h.key].status, "failed", "15 minutes are used up after the third part");
  assert.deepEqual(h.jobs[h.key].translated, ["T1", "T2", "T3"]);
  assert.equal(h.requests.length, 3, "no fourth request");
  assert.match(h.jobs[h.key].errorSource, /^AI_TIMEOUT_TOTAL\|mins=15: /);
  // the request under way when the time runs out is limited to what is left, and dropped at the backend
  const g = harness(() => new Promise(() => {}));
  let calls = 0;
  await g.go({ now: () => (calls++ === 0 ? 0 : TRANSLATE_TOTAL_MS - 40) });
  assert.equal(g.jobs[g.key].status, "failed");
  assert.match(g.jobs[g.key].errorSource, /^AI_TIMEOUT_TOTAL/);
  assert.equal(g.aborted.length, 1, "the request that ran out of time was dropped at the backend");
  assert.equal(g.aborted[0], g.requests[0].id);
}

console.log("ok - test-translate-jobs");
