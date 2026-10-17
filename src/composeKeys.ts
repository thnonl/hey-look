// Who owns a key while the compose body (a ProseMirror contenteditable) has the focus. One key, one action:
//  - Ctrl/Cmd+K       link UI inside an editor (like Outlook, Gmail, Word); the command bar everywhere else
//  - Ctrl/Cmd+Shift+B the app's "Show Bcc" (tooltip "Add Bcc (Ctrl+Shift+B)"); the editor's block quote shortcut is off
//  - Ctrl/Cmd+Enter   Send (and Ctrl/Cmd+Shift+Enter Send later); the editor's hard-break / exit-code shortcut is off
//  - Ctrl/Cmd+Alt+... the editor's heading / code block / paragraph shortcuts (Mod-Alt-0..6, Mod-Alt-C) are off: on Windows AltGr
//    is reported as Ctrl+Alt, so those shortcuts fired while the user typed "@", "\", "{", "[", "|", "~", "€", "ć", "²" ...
// Everything else in the editor (Ctrl+B / I / U, Ctrl+Z / Y / Shift+Z, Ctrl+Shift+7 / 8 lists, and the keys of editor/extensions.ts: Ctrl+= / Ctrl+Shift+= sub / superscript,
// Ctrl+] / [ font size, Ctrl+Space / Ctrl+\ clear formatting, Alt+F10 toolbar) stays. The editor has no key for strikethrough or inline code any more (Outlook: Ctrl+E is Center).

/** The bits of a KeyboardEvent the decision needs (a plain object in the tests). */
export type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?(k: "AltGraph"): boolean;
};

/**
 *  "command-bar"  open the command bar
 *  "insert-link"  open the link UI of the focused editor
 *  "editor-skip"  the editor must not run its own shortcuts for this key (the app, or the character the user types, owns it)
 *  "pass"         nothing special: the editor and the app handle it as they always did
 */
export type KeyAction = "command-bar" | "insert-link" | "editor-skip" | "pass";

/** AltGr: reported with the AltGraph modifier state, and on Windows also as Ctrl+Alt (Ctrl and Alt both down). Real Ctrl+Alt is treated the same: the app has no Ctrl+Alt shortcut. */
export const isAltGraph = (e: KeyLike): boolean => e.getModifierState?.("AltGraph") === true || (e.ctrlKey && e.altKey && !e.metaKey);

export function keyAction(e: KeyLike, ctx: { inEditor: boolean }): KeyAction {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // AltGr + a letter or digit types a character: neither the editor's shortcuts nor the app's may run
  if (isAltGraph(e)) return ctx.inEditor ? "editor-skip" : "pass";
  if (mod && e.altKey && ctx.inEditor) return "editor-skip"; // Cmd+Option on a Mac: the editor's heading / code block shortcuts are off too
  if (mod && !e.altKey && k === "k") return ctx.inEditor ? "insert-link" : "command-bar";
  if (ctx.inEditor && mod && !e.altKey) {
    if (e.shiftKey && k === "b") return "editor-skip";
    if (k === "Enter") return "editor-skip";
  }
  return "pass";
}

/**
 * The app's own keys that act on the mailbox or the window (not on the text): who may run them while a message is being written.
 * The compose pane is modal for them: with the focus on one of its buttons (the toolbar, Attach, a chip ...) a key such as Ctrl+1 / 2 (switch
 * Mail / Calendar) or j / k (next / previous conversation) must not run, because they are not meant for what is on the screen in front of
 * the person; Ctrl+2 from the toolbar used to unmount the composer and the typed text was gone (QA round 17, A-24).
 *  - inField   the focus is in an input, a textarea, a select or a contenteditable (the app never takes keys from there)
 *  - inCompose the focus is anywhere inside the compose pane
 *  - modalOpen a dialog, the command bar or an ask dialog is open
 */
export type ModuleKey = "go-mail" | "go-calendar" | null;
export function moduleSwitchKey(e: KeyLike, ctx: { inField: boolean; inCompose: boolean; modalOpen: boolean }): ModuleKey {
  if (ctx.inField || ctx.inCompose || ctx.modalOpen || isAltGraph(e)) return null;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null;
  return e.key === "1" ? "go-mail" : e.key === "2" ? "go-calendar" : null;
}

/**
 * Whether an open compose pane swallows an app key. With a message open every mailbox shortcut is off, except j / k when the focus is
 * outside the pane (the list or the folder pane): those still go on to the next / previous conversation (F-21). Inside the pane nothing runs.
 */
export function composeSwallowsAppKey(e: KeyLike, ctx: { composeOpen: boolean; inCompose: boolean; module: "mail" | "calendar" }): boolean {
  if (!ctx.composeOpen) return false;
  if (ctx.inCompose) return true;
  const plainJK = (e.key === "j" || e.key === "k") && ctx.module === "mail" && !e.ctrlKey && !e.metaKey && !e.altKey;
  return !plainJK;
}

/** The element that has the key focus is an editable region (ProseMirror compose body, signature editor ...). */
export const inEditable = (target: EventTarget | null): boolean => typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable;

/**
 * `editorProps.handleDOMEvents` for a TipTap editor. ProseMirror skips its own key handling (and so every TipTap keymap) when this
 * returns true, and leaves the default action of the key alone, so AltGr characters are typed.
 */
export function editorKeyHandlers(onLink: () => void) {
  return {
    keydown: (_view: unknown, e: KeyboardEvent): boolean => {
      const a = keyAction(e, { inEditor: true });
      if (a === "insert-link") {
        e.preventDefault();
        onLink();
        return true;
      }
      return a === "editor-skip";
    },
  };
}
