/**
 * Runs the parts of one translation job, one request after the other (src/translate.ts wires it to the store and the backend; the
 * script scripts/test-translate-jobs.mjs wires it to fakes). One request is in flight at any time, so the order of the parts is the
 * order of the answers, and Cancel only has to drop that one request: the parts after it are never asked for, because the job is gone.
 */
import { isTransientAiError, timeoutError, withTimeout } from "./aiCall.ts";
import { aiJobId, nextPart, partPrompt, RETRY_DELAY_MS, totalTimeoutError, TRANSLATE_TIMEOUT_MS, TRANSLATE_TOTAL_MS, type TranslateJob } from "./translateJobs.ts";

export interface RunDeps {
  /** the job of this start while it is still current (not cancelled, not restarted) */
  job(): TranslateJob | undefined;
  /** one request to the model (`api.aiComplete`) */
  complete(system: string, prompt: string, jobId: string): Promise<string>;
  /** drop a request at the backend (`api.aiCancel`) */
  abort(jobId: string): void;
  /** the request now in flight, or null when there is none: what Cancel drops */
  flying(jobId: string | null): void;
  /** a part is translated (`part`) or the job failed (`error`); true when the job goes on with the next part */
  settle(outcome: { part: string } | { error: unknown }): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The request for the next part, with one automatic second try when the connection or the provider failed (network, 5xx). The text of
 * the part is what the job says is next, so a Retry after a failure asks for the part that failed and not for one that is done.
 * null: the job is not current any more. Throws the error of the last try.
 */
async function requestPart(d: RunDeps, run: number, deadline: number): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const j = d.job();
    if (!j || j.status !== "running") return null;
    const { index, total, text } = nextPart(j);
    const left = deadline - d.now();
    if (left <= 0) throw totalTimeoutError();
    const id = aiJobId(run, index, attempt);
    d.flying(id);
    try {
      return await withTimeout(d.complete(partPrompt(j.lang, index, total), text, id), Math.min(TRANSLATE_TIMEOUT_MS, left), () => {
        d.abort(id); // the UI gives up: the request to the provider must not go on in the background
        return left < TRANSLATE_TIMEOUT_MS ? totalTimeoutError() : timeoutError(TRANSLATE_TIMEOUT_MS);
      });
    } catch (e) {
      if (attempt > 0 || !isTransientAiError(e)) throw e;
    } finally {
      d.flying(null);
    }
    await d.sleep(RETRY_DELAY_MS);
  }
}

/** Ask for the parts of a job in order until it is done, failed or cancelled. The total time is TRANSLATE_TOTAL_MS from here. */
export async function runParts(run: number, d: RunDeps): Promise<void> {
  const deadline = d.now() + TRANSLATE_TOTAL_MS;
  for (;;) {
    let part: string | null;
    try {
      part = await requestPart(d, run, deadline);
    } catch (error) {
      d.settle({ error });
      return;
    }
    if (part === null || !d.settle({ part })) return;
  }
}
