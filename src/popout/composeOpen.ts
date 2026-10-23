// Start a message: in the main window (the inline Compose pane, as always) or in a window of its own (REQ-C1, C2). Every way of starting
// one ends here: New mail (ribbon, command bar, key `c`, tray), Reply / Reply all / Forward (buttons, keys, the menu of a row, a notification,
// the reader window), Attach to a new mail, Unsubscribe by mail, a draft from the Drafts folder, a message restored after a crash.
// The setting says what the plain click or key does and Shift does the opposite (entry.ts, modifier.ts); a caller that knows better says so:
// `window: true` (the reader window always answers in a compose window, REQ-R5; a draft that has a double-click) or `window: false`.
import { api } from "../api";
import { hasMailAccounts } from "../mailControls";
import { useStore, type ComposeInit } from "../store";
import { opensInWindow } from "./entry";
import { shiftNow } from "./modifier";
import { openPopout, openPopoutInfo } from "./open";
import type { ShellStart } from "../answerShell.ts";

export interface StartOpts {
  /** the window decides by itself: true = a window, false = the main window; undefined = the setting and Shift decide */
  window?: boolean;
  /** Shift was held; undefined = the click or key being handled says (modifier.ts) */
  shift?: boolean;
  /** one window per key: asking again brings the window that has it to the front (answerKey / draftKey) */
  key?: string | null;
}

/** Does a message started now open in a window? (The ribbon uses it to know whether the inline pane will be taken.) */
export function wantsWindow(o: Pick<StartOpts, "window" | "shift"> = {}): boolean {
  return o.window ?? opensInWindow(useStore.getState().prefs.popoutCompose, o.shift ?? shiftNow());
}

/**
 * Open `init` as a new message. Resolves to true when it was opened (or its window was brought forward), false when nothing was: no mailbox,
 * the person kept writing the message in the pane, or the window could not be made (the toast of `openPopout` said why).
 */
export async function startCompose(init: ComposeInit, o: StartOpts = {}): Promise<boolean> {
  const st = useStore.getState();
  if (!hasMailAccounts(st.accounts.length)) return false; // no account: there is nothing to send with
  if (!wantsWindow(o)) {
    await st.openCompose(init);
    return !!useStore.getState().compose;
  }
  return openPopout("compose", o.key ?? null, init);
}

/**
 * Open the shell of a Reply / Reply all / Forward (`init.preparing`, answerShell.ts) in the pane or in a window, and say where it is. In the pane `ok` means the shell is the compose now
 * (not when the person kept writing another message, or there is no mailbox); in a window `fresh` is false when a window of this answer was there and was only brought forward.
 */
export async function startShell(init: ComposeInit, o: StartOpts = {}): Promise<ShellStart> {
  const st = useStore.getState();
  if (!hasMailAccounts(st.accounts.length)) return { ok: false }; // no account: there is nothing to send with
  if (!wantsWindow(o)) {
    await st.openCompose(init);
    return useStore.getState().compose?.preparing?.id === init.preparing?.id ? { ok: true, where: "pane" } : { ok: false };
  }
  const r = await openPopoutInfo("compose", o.key ?? null, init);
  return r ? { ok: true, where: "window", label: r.label, fresh: r.status === "created" } : { ok: false };
}

/**
 * A draft is open in one editor only (REQ-C9): when a compose window shows it, that window is brought forward. True = it was.
 * Asked before the draft is read, by the inline editor and by a window alike.
 */
export async function focusDraftWindow(key: string): Promise<boolean> {
  try {
    return (await api.popoutOpen("compose", key, null, true)).status === "focused";
  } catch {
    return false;
  }
}
