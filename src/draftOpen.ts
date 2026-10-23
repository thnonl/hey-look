import { api, InlineImage } from "./api";
import { friendlyError, useStore } from "./store";
import { t as tNow } from "./i18n";
import { askUnlock } from "./components/Pgp";
import { nameInlinePicture } from "./editor/messageBody";
import { fillDeferred } from "./deferredParts";
import { decodeMeeting } from "./meetingDraft";
import { splitRecipients } from "./recipients";
import { composeSeam } from "./popout/composeSeam";
import { focusDraftWindow, startCompose, wantsWindow, type StartOpts } from "./popout/composeOpen";
import { draftKey } from "./popout/entry";
import { shiftNow } from "./popout/modifier";

// Opening a draft (and the helpers every way of opening a message needs) without the editor: the list, the scheduled list, the crash recovery and the compose hub import this, so
// the editor stack (components/Compose.tsx) can be loaded on demand (WP9d). They used to live in Compose.tsx.

/**
 * Open a draft (a conversation of the Drafts folder) in Compose, with its pictures and attachments, asking for the key of an encrypted
 * one. `wait`: the draft was only just saved, so the local copy may not be there yet: the sync is asked for it a few times.
 * Returns whether Compose was opened. It opens in the pane or in a window of its own like any message (the setting and Shift, or `o.window`);
 * a draft is open in one editor only: when a window shows it already, that window comes forward and nothing is opened (REQ-C9).
 */
export async function openDraftThread(threadId: string, wait = false, o: StartOpts = {}): Promise<boolean> {
  const shift = o.shift ?? shiftNow(); // (read now: the draft is fetched first)
  const key = draftKey(threadId);
  const mine = ++latestDraftOpen;
  // the one check of every entry point (click, double click, Shift, Enter, context menu, command bar, the toast's Edit, crash restore): the pane
  // already shows this draft, so it gets the focus and nothing else opens, before anything is read (W2.11)
  if (inlineHasDraft(threadId)) return focusInlineEditor();
  if (await focusDraftWindow(key)) return true;
  // a draft can take seconds to open (a large one: it is decrypted and its pictures are read): the row shows a ring at once and the pane a status after 150 ms
  // (REQ-13.7.1, D-044). The one that opens last owns the ring; one that is overtaken leaves it to the newer one.
  ringOwner = mine;
  useStore.getState().setOpeningDraft(threadId);
  try {
    return await readDraft(threadId, wait, o, shift, key, mine);
  } finally {
    if (ringOwner === mine) useStore.getState().setOpeningDraft(null);
  }
}
/** Which opening of a draft owns the ring on its row (`openDraftThread`). */
let ringOwner = 0;

async function readDraft(threadId: string, wait: boolean, o: StartOpts, shift: boolean, key: string, mine: number): Promise<boolean> {
  const st = useStore.getState();
  // (`light`: no bodies: the body and the attachments come from `draftEditorParts` below, one read of the message instead of one per picture)
  let msgs = await api.getThread(threadId, "drafts", true);
  for (let i = 0; wait && !msgs.some((x) => x.folder === "drafts") && i < 4; i++) {
    await useStore.getState().sync();
    msgs = await api.getThread(threadId, "drafts", true);
    if (!msgs.some((x) => x.folder === "drafts")) await new Promise((r) => setTimeout(r, 1200));
  }
  let m = msgs.filter((x) => x.folder === "drafts").pop() ?? msgs[msgs.length - 1];
  if (!m) {
    if (wait) st.showToast(() => tNow("compose.leave.draftNotFound"), undefined, "error");
    return false;
  }
  // a draft that was encrypted to your own key needs the key (and its passphrase) to be opened again
  if (m.security?.encrypted && m.security.decryption !== "ok") {
    if (m.security.decryption === "locked" && m.security.lockedKey && (await askUnlock(m.security.lockedKey, "draft", m.security.lockedLabel ?? undefined))) {
      m = await api.pgpDecryptMessage(m.id, undefined, undefined, true).catch(() => m);
    }
    if (m.security?.decryption !== "ok") {
      if (m.security?.decryption !== "locked") st.showToast(() => tNow("mail.draft.cannotOpen", { error: friendlyError(m.security?.error ?? tNow("mail.draft.keyMissing")) }), undefined, "error");
      return false;
    }
  }
  if (mine !== latestDraftOpen) return false; // another draft was asked for meanwhile (the second click of a double click): only the last one opens
  // restore pictures and attachments so saving or sending the draft does not silently drop them; the recipients as they were typed (names, Bcc) come from the draft's own
  // headers (the synced copy has bare To / Cc and no Bcc). Both are asked for at once: they read the message, they do not wait for each other.
  const [first, rc] = await Promise.all([api.draftEditorParts(m.id), api.draftRecipients(m.id).catch(() => null)]);
  // (the data of big pictures comes in requests of its own: deferredParts.ts; when a piece is gone the parts are asked for whole)
  const parts = await fillDeferred(first, api.draftData).catch(() => api.draftEditorParts(m.id, true));
  const { html, attachments } = parts;
  if (mine !== latestDraftOpen) return false;
  // without the draft's own headers the Bcc recipients are unknown: say so, a send would leave them out
  if (!rc) st.showToast(() => tNow("compose.draft.bccUnread"), undefined, "error");
  const keyBefore = st.composeKey;
  await startCompose({
    accountId: m.accountId,
    to: rc?.to ?? (m.to ? splitRecipients(m.to) : []),
    cc: rc?.cc ?? (m.cc ? splitRecipients(m.cc) : []),
    bcc: rc?.bcc,
    // the threading headers of the saved draft: an answer that was saved goes out threaded as it would have before
    inReplyTo: rc?.inReplyTo ?? null,
    references: rc?.references ?? [],
    answers: rc?.answers ?? undefined, // (a reply or forward that was saved: sending it later still flags the original)
    subject: m.subject === "(no subject)" ? "" : m.subject,
    bodyHtml: html ?? `<p>${(parts.text ?? "").replace(/\n/g, "<br>")}</p>`,
    replaces: `m:${m.id}`, // the message that was opened: saving or sending replaces that one, not other drafts of the conversation
    draftKey: key, // (a Pop out of this pane gives the window this key: asking for the same draft again focuses that window)
    attachments,
    security: m.security?.encrypted ? { encrypt: true, sign: false, attachPublicKey: false } : undefined,
    confidential: m.confidential,
    importance: m.importance,
    // the meeting that was on when the draft was saved: from its private header (else the copy this computer kept), checked here (meetingDraft.ts)
    meetingForm: decodeMeeting(rc?.meeting) ?? undefined,
  }, { ...o, shift, key });
  // the draft is open in the pane (not in a window): a double click moves it to a window instead of opening it twice (openDraftInWindow), and
  // asking for it again focuses the pane (a question about another message in the pane, answered with Cancel, leaves the pane as it was)
  if (!wantsWindow({ window: o.window, shift }) && useStore.getState().composeKey !== keyBefore) inlineDraft = { threadId, composeKey: useStore.getState().composeKey, tids: new Set([threadId]) };
  return true;
}

/**
 * The draft that was last opened in the pane, which opening of the pane it was, and the conversations of the Drafts folder it is: the one it was
 * opened from and the ones its saves made (an autosave replaces the draft, so the list shows it under a new id).
 */
let inlineDraft: { threadId: string; composeKey: number; tids: Set<string> } | null = null;

/** The pane that is open now shows this conversation of the Drafts folder. (Never true in a compose window: it has no pane.) */
export function inlineHasDraft(threadId: string): boolean {
  const st = useStore.getState();
  return !composeSeam() && !!st.compose && !!inlineDraft && inlineDraft.composeKey === st.composeKey && inlineDraft.tids.has(threadId);
}

/** The pane's message got a draft (a save): that conversation is the pane's too. Called by the Compose of the pane. */
export function noteInlineDraft(tid: string): void {
  if (composeSeam()) return;
  const st = useStore.getState();
  if (!st.compose) return;
  if (!inlineDraft || inlineDraft.composeKey !== st.composeKey) inlineDraft = { threadId: tid, composeKey: st.composeKey, tids: new Set() };
  inlineDraft.tids.add(tid);
}

/** Bring the main window forward and put the caret in the pane's body. Resolves to true (the draft is shown: nothing else is to be opened). */
export function focusInlineEditor(): boolean {
  void api.showWindow().catch(() => undefined);
  const body = document.querySelector<HTMLElement>(".compose-pane .ProseMirror");
  body?.focus();
  return true;
}
/** Counts the openings of a draft: one that is overtaken by a newer one gives up. */
let latestDraftOpen = 0;

/**
 * A draft in a window of its own (double click or Shift+Enter on a row of the Drafts folder, REQ-C1). The first click of a double click has
 * opened it in the pane: when that is the draft still untouched it is closed first, so it is never open in two editors.
 */
export async function openDraftInWindow(threadId: string): Promise<boolean> {
  const st = useStore.getState();
  if (inlineDraft?.threadId === threadId && st.compose && st.composeKey === inlineDraft.composeKey && !st.composeDirty) await st.openCompose(null, { restore: false });
  return openDraftThread(threadId, false, { window: true });
}

/** Replace cid: references with the pictures' data: URIs (used when a sent or scheduled draft is reopened). */
export function picturesToEditor(html: string, pics: InlineImage[]): string {
  // (the file name each picture was added with goes back on it, so the reopened message sends it under that name)
  return pics.reduce((h, p) => nameInlinePicture(h.split(`cid:${p.cid}`).join(`data:${p.mime};base64,${p.dataBase64}`), p.dataBase64, p.filename), html);
}

