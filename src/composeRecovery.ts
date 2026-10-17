// The question at the start of the app: "Restore your unsaved message?" (QA round 17 BUG-02). The sequence itself is in recovery.ts; this
// connects it to the store, the backend and the texts.

import { api } from "./api";
import { t } from "./i18n";
import { composeFromSnapshot, offerRecovery, snapshotInWindow, type RecoveryLoaded } from "./recovery";
import { useStore } from "./store";
import { startCompose } from "./popout/composeOpen";
import { fmtWhen } from "./util";

let asked = false;

/** Does the message of this snapshot come back in a window of its own? (It was written in one, or the setting says every message gets one.) */
const inWindow = (l: RecoveryLoaded) => snapshotInWindow(l) || !!useStore.getState().prefs.popoutCompose;

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
        st().showToast(() => t("compose.recover.failed"), undefined, "error");
        await api.recoveryClear(l.id).catch(() => undefined);
        return;
      }
      // (a message written in a window comes back in one, whatever the setting; the others follow the setting)
      // Every snapshot has a window key of its own: two messages restored in the same moment are two windows, not one (the page and the backend
      // both give the answer of an earlier ask to an ask for the same window).
      return startCompose(init, { window: snapshotInWindow(l) || undefined, shift: false, key: inWindow(l) ? `recovery:${l.id}` : undefined });
    },
    inWindow: (l) => inWindow(l),
    clear: (id) => api.recoveryClear(id),
    // (a restored message that opens in a window does not wait for the pane: the windows are independent of it)
    composing: () => !!st().compose && !st().prefs.popoutCompose,
    whenIdle: () =>
      new Promise<void>((done) => {
        const off = useStore.subscribe((s) => {
          if (s.compose) return;
          off();
          done();
        });
      }),
    failed: () => st().showToast(() => t("compose.recover.failed"), undefined, "error"),
  });
}
