// F-19: translation jobs of messages (src/translateJobs.ts): start, finish, fail, cancel, switching to another mail and back, a second
// start ignored, an answer that comes after a cancel ignored, the toast rules, the hard timeout.
// Run: node --experimental-strip-types scripts/test-translate-jobs.mjs
import assert from "node:assert/strict";
import {
  cancelJob, closeToast, elapsedLabel, failJob, finishJob, jobFor, jobKey, MAX_FINISHED, removeJob, settleToast, slowHint, SLOW_HINT_MS,
  startJob, TRANSLATE_TIMEOUT_MS, withTimeout,
} from "../src/translateJobs.ts";

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

console.log("ok - test-translate-jobs");
