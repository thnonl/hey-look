// What the app does at the start with the messages that were being written when it ended without saving or sending them (QA round 17 BUG-02;
// 1.0.6: no question any more). Every snapshot is saved as a real draft in the background (recovery.ts `settleRecovery`, backend
// `recovery_save_draft`); what cannot be saved stays on this computer. One sticky toast says what was kept and where (recoveryToast.ts), with
// Continue writing. Nothing is opened, sent or discarded unasked.

import { api } from "./api";
import { openDraftThread } from "./components/Compose";
import { t } from "./i18n";
import { openKept as openKeptMessage, settleRecovery, type Kept } from "./recovery";
import { createRecoveryToast, RECOVERY_TOAST_KEY } from "./recoveryToast";
import { useStore } from "./store";
import { startCompose } from "./popout/composeOpen";
import { fmtWhen } from "./util";

let started = false;

/** Continue writing (recovery.ts `openKept` decides how the message opens). */
const openKept = (k: Kept) =>
  openKeptMessage(k, {
    // (the draft was only just saved: the local copy may not be there yet, openDraftThread asks the sync for it)
    openDraft: (threadId, o) => openDraftThread(threadId, true, o),
    loadSnapshot: (id) => api.recoveryLoad(id),
    start: (init, o) => startCompose(init, o),
    popoutSetting: () => !!useStore.getState().prefs.popoutCompose,
    notFound: () => useStore.getState().showToast(() => t("compose.leave.draftNotFound"), undefined, "error"),
  });

/** The people's choice among the messages that are only on this computer (and the Drafts folder, when some are saved there). */
async function pickKept(items: Kept[]): Promise<Kept[]> {
  const st = useStore.getState();
  const local = items.filter((i) => i.where === "local").sort((a, b) => b.savedAt - a.savedAt).slice(0, 6);
  const drafts = items.some((i) => i.where === "drafts");
  const label = (k: Kept) => `${k.subject || t("compose.recover.list.noSubject")} · ${fmtWhen(k.savedAt)}`;
  const answer = await st.choose({
    title: t("compose.recover.list.title"),
    body: t("compose.recover.list.body"),
    // (Esc and a click outside answer with the first choice: Close)
    choices: [
      { id: "close", label: t("common.close") },
      ...local.map((k) => ({ id: `open:${k.id}`, label: label(k), kind: "primary" as const })),
      ...(drafts ? [{ id: "drafts", label: t("compose.recover.list.openDrafts") }] : []),
    ],
  });
  if (answer === "drafts") {
    const ids = new Set(items.map((i) => i.accountId));
    void useStore.getState().setView("drafts", ids.size === 1 ? [...ids][0] : null);
    return items.filter((i) => i.where === "drafts");
  }
  const k = local.find((x) => `open:${x.id}` === answer);
  return k && (await openKept(k)) ? [k] : [];
}

const toast = createRecoveryToast({
  setSticky: (key, spec) => useStore.getState().setStickyToast(key, spec),
  isShown: () => useStore.getState().toasts.some((x) => x.key === RECOVERY_TOAST_KEY),
  open: openKept,
  showDrafts: (accountId) => void useStore.getState().setView("drafts", accountId),
  pick: pickKept,
  drop: (k) => api.recoveryClear(k.id, "toast dismissed, nothing but recipients"),
});

/** A sync that is running began before the drafts were saved (and a second ask while one runs does nothing): wait for it to end, then sync once more so that Drafts shows them. */
function syncAfterSave(): void {
  const go = () => void useStore.getState().sync();
  if (!useStore.getState().syncing) return go();
  const off = useStore.subscribe((s) => {
    if (s.syncing) return;
    off();
    go();
  });
}

/** The window was hidden (tray) and is shown again: a toast nobody answered is put back if anything took it off the screen. */
export function reshowRecoveryToast(): void {
  toast.reshow();
}

/** Once per start: save what was left from the last session as drafts, then say so with one toast. Never blocks the start. */
export async function recoverUnsaved(): Promise<void> {
  if (started) return;
  started = true;
  const kept = await settleRecovery({
    list: () => api.recoveryList(),
    load: (id) => api.recoveryLoad(id),
    saveDraft: (id, draft, replaces) => api.recoverySaveDraft(id, draft, replaces),
    clear: (id, why) => api.recoveryClear(id, why),
    now: () => Math.floor(Date.now() / 1000),
  });
  if (kept.length === 0) return;
  // the drafts are on the server: let the Drafts folder show them
  if (kept.some((k) => k.where === "drafts")) syncAfterSave();
  toast.show(kept);
  // a message of the toast that is opened another way (its Compose is up) needs no more telling about
  useStore.subscribe((s, prev) => {
    const id = s.compose?.recoveryId;
    if (id && s.compose !== prev.compose) toast.opened(id);
  });
}
