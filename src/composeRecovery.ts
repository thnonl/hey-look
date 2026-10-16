// The question at the start of the app: "Restore your unsaved message?" (QA round 17 BUG-02). The sequence itself is in recovery.ts; this
// connects it to the store, the backend and the texts.

import { api } from "./api";
import { t } from "./i18n";
import { offerRecovery, type RecoveryForm, type RecoveryLoaded } from "./recovery";
import { useStore } from "./store";
import { fmtWhen } from "./util";

let asked = false;

/** The message of a snapshot as Compose opens it, or null when the snapshot cannot be read. */
export function composeFromSnapshot(l: RecoveryLoaded) {
  let f: RecoveryForm;
  try {
    f = JSON.parse(l.payload) as RecoveryForm;
  } catch {
    return null;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (typeof f !== "object" || f === null || typeof f.html !== "string") return null;
  return {
    accountId: l.accountId,
    to: list(f.to),
    cc: list(f.cc),
    bcc: list(f.bcc),
    subject: typeof f.subject === "string" ? f.subject : "",
    bodyHtml: f.html,
    inReplyTo: f.inReplyTo ?? null,
    references: list(f.references),
    replaces: f.replaces ?? undefined,
    isReply: !!f.isReply,
    attachments: l.files,
    // the toggles as they were; the body holds its one signature region, as in a stored draft
    restore: { encrypt: f.encrypt === "on" || f.encrypt === "auto" ? f.encrypt : ("off" as const), sign: !!f.sign, attachKey: !!f.attachKey },
    confidential: !!f.confidential,
    // the snapshot keeps its id: the next snapshot of this message replaces it, and it goes when the message is sent, discarded or saved
    recoveryId: l.id,
  };
}

/** Once per start: offer back what was being written when the app ended without saving or sending it. Nothing is opened, saved or sent unasked. */
export async function offerRestore(): Promise<void> {
  if (asked) return;
  asked = true;
  const st = () => useStore.getState();
  await offerRecovery({
    list: () => api.recoveryList(),
    load: (id) => api.recoveryLoad(id),
    ask: async (info) => {
      const when = fmtWhen(info.savedAt);
      const answer = await st().choose({
        title: t("compose.recover.title"),
        body: info.subject.trim() ? t("compose.recover.body", { subject: info.subject.trim(), when }) : t("compose.recover.bodyNoSubject", { when }),
        // (Esc and a click outside answer with the first choice: "Not now" keeps the message)
        choices: [
          { id: "later", label: t("compose.recover.later") },
          { id: "restore", label: t("compose.recover.restore"), kind: "primary" },
          { id: "discard", label: t("compose.dlg.discard"), kind: "danger" },
        ],
      });
      return answer === "restore" || answer === "discard" ? answer : "later";
    },
    open: async (l) => {
      const init = composeFromSnapshot(l);
      if (!init) {
        // not a snapshot this version can read: it is of no use, and asking again at every start would not help
        st().showToast(t("compose.recover.failed"), undefined, "error");
        await api.recoveryClear(l.id).catch(() => undefined);
        return;
      }
      await st().openCompose(init);
    },
    clear: (id) => api.recoveryClear(id),
    composing: () => !!st().compose,
    whenIdle: () =>
      new Promise<void>((done) => {
        const off = useStore.subscribe((s) => {
          if (s.compose) return;
          off();
          done();
        });
      }),
    failed: () => st().showToast(t("compose.recover.failed"), undefined, "error"),
  });
}
