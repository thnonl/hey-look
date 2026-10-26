// While a message is being written no mail is selected (F-21): every action that works on "the selected mail" (ribbon, shortcuts, command
// bar) has nothing to act on, so the old mail cannot be archived, deleted or answered by accident. Pure rules, tested by
// scripts/test-compose-selection.mjs; the store applies them in `openCompose` / `select`.

/** The conversations an action works on: the ticked ones, else the open one; none while a message is being written. */
export function actionTargets(checked: ReadonlySet<string>, selected: string | null, composing: boolean): string[] {
  if (composing) return [];
  if (checked.size > 0) return Array.from(checked);
  return selected ? [selected] : [];
}

/**
 * Which of the ribbon's buttons that work on the selected mail are usable. ONE answer for all of them (Delete, Archive, Report, Move to, Reply,
 * Reply all, Forward, Mark read / unread, Flag, Pin, Snooze), so none is forgotten: while a message is being written there is no selected mail,
 * even when a conversation is still listed as open, and every one of them is off.
 */
export function ribbonAvailability(targets: number, openMessages: number, composing: boolean, lastConfidential: boolean): { onSelection: boolean; reply: boolean; forward: boolean } {
  const reply = !composing && openMessages > 0;
  return { onSelection: !composing && targets > 0, reply, forward: reply && !lastConfidential };
}

/** Whether `select(id)` goes ahead: opening a mail while composing is `openMail` (leave the message first), nothing else may do it. */
export function mayOpenMail(id: string | null, composing: boolean): boolean {
  return id === null || !composing;
}

/**
 * Whether a click on the list row of `id` (`openMail`) opens nothing new (1.0.10): the conversation is the open one, it is loaded or its read is in flight, the last
 * open of it did not fail, and no message is being written. Then the reading pane is left alone (no fetch, no emptying, no remount of the mail frames, no new
 * mark as read). A failed open (`openError === id`) is tried again, and with a message being written the click still leaves it first.
 * `select` itself does not use this: the callers that re-select the same mail on purpose (the signature check after a key import, auto-advance, an encrypted
 * mail opened to ask for its passphrase) must reload.
 */
export function isReopen(s: { selected: string | null; messages: readonly unknown[]; openError: string | null; composing: boolean }, id: string, readingId: string | null): boolean {
  return !s.composing && s.selected === id && s.openError !== id && (s.messages.length > 0 || readingId === id);
}

/**
 * The conversation the reading pane returns to when the message being written closes (sent, discarded, saved) and the person did not pick
 * another mail meanwhile: the one that was open when writing began, if it is still in the list.
 */
export function selectionAfterCompose(before: string | null, selectedNow: string | null, listed: readonly string[]): string | null {
  return before && !selectedNow && listed.includes(before) ? before : null;
}
