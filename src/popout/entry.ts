// "Open new messages, replies and forwards in a separate window" (Settings > Composing, `prefs.popoutCompose`, default off) and the
// modifier that does the opposite for one click or key press (REQ-C1, C2). WP6b calls `opensInWindow` at every entry point (New mail,
// Reply, Reply all, Forward: buttons, keys, tray, toast). Until then the setting is only stored and nothing reads it.

/** Does this action open a window? The setting says what the plain click / key does; Shift does the opposite. */
export function opensInWindow(setting: boolean, shift: boolean): boolean {
  return setting !== shift;
}

/** Shift held with nothing else: Ctrl / Alt / Meta with a click or key are other shortcuts, not "the opposite". */
export function shiftOnly(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}
