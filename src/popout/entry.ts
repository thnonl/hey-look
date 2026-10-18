// "Open new messages, replies and forwards in a separate window" (Settings > Composing, `prefs.popoutCompose`, default off) and the
// modifier that does the opposite for one click or key press (REQ-C1, C2). `startCompose` (composeOpen.ts) calls `opensInWindow` for every
// way of starting a message (New mail, Reply, Reply all, Forward, a draft: buttons, keys, tray, notification); Shift comes from modifier.ts.

/** Does this action open a window? The setting says what the plain click / key does; Shift does the opposite. */
export function opensInWindow(setting: boolean, shift: boolean): boolean {
  return setting !== shift;
}

/** Shift held with nothing else: Ctrl / Alt / Meta with a click or key are other shortcuts, not "the opposite". */
export function shiftOnly(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}

// ---- which window shows what (the key of `popout_open`: asking again for the same thing focuses the window that has it)

export type AnswerMode = "reply" | "replyAll" | "forward";

/**
 * A reply, a reply to all and a forward of the same message each have one window: pressing Reply twice brings the first one forward instead
 * of opening a second (the keys of a window that is on its way out are freed, popout.rs `popout_park`).
 */
export function answerKey(mode: AnswerMode, messageId: string): string {
  return `${mode === "reply" ? "re" : mode === "replyAll" ? "ra" : "fw"}:${messageId}`;
}

/** A saved draft is open in one window only (REQ-C9). `threadId`: the draft's conversation in the Drafts folder. */
export function draftKey(threadId: string): string {
  return `draft:${threadId}`;
}

/** A scheduled message opened for editing is open in one editor only (W2.10): its pause (`outbox_open_for_edit`) belongs to that editor. */
export function outboxKey(outboxId: string): string {
  return `outbox:${outboxId}`;
}
