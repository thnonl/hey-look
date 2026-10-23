// Reply / Reply all / Forward open at once (1.0.7 W13.13, D-064). The old code waited, one step after the other and before anything was painted, for the headers of the message (a
// server round trip), the pictures of the quote, the cleaning of the quote and the editor; on a long mail nothing happened for seconds. Now:
//   1. the slow steps START at once and run side by side (`job.prepare`: headers, pictures / attachments, the quote module),
//   2. the compose opens in the same moment as a shell with what is known (subject, account) and a "preparing" flag: header rows, the recipient fields and Send off, the status in the body,
//   3. the message is built when the steps are done (the quote is cleaned only after the shell was painted: paint first, then work) and replaces the shell in one step.
// A second press on the same answer only brings the shell forward; Discard / closing while it prepares ends it and the finished message is dropped; a step that fails is replaced by
// today's fallback (answer to From, no quote); a shell never stays (15 s). Pure apart from `deps`, so scripts/test-answer-shell.mjs runs it in plain Node (types only are imported).
import type { ComposeInit } from "./store.ts";
import type { StartOpts } from "./popout/composeOpen.ts";
import { SAFETY_MS } from "./composeShell.ts";

/** Where `deps.open` put the shell. */
export type ShellStart = { ok: false } | { ok: true; where: "pane" } | { ok: true; where: "window"; label: string | null; fresh: boolean };

export interface ShellDeps {
  /** Opens the shell as a compose (in the pane, or in a window of its own). */
  open(init: ComposeInit, o: StartOpts): Promise<ShellStart>;
  /** Is the shell `id` still the compose in the pane (not discarded, not replaced by another message)? */
  paneHas(id: string): boolean;
  /** The finished message replaces the shell in the pane. */
  fillPane(init: ComposeInit): Promise<void>;
  /** The finished message is handed to the window `label` (it keeps the status for its minimum time itself). */
  fillWindow(label: string | null, init: ComposeInit): void;
  /** A second press on an answer that is being prepared: bring that shell forward. True = there was one. */
  focusPrepared(key: string, id: string): Promise<boolean>;
  /** Resolves after the shell was painted. */
  paint(): Promise<void>;
  wait(ms: number): Promise<void>;
  /** How long the status of shell `id` still has to stay on screen (RULE-2, 300 ms). */
  remaining(id: string): number;
  /** The shell `id` is over. */
  done(id: string): void;
  newId(): string;
  /** A step failed in a way that is told to the person. */
  fail(e: unknown): void;
  /** The press shows on the button of the answer `key` while the shell opens (answerBusy.ts). */
  busy(key: string, on: boolean): void;
}

export interface AnswerJob<T> {
  kind: "reply" | "forward";
  /** `answerKey(...)`: one preparation / window per answer */
  key: string;
  /** what is known at the press: account, subject, the flags that do not need the server */
  shell: ComposeInit;
  /** the attachments of a forward are fetched: the status says so ("Getting the attachments…") */
  fetching?: boolean;
  o: StartOpts;
  /** The slow steps. Called at once, before the shell is open; `painted` resolves when the shell was drawn (heavy work waits for it). Never rejects in practice (each step has its fallback). */
  prepare(painted: Promise<void>): Promise<T>;
  /** The whole message from what was prepared. */
  build(r: T): ComposeInit;
  /** The message without the slow parts (a step threw, or the safety end came): answers to From, no quote. */
  fallback(): ComposeInit;
  /** The shell was filled: what could not come along is told now (forward: files that failed). */
  after?(r: T): void;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const TIMED_OUT = Symbol("safety end");

export function createAnswerShell(deps: ShellDeps, safetyMs: number = SAFETY_MS, now: () => number = Date.now) {
  /** answer key -> the id of the shell that is being prepared */
  const active = new Map<string, string>();

  async function open<T>(job: AnswerJob<T>): Promise<void> {
    const before = active.get(job.key);
    if (before && (await deps.focusPrepared(job.key, before))) return; // the same answer again: the shell that is there comes forward, nothing new starts
    const id = deps.newId();
    active.set(job.key, id);
    deps.busy(job.key, true);
    const finish = () => {
      if (active.get(job.key) === id) active.delete(job.key);
      deps.busy(job.key, false);
      deps.done(id);
    };
    try {
      let painted!: () => void;
      const gate = new Promise<void>((r) => (painted = r));
      // the slow steps start now, side by side, not after the shell (REQ-13.13.3)
      const work: Promise<Outcome<T>> = job.prepare(gate).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      const shell: ComposeInit = { ...job.shell, preparing: { kind: job.kind, id, key: job.key, at: now(), ...(job.fetching ? { fetching: true } : {}) } };
      const opening = deps.open(shell, job.o).catch((): ShellStart => ({ ok: false }));
      void opening.then(() => deps.paint()).then(painted, painted);
      const start = await opening;
      deps.busy(job.key, false); // the shell is there (or nothing will be): the button is free again
      if (!start.ok) return finish(); // no mailbox, or the person kept writing the other message: nothing to prepare
      if (start.where === "window" && !start.fresh) return finish(); // a window of this answer was there: it was brought forward and has its own preparation
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = new Promise<typeof TIMED_OUT>((r) => (timer = setTimeout(() => r(TIMED_OUT), safetyMs)));
      const got = await Promise.race([work, end]);
      clearTimeout(timer);
      let init: ComposeInit;
      let ok: Outcome<T> | null = got === TIMED_OUT ? null : got;
      if (ok && ok.ok) {
        try {
          init = job.build(ok.value);
        } catch (e) {
          ok = { ok: false, error: e };
          init = job.fallback();
        }
      } else {
        init = job.fallback();
      }
      const failure: unknown = ok === null ? new Error("timeout") : ok.ok ? null : ok.error; // (told after the message is filled in: a dropped result says nothing)
      const full: ComposeInit = { ...init, afterShell: true };
      if (start.where === "pane") {
        if (!deps.paneHas(id)) return finish(); // Discard / another message while it prepared: the result is dropped (REQ-13.13.6)
        await deps.wait(0); // (a task of its own: the quote was built above, the editor is built by the render below)
        const left = deps.remaining(id);
        if (left > 0) await deps.wait(left); // the status stays on screen for 300 ms once it was shown
        if (!deps.paneHas(id)) return finish();
        await deps.fillPane(full);
      } else {
        deps.fillWindow(start.label, full);
      }
      if (failure) deps.fail(failure);
      if (ok && ok.ok) job.after?.(ok.value);
    } finally {
      finish();
    }
  }

  return { open, preparing: (key: string) => active.has(key) };
}
