// "Translate to ...": runs the translation requests and keeps the toast of each one in step with its job (F-19). The jobs live in the store
// (src/translateJobs.ts has the rules), so a translation goes on while the person reads other mail, and the reading pane only shows it.
import { api } from "./api";
import { t, type Key } from "./i18n";
import { friendlyError, useStore } from "./store";
import { stickyTimers } from "./stickyTimers";
import {
  cancelJob,
  closeToast,
  failJob,
  nextPart,
  partDone,
  removeJob,
  settleToast,
  slowHint,
  SLOW_HINT_MS,
  startJob,
  type TranslateJob,
  type TranslateSpec,
} from "./translateJobs";
import { runParts } from "./translateRun";

/** How long "Translation ready" waits for a click before it goes by itself (the translation stays in the mail). */
const READY_MS = 30_000;

let runSeq = 0;
const toastKey = (j: TranslateJob) => `translate:${j.messageId}:${j.lang}`;
const readyTimers = stickyTimers((key) => useStore.getState().setStickyToast(key, null));
const hintTimers = new Map<string, ReturnType<typeof setTimeout>>();

const store = () => useStore.getState();
const current = (key: string, run: number): TranslateJob | undefined => {
  const j = store().translations[key];
  return j && j.run === run ? j : undefined;
};

/** The request each running translation has at the backend right now (one at a time: the parts go in order). Cancel drops it. */
const inFlight = new Map<string, { run: number; id: string }>();

/** Drop a request at the backend (it closes the connection to the provider). Nothing to do when the call is over already. */
function abortRequest(id: string) {
  api.aiCancel(id).catch(() => {});
}

/** The person has this very mail open (not elsewhere, not in the calendar). */
const viewing = (j: TranslateJob) => store().module === "mail" && store().selected === j.threadId;

function subjectOf(j: TranslateJob): string {
  return j.subject.trim() || t("app.noSubject");
}

/** The error of a failed job in the language in use now (made from what it came from, so a language switch changes it too). */
export function jobErrorText(j: TranslateJob): string {
  return j.errorSource !== undefined ? friendlyError(j.errorSource) : (j.error ?? "");
}

function runningToast(j: TranslateJob, slow: boolean) {
  // functions, not final strings: the toast is drawn again in the language in use when the person switches language meanwhile
  const { index, total } = nextPart(j);
  const text = () => {
    const base = t("reading.translate.toastRunning", { lang: t(j.langKey as Key), subject: subjectOf(j) });
    const part = total > 1 ? ` · ${t("reading.translate.part", { n: index + 1, total })}` : "";
    return `${base}${part}${slow ? ` ${t("reading.translate.slow")}` : ""}`;
  };
  store().setStickyToast(toastKey(j), {
    text,
    kind: "info",
    busy: true,
    actions: [{ label: () => t("common.cancel"), run: () => cancelTranslation(j.key) }],
    closeLabel: () => t("common.close"),
    // the "x" hides the toast only: the job goes on and the box in the mail still shows it
    onDismiss: () => store().setTranslations((jobs) => closeToast(jobs, j.key)),
  });
}

/** Open the conversation of a translated mail (the "Show" of the ready toast). */
async function showMail(j: TranslateJob) {
  const st = store();
  st.setModule("mail");
  if (!st.threads.some((x) => x.threadId === j.threadId)) await st.setView(j.folder, j.accountId);
  await store().openMail(j.threadId);
}

/** An answer or an error of the request in flight. True when the job goes on with its next part. */
function settle(key: string, run: number, outcome: { part: string } | { error: unknown }): boolean {
  const applied = "part" in outcome
    ? partDone(store().translations, key, run, outcome.part)
    : failJob(store().translations, key, run, friendlyError(outcome.error), String(outcome.error instanceof Error ? outcome.error.message : outcome.error));
  if (!applied.applied) return false; // cancelled or restarted meanwhile: this answer is of no interest
  const before = store().translations[key];
  store().setTranslations(() => applied.jobs);
  const j = applied.jobs[key];
  if (j.status === "running") {
    // part done, the next one is asked for: the toast says which
    if (!j.toastClosed) runningToast(j, slowHint(j.startedAt, Date.now()));
    return true;
  }
  clearTimeout(hintTimers.get(key));
  hintTimers.delete(key);
  const tk = toastKey(j);
  const what = settleToast(j.status as "done" | "failed", viewing(j), before?.toastClosed ?? false);
  if (what === "close") {
    store().setStickyToast(tk, null);
  } else if (what === "ready") {
    store().setStickyToast(tk, {
      text: () => t("reading.translate.ready", { subject: subjectOf(j) }),
      kind: "success",
      actions: [{ label: () => t("reading.translate.show"), run: () => void showMail(j) }],
      closeLabel: () => t("common.close"),
    });
    readyTimers.arm(tk, READY_MS);
  } else if (what === "error") {
    store().setStickyToast(tk, {
      text: () => t("reading.translate.failed", { error: jobErrorText(j) }),
      kind: "error",
      actions: [{ label: () => t("common.retry"), run: () => startTranslation(j) }],
      closeLabel: () => t("common.close"),
    });
  } else {
    store().setStickyToast(tk, null);
  }
  return false;
}

/** Start translating (or show the finished translation again; a second start of a running one does nothing). */
export function startTranslation(spec: TranslateSpec): void {
  const started = startJob(store().translations, spec, Date.now(), ++runSeq);
  store().setTranslations(() => started.jobs);
  if (!started.start) return;
  const job = started.jobs[started.key];
  const { key, run } = job;
  readyTimers.cancel(toastKey(job));
  runningToast(job, false);
  hintTimers.set(
    key,
    setTimeout(() => {
      const j = current(key, run);
      if (j && j.status === "running" && !j.toastClosed) runningToast(j, true);
    }, SLOW_HINT_MS),
  );
  void runParts(run, {
    job: () => current(key, run),
    complete: api.aiComplete,
    abort: abortRequest,
    flying: (id) => {
      if (id) inFlight.set(key, { run, id });
      else if (inFlight.get(key)?.run === run) inFlight.delete(key);
    },
    settle: (outcome) => settle(key, run, outcome),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
}

/** Stop waiting for a running translation: the box and the toast go; an answer that still comes is ignored. */
export function cancelTranslation(key: string): void {
  const j = store().translations[key];
  if (!j || j.status !== "running") return;
  clearTimeout(hintTimers.get(key));
  hintTimers.delete(key);
  store().setTranslations((jobs) => cancelJob(jobs, key));
  store().setStickyToast(toastKey(j), null);
  // the parts go in order, so one request is in flight: drop it; the parts after it are never asked for (the job is gone)
  const flying = inFlight.get(key);
  inFlight.delete(key);
  if (flying) abortRequest(flying.id);
}

/** "Hide translation" / "Dismiss" of an error: the job (and its cached result) goes. */
export function dismissTranslation(key: string): void {
  const j = store().translations[key];
  if (!j || j.status === "running") return;
  store().setTranslations((jobs) => removeJob(jobs, key));
  store().setStickyToast(toastKey(j), null);
  readyTimers.cancel(toastKey(j));
}
