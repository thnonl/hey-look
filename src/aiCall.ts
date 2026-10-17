/**
 * What every AI Assistant call of the app shares (Translate, Summarize, Write with AI): the id that makes a request cancellable at the
 * backend (`ai_complete` / `ai_cancel`), the UI's own time limit behind the backend's 180 s, the rule for which errors are worth one
 * more try, and a slot that runs one call at a time for a button (Summarize, Write): a repeated click does nothing while a call runs,
 * Cancel drops the request, and an answer that still comes after Cancel (or after the person left) is ignored.
 * Pure: the two backend calls are handed in, so a script can test it (scripts/test-ai-call.mjs).
 */

/** The UI gives up on a request after this long. The backend gives up after 180 s (src-tauri/src/ai.rs) and says so in a coded error, so
 *  this is only the safety net behind it (a hung webview call must never leave a spinner for ever). */
export const AI_TIMEOUT_MS = 190_000;

const bootId = Math.random().toString(36).slice(2, 8);
/** The id of one backend request: unique per request and per run of the app, so a call left from before a page reload can never be taken
 *  for a new one. `kind` says what it is for ("translate", "summarize", "write"); `tail` tells requests of one job apart. */
export const aiCallId = (kind: string, run: number, tail = ""): string => `${kind}-${bootId}-${run}${tail}`;

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

/** The coded error the backend sends after its own 180 s (translated by `backend.AI_TIMEOUT`), made here when the UI's limit comes first. */
export function timeoutError(ms = AI_TIMEOUT_MS): Error {
  const secs = Math.round(ms / 1000);
  // i18n-ok: a coded error, translated by backend.AI_TIMEOUT (the same sentence the backend sends after 180 s)
  return new Error(`AI_TIMEOUT|secs=${secs}: The AI Assistant didn’t answer within ${secs} seconds.`);
}

/**
 * Whether one more try of the same request may help: the provider failed on its side (HTTP 5xx) or the connection did (an error that is
 * not one of the app's coded ones). Not a timeout (another 3 minutes), not a refusal (4xx), not a missing setup, not a cancel.
 */
export function isTransientAiError(raw: unknown): boolean {
  const s = String(raw instanceof Error ? raw.message : raw).replace(/^Error:\s*/, "").trim();
  const coded = /^([A-Z][A-Z0-9_]+)((?:\|[A-Za-z]\w*=[^|:]*)*):/.exec(s);
  if (!coded) return true;
  if (coded[1] !== "AI_HTTP") return false;
  const status = /\|status=(\d+)/.exec(coded[2]);
  return !!status && Number(status[1]) >= 500;
}

/** The two backend calls a request needs (`api.aiComplete`, `api.aiCancel`). */
export interface AiBackend {
  complete(system: string, prompt: string, jobId: string): Promise<string>;
  /** drops the request of that id at the backend; never throws */
  cancel(jobId: string): void;
}

/** One request with the UI's time limit: when it passes the request is dropped at the backend and the coded timeout is the error. */
export function requestWithTimeout(backend: AiBackend, id: string, system: string, prompt: string, ms = AI_TIMEOUT_MS, onTimeout?: () => Error): Promise<string> {
  return withTimeout(backend.complete(system, prompt, id), ms, () => {
    backend.cancel(id);
    return onTimeout ? onTimeout() : timeoutError(ms);
  });
}

/** How a call ended: its text, its error, or `null` when the person cancelled it (or left) and its answer is of no interest. */
export type AiOutcome = { text: string } | { error: unknown } | null;

export interface AiSlot {
  /** a call is under way */
  readonly running: boolean;
  /** Start a call. `null` when one is under way already (a repeated click); else the outcome, `null` if Cancel came first. */
  start(system: string, prompt: string): Promise<AiOutcome> | null;
  /** Cancel the call under way (its request is dropped); false when there was none. */
  cancel(): boolean;
}

/** Counts the calls of every slot, so two slots of one kind (two Compose windows) never use the same id: the backend takes a second call with an id for a restart of the first. */
let callSeq = 0;

export function createAiSlot(backend: AiBackend, kind: string, timeoutMs = AI_TIMEOUT_MS): AiSlot {
  let live: { id: string } | null = null;
  const settle = (mine: { id: string }, out: AiOutcome): AiOutcome => {
    if (live !== mine) return null; // cancelled meanwhile: the answer, or the error of the dropped request, is not for anyone
    live = null;
    return out;
  };
  return {
    get running() {
      return live !== null;
    },
    start(system, prompt) {
      if (live) return null;
      const mine = { id: aiCallId(kind, ++callSeq) };
      live = mine;
      return requestWithTimeout(backend, mine.id, system, prompt, timeoutMs).then(
        (text) => settle(mine, { text }),
        (error) => settle(mine, { error }),
      );
    },
    cancel() {
      if (!live) return false;
      const { id } = live;
      live = null;
      backend.cancel(id);
      return true;
    },
  };
}
