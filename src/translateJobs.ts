/**
 * Translation jobs, one per message and target language (F-19). A translation of a long mail takes a minute or more, so it must not
 * live in the reading pane's own state: the person moves to another mail and comes back, and the job is still there, running or done.
 * This file is the pure part: the states and what may happen from each, with no store, no timers of its own and no UI, so a script
 * can test it (scripts/test-translate-jobs.mjs). src/translate.ts runs the requests and drives the toast and the store.
 *
 *   start -> running -> done      (the result is kept for the session: "cache")
 *                    -> failed    (shown with Retry / Dismiss; Retry starts it again)
 *   cancel: a running job is dropped; its answer, when it still comes, is ignored (the run number no longer matches)
 */

/** Shown after this long without an answer: "This can take a minute for a long email". */
export const SLOW_HINT_MS = 5_000;
/** The UI gives up on a request after this long. The backend gives up after 180 s (src-tauri/src/ai.rs) and says so in a coded error,
 *  so this one is only the safety net behind it (a hung webview call must never leave a spinner for ever). */
export const TRANSLATE_TIMEOUT_MS = 190_000;
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
  /** the text to translate */
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
  /** the error text as the person reads it */
  error?: string;
  /** the person closed the toast with its "x": the job goes on, only the toast is gone */
  toastClosed: boolean;
}

export type Jobs = Readonly<Record<string, TranslateJob>>;

const bootId = Math.random().toString(36).slice(2, 8);
/** The id of the backend request of a start (`ai_complete` / `ai_cancel`): unique per start and per run of the app, so a call left from
 *  before a page reload can never be taken for a new one. */
export const aiJobId = (run: number): string => `translate-${bootId}-${run}`;

export const jobKey = (messageId: string, lang: string): string => `${messageId}\u0000${lang}`;

let touchSeq = 0;
const touch = () => ++touchSeq;

/**
 * Start a translation. Nothing starts (`start: false`) when the same message and language is already running (a second click) or already
 * done (the cached translation is shown again, newest). A failed one starts again (Retry). `run` must be a number never used before.
 */
export function startJob(jobs: Jobs, spec: TranslateSpec, now: number, run: number): { jobs: Jobs; start: boolean; key: string } {
  const key = jobKey(spec.messageId, spec.lang);
  const old = jobs[key];
  if (old?.status === "running") return { jobs, start: false, key };
  if (old?.status === "done") return { jobs: { ...jobs, [key]: { ...old, touched: touch() } }, start: false, key };
  const job: TranslateJob = { ...spec, key, status: "running", run, startedAt: now, touched: touch(), toastClosed: false };
  return { jobs: { ...jobs, [key]: job }, start: true, key };
}

/** The answer arrived. Ignored (`applied: false`) when the job was cancelled, restarted or is not running any more. */
export function finishJob(jobs: Jobs, key: string, run: number, result: string): { jobs: Jobs; applied: boolean } {
  const j = jobs[key];
  if (!j || j.run !== run || j.status !== "running") return { jobs, applied: false };
  return { jobs: dropOldFinished({ ...jobs, [key]: { ...j, status: "done", result, error: undefined, touched: touch() } }), applied: true };
}

/** The request failed or timed out (`error` is the text for the person). Ignored like `finishJob` when it is no longer current. */
export function failJob(jobs: Jobs, key: string, run: number, error: string): { jobs: Jobs; applied: boolean } {
  const j = jobs[key];
  if (!j || j.run !== run || j.status !== "running") return { jobs, applied: false };
  return { jobs: { ...jobs, [key]: { ...j, status: "failed", error, result: undefined, touched: touch() } }, applied: true };
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

/** The promise, or `onTimeout()` as a rejection after `ms`: whichever comes first. The timer is cleared either way. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function dropOldFinished(jobs: Jobs): Jobs {
  const finished = Object.values(jobs).filter((j) => j.status === "done");
  if (finished.length <= MAX_FINISHED) return jobs;
  const drop = finished.sort((a, b) => a.touched - b.touched).slice(0, finished.length - MAX_FINISHED);
  const next = { ...jobs };
  for (const j of drop) delete next[j.key];
  return next;
}
