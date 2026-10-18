/**
 * Translation jobs, one per message and target language (F-19). A translation of a long mail takes a minute or more, so it must not
 * live in the reading pane's own state: the person moves to another mail and comes back, and the job is still there, running or done.
 * This file is the pure part: the states and what may happen from each, with no store, no timers of its own and no UI, so a script
 * can test it (scripts/test-translate-jobs.mjs). src/translate.ts runs the requests and drives the toast and the store.
 *
 * A long text is translated in parts, one request after the other (src/translateChunks.ts cuts it): the job keeps the parts and the
 * translated ones so far, so a failure in part 3 of 5 keeps parts 1 and 2 and Retry goes on with part 3.
 *
 *   start -> running -> done      (the result is kept for the session: "cache")
 *                    -> failed    (shown with Retry / Dismiss; Retry goes on from the part that failed)
 *   cancel: a running job is dropped; its answer, when it still comes, is ignored (the run number no longer matches)
 */
import { AI_TIMEOUT_MS, aiCallId, withTimeout } from "./aiCall.ts";
import { joinParts, planChunks } from "./translateChunks.ts";

export { withTimeout };

/** Shown after this long without an answer: "This can take a minute for a long email". */
export const SLOW_HINT_MS = 5_000;
/** The UI gives up on a request after this long. The backend gives up after 180 s (src-tauri/src/ai.rs) and says so in a coded error,
 *  so this one is only the safety net behind it (a hung webview call must never leave a spinner for ever). */
export const TRANSLATE_TIMEOUT_MS = AI_TIMEOUT_MS;
/** The whole translation (all its parts) gives up after this long, counted from the start or from a Retry; the parts done are kept.
 *  Five requests at the full 180 s fit; a text of the cap (60,000 characters, 8 parts or a few more) on a normal model takes minutes. */
export const TRANSLATE_TOTAL_MS = 15 * 60_000;
/** The automatic second try of a part that failed on the network or with a 5xx answer waits this long first. */
export const RETRY_DELAY_MS = 1_500;
/** Finished translations kept per session; the oldest go first (a running job is never dropped). */
export const MAX_FINISHED = 30;

export type JobStatus = "running" | "done" | "failed";

/** What a translation needs to start (and to start again on Retry). */
export interface TranslateSpec {
  messageId: string;
  /** the conversation the message is in: where "Show" goes and what "looking at it" means */
  threadId: string;
  folder: string;
  accountId: string;
  subject: string;
  /** English name of the target language: goes into the prompt */
  lang: string;
  /** dictionary key of the name shown to the person */
  langKey: string;
  /** the text to translate, all of it (the parts are cut from it when the job starts) */
  text: string;
}

export interface TranslateJob extends TranslateSpec {
  key: string;
  status: JobStatus;
  /** which start this is: an answer of an earlier, cancelled start has another number and is ignored */
  run: number;
  startedAt: number;
  /** order of the last start / use, for "newest" and for dropping the oldest finished job */
  touched: number;
  result?: string;
  /** the error text as the person read it when it came */
  error?: string;
  /** what the error came from (the backend's coded message): the text is made from it again in the language in use when it is drawn */
  errorSource?: string;
  /** the person closed the toast with its "x": the job goes on, only the toast is gone */
  toastClosed: boolean;
  /** the text cut into the requests to make (at least one) and what stood between them */
  parts: string[];
  seps: string[];
  /** the text was longer than MAX_CHARS: only its beginning is translated */
  truncated: boolean;
  /** the translated parts so far, in order; the next request is for part number `translated.length` (0-based) */
  translated: string[];
}

export type Jobs = Readonly<Record<string, TranslateJob>>;

/** The id of the backend request of a start (`ai_complete` / `ai_cancel`): unique per start and per run of the app, so a call left from
 *  before a page reload can never be taken for a new one. With `part` it is the request for that part; `attempt` is the automatic second
 *  try of it (a new id: a cancel that came after the first try ended must not stop the second). Cancel drops the ids in flight. */
export const aiJobId = (run: number, part?: number, attempt = 0): string =>
  aiCallId("translate", run, part === undefined ? "" : `-${part}${attempt ? `.${attempt}` : ""}`);

export const jobKey = (messageId: string, lang: string): string => `${messageId}\u0000${lang}`;

let touchSeq = 0;
const touch = () => ++touchSeq;

/**
 * Start a translation. Nothing starts (`start: false`) when the same message and language is already running (a second click) or already
 * done (the cached translation is shown again, newest). A failed one starts again (Retry) and goes on with the part that failed: the
 * parts done before are kept (when the text is the same). `run` must be a number never used before.
 */
export function startJob(jobs: Jobs, spec: TranslateSpec, now: number, run: number): { jobs: Jobs; start: boolean; key: string } {
  const key = jobKey(spec.messageId, spec.lang);
  const old = jobs[key];
  if (old?.status === "running") return { jobs, start: false, key };
  if (old?.status === "done") return { jobs: { ...jobs, [key]: { ...old, touched: touch() } }, start: false, key };
  const resume = old?.status === "failed" && old.text === spec.text ? old : undefined;
  const plan = resume ?? planChunks(spec.text);
  const job: TranslateJob = {
    ...spec,
    key,
    status: "running",
    run,
    startedAt: now,
    touched: touch(),
    result: undefined,
    error: undefined,
    errorSource: undefined,
    toastClosed: false,
    parts: plan.parts,
    seps: plan.seps,
    truncated: plan.truncated,
    translated: resume ? resume.translated : [],
  };
  return { jobs: { ...jobs, [key]: job }, start: true, key };
}

/** The part a running job asks for now: its number (0-based), how many there are, and its text. */
export function nextPart(job: TranslateJob): { index: number; total: number; text: string } {
  return { index: job.translated.length, total: job.parts.length, text: job.parts[job.translated.length] ?? "" };
}

/**
 * The answer for the next part arrived. The job goes on (`done: false`: the next part is asked for) or, with the last part, is finished with
 * the parts put together (`done: true`). Ignored (`applied: false`) when the job was cancelled, restarted or is not running any more.
 */
export function partDone(jobs: Jobs, key: string, run: number, text: string): { jobs: Jobs; applied: boolean; done: boolean } {
  const j = jobs[key];
  if (!j || j.run !== run || j.status !== "running" || j.translated.length >= j.parts.length) return { jobs, applied: false, done: false };
  const translated = [...j.translated, text];
  if (translated.length < j.parts.length) return { jobs: { ...jobs, [key]: { ...j, translated, touched: touch() } }, applied: true, done: false };
  const r = finishJob({ ...jobs, [key]: { ...j, translated } }, key, run, joinParts(translated, j.seps));
  return { jobs: r.jobs, applied: r.applied, done: r.applied };
}

/** The answer arrived. Ignored (`applied: false`) when the job was cancelled, restarted or is not running any more. */
export function finishJob(jobs: Jobs, key: string, run: number, result: string): { jobs: Jobs; applied: boolean } {
  const j = jobs[key];
  if (!j || j.run !== run || j.status !== "running") return { jobs, applied: false };
  return { jobs: dropOldFinished({ ...jobs, [key]: { ...j, status: "done", result, error: undefined, errorSource: undefined, touched: touch() } }), applied: true };
}

/** The request failed or timed out (`error` is the text for the person). Ignored like `finishJob` when it is no longer current. */
export function failJob(jobs: Jobs, key: string, run: number, error: string, errorSource?: string): { jobs: Jobs; applied: boolean } {
  const j = jobs[key];
  if (!j || j.run !== run || j.status !== "running") return { jobs, applied: false };
  return { jobs: { ...jobs, [key]: { ...j, status: "failed", error, errorSource, result: undefined, touched: touch() } }, applied: true };
}

/** Cancel a running job: it is dropped. Anything else is left alone. */
export function cancelJob(jobs: Jobs, key: string): Jobs {
  if (jobs[key]?.status !== "running") return jobs;
  const { [key]: _gone, ...rest } = jobs;
  return rest;
}

/** "Hide translation" / "Dismiss" an error: a finished or failed job is dropped (a running one is cancelled instead). */
export function removeJob(jobs: Jobs, key: string): Jobs {
  if (!jobs[key] || jobs[key].status === "running") return jobs;
  const { [key]: _gone, ...rest } = jobs;
  return rest;
}

/** The person closed the toast of a job: only the toast. */
export function closeToast(jobs: Jobs, key: string): Jobs {
  const j = jobs[key];
  if (!j || j.toastClosed) return jobs;
  return { ...jobs, [key]: { ...j, toastClosed: true } };
}

/** The job to show on a message: a running one (newest first), else the newest finished or failed one; none when there is none. */
export function jobFor(jobs: Jobs, messageId: string): TranslateJob | undefined {
  let best: TranslateJob | undefined;
  for (const j of Object.values(jobs)) {
    if (j.messageId !== messageId) continue;
    const rank = (x: TranslateJob) => (x.status === "running" ? 2 : 1) * 1e9 + x.touched;
    if (!best || rank(j) > rank(best)) best = j;
  }
  return best;
}

export type SettleToast = "close" | "ready" | "error" | "none";

/**
 * What the toast of a job does when the job ends. `viewing`: the person has that mail open right now.
 * - done, viewing: the toast just closes as the translation appears (no second toast).  done, elsewhere: "Translation ready" with Show.
 * - failed: the toast becomes the error with Retry, unless the person closed it already (the box in the mail shows the error).
 */
export function settleToast(status: "done" | "failed", viewing: boolean, toastClosed: boolean): SettleToast {
  if (status === "done") return viewing ? "close" : "ready";
  return toastClosed ? "none" : "error";
}

export const slowHint = (startedAt: number, now: number): boolean => now - startedAt >= SLOW_HINT_MS;

/** "0:07", "1:05", "12:00" */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function dropOldFinished(jobs: Jobs): Jobs {
  const finished = Object.values(jobs).filter((j) => j.status === "done");
  if (finished.length <= MAX_FINISHED) return jobs;
  const drop = finished.sort((a, b) => a.touched - b.touched).slice(0, finished.length - MAX_FINISHED);
  const next = { ...jobs };
  for (const j of drop) delete next[j.key];
  return next;
}

/** The prompt of a part. A text in one part is asked for as it always was; with several, the model is told which part it has so that it
 *  translates just that and adds no introduction or closing. */
export function partPrompt(lang: string, index: number, total: number): string {
  // i18n-ok: a prompt for the language model, not text the person reads
  const base = `Translate the email into ${lang}. Output only the translation, keep the formatting and line breaks.`;
  // i18n-ok: a prompt for the language model, not text the person reads
  return total > 1 ? `${base} This email is long and is sent in ${total} parts; this is part ${index + 1}. Translate only this part and add nothing before or after it.` : base;
}

/** The coded error of a translation that used up TRANSLATE_TOTAL_MS (translated by `backend.AI_TIMEOUT_TOTAL`). The parts done are kept. */
export function totalTimeoutError(): Error {
  const mins = Math.round(TRANSLATE_TOTAL_MS / 60_000);
  // i18n-ok: a coded error, translated by backend.AI_TIMEOUT_TOTAL
  return new Error(`AI_TIMEOUT_TOTAL|mins=${mins}: The translation took longer than ${mins} minutes in all. Retry goes on where it stopped.`);
}
