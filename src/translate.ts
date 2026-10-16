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
  finishJob,
  removeJob,
  settleToast,
  SLOW_HINT_MS,
  startJob,
  TRANSLATE_TIMEOUT_MS,
  aiJobId,
  withTimeout,
  type TranslateJob,
  type TranslateSpec,
} from "./translateJobs";

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

/** Drop the request of a start at the backend (it closes the connection to the provider). Nothing to do when the call is over already. */
function abortRequest(run: number) {
  api.aiCancel(aiJobId(run)).catch(() => {});
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
  const text = () => {
    const base = t("reading.translate.toastRunning", { lang: t(j.langKey as Key), subject: subjectOf(j) });
    return slow ? `${base} ${t("reading.translate.slow")}` : base;
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
  await store().select(j.threadId);
}

function settle(key: string, run: number, outcome: { result: string } | { error: unknown }) {
  clearTimeout(hintTimers.get(key));
  hintTimers.delete(key);
  const applied = "result" in outcome
    ? finishJob(store().translations, key, run, outcome.result)
    : failJob(store().translations, key, run, friendlyError(outcome.error), String(outcome.error instanceof Error ? outcome.error.message : outcome.error));
  if (!applied.applied) return; // cancelled or restarted meanwhile: this answer is of no interest
  const before = store().translations[key];
  store().setTranslations(() => applied.jobs);
  const j = applied.jobs[key];
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
  const secs = Math.round(TRANSLATE_TIMEOUT_MS / 1000);
  withTimeout(
    api.aiComplete(
      // i18n-ok: a prompt for the language model, not text the person reads
      `Translate the email into ${job.lang}. Output only the translation, keep the formatting and line breaks.`,
      job.text,
      aiJobId(run),
    ),
    TRANSLATE_TIMEOUT_MS,
    () => {
      abortRequest(run); // the UI gives up: the request to the provider must not go on in the background
      // i18n-ok: a coded error, translated by backend.AI_TIMEOUT (the same sentence the backend sends after 180 s)
      return new Error(`AI_TIMEOUT|secs=${secs}: The AI Assistant didn’t answer within ${secs} seconds.`);
    },
  ).then(
    (result) => settle(key, run, { result }),
    (error) => settle(key, run, { error }),
  );
}

/** Stop waiting for a running translation: the box and the toast go; an answer that still comes is ignored. */
export function cancelTranslation(key: string): void {
  const j = store().translations[key];
  if (!j || j.status !== "running") return;
  clearTimeout(hintTimers.get(key));
  hintTimers.delete(key);
  store().setTranslations((jobs) => cancelJob(jobs, key));
  store().setStickyToast(toastKey(j), null);
  abortRequest(j.run);
}

/** "Hide translation" / "Dismiss" of an error: the job (and its cached result) goes. */
export function dismissTranslation(key: string): void {
  const j = store().translations[key];
  if (!j || j.status === "running") return;
  store().setTranslations((jobs) => removeJob(jobs, key));
  store().setStickyToast(toastKey(j), null);
  readyTimers.cancel(toastKey(j));
}
