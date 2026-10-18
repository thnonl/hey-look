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
 * The conversation the reading pane returns to when the message being written closes (sent, discarded, saved) and the person did not pick
 * another mail meanwhile: the one that was open when writing began, if it is still in the list.
 */
export function selectionAfterCompose(before: string | null, selectedNow: string | null, listed: readonly string[]): string | null {
  return before && !selectedNow && listed.includes(before) ? before : null;
}
