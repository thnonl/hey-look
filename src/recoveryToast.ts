// The one toast of a start that kept messages from the last session (1.0.6, replaces the question "Restore your unsaved message?").
// It is STICKY: no timer at all. It goes only when the person answers it: the X or Esc, Continue writing, Show all, or by opening the
// messages. It follows a language switch (its text is a function) and comes back when something took it off the screen without an answer
// (the window was hidden to the tray and shown again, a crowded stack). No UI and no Tauri here (the store and the opening are passed in), so
// it can be tested (scripts/test-recovery-toast.mjs).

import { t } from "./i18n/index.ts";
import type { Kept } from "./recovery.ts";

export const RECOVERY_TOAST_KEY = "recovered-messages";

/** What the toast puts on the screen (a part of the store's `setStickyToast` spec). */
export interface RecoverySpec {
  text: () => string;
  kind: "info";
  guide: true;
  escCloses: true;
  actions: { label: () => string; run: () => void }[];
  onDismiss: () => void;
  closeLabel: () => string;
}

export interface RecoveryToastDeps {
  /** put the toast (or, with null, take it) on the screen: the store's `setStickyToast` */
  setSticky(key: string, spec: RecoverySpec | null): void;
  /** is the toast on the screen now? */
  isShown(): boolean;
  /** Continue writing: open this message in Compose (like a draft of the Drafts folder, or from its snapshot). false = it could not be opened */
  open(item: Kept): Promise<boolean>;
  /** Show all, when everything is in Drafts: select the Drafts folder (of this account, else of all) */
  showDrafts(accountId: string | null): void;
  /** Show all, when something is only on this computer: the person picks a message to open, or the Drafts folder. Resolves with the ones that were opened. */
  pick(items: Kept[]): Promise<Kept[]>;
}

/** The whole text: a title line (how many messages Hey Look! kept) and a line saying where they are (saved in Drafts / kept on this computer / both). */
export function toastText(items: Kept[]): string {
  const drafts = items.filter((i) => i.where === "drafts").length;
  const local = items.length - drafts;
  if (drafts > 0 && local > 0) return t("compose.recover.toast.mixed", { n: items.length, drafts, local });
  return t(local > 0 ? "compose.recover.toast.local" : "compose.recover.toast.drafts", { n: items.length });
}

export function createRecoveryToast(d: RecoveryToastDeps) {
  let items: Kept[] = [];
  let answered = true;
  /** Continue writing is opening a message: the toast is answered, whatever else the opening makes the store say */
  let opening = false;

  const spec = (): RecoverySpec => {
    const now = items;
    const newest = [...now].sort((a, b) => b.savedAt - a.savedAt)[0];
    const allDrafts = now.every((i) => i.where === "drafts");
    const actions: RecoverySpec["actions"] = [
      {
        label: () => t("compose.recover.continue"),
        run: () => {
          void (async () => {
            let ok = false;
            opening = true;
            try {
              ok = await d.open(newest);
            } catch {
              ok = false;
            }
            opening = false;
            if (ok) {
              items = items.filter((i) => i.id !== newest.id);
              answered = true;
            } else {
              draw(); // (it could not be opened: the toast stays so that the person can try again)
            }
          })();
        },
      },
    ];
    if (now.length > 1) {
      actions.push({
        label: () => t(allDrafts ? "compose.recover.showAllDrafts" : "compose.recover.showAll"),
        run: () => {
          if (allDrafts) {
            answered = true;
            const accounts = new Set(now.map((i) => i.accountId));
            d.showDrafts(accounts.size === 1 ? [...accounts][0] : null);
            return;
          }
          void (async () => {
            const opened = await d.pick(now).catch(() => [] as Kept[]);
            items = items.filter((i) => !opened.some((o) => o.id === i.id));
            // what the person has not opened is still waiting: the toast comes back with those
            if (items.length > 0 && opened.length > 0) draw();
            else answered = true;
          })();
        },
      });
    }
    return {
      text: () => toastText(now),
      kind: "info",
      guide: true,
      escCloses: true,
      actions,
      onDismiss: () => {
        answered = true;
      },
      closeLabel: () => t("common.close"),
    };
  };

  const draw = () => {
    if (items.length === 0) {
      answered = true;
      d.setSticky(RECOVERY_TOAST_KEY, null);
      return;
    }
    answered = false;
    d.setSticky(RECOVERY_TOAST_KEY, spec());
  };

  return {
    /** The start kept these messages: say so (once; a second call replaces the first in place). */
    show(kept: Kept[]) {
      items = [...kept];
      draw();
    },
    /** Something may have taken the toast off the screen without an answer (the window was hidden and shown again): put it back. */
    reshow() {
      if (!answered && !d.isShown()) draw();
    },
    /** The person opened this message another way (its Compose is open): it needs no more telling about. */
    opened(id: string) {
      if (answered || opening || !items.some((i) => i.id === id)) return;
      items = items.filter((i) => i.id !== id);
      if (items.length === 0) {
        answered = true;
        d.setSticky(RECOVERY_TOAST_KEY, null);
      } else draw();
    },
    /** Is the toast waiting for an answer? */
    get pending() {
      return !answered;
    },
    get items() {
      return items;
    },
  };
}
