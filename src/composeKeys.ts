// Who owns a key while the compose body (a ProseMirror contenteditable) has the focus. One key, one action:
//  - Ctrl/Cmd+K       link UI inside an editor (like Outlook, Gmail, Word); the command bar everywhere else
//  - Ctrl/Cmd+Shift+K the command bar from anywhere, the message body and the signature / template editors included (W2.14); a compose window has no command bar: it does nothing there
//  - Ctrl/Cmd+Shift+B the app's "Show Bcc" (tooltip "Add Bcc (Ctrl+Shift+B)"); the editor's block quote shortcut is off
//  - Ctrl/Cmd+Enter   Send (and Ctrl/Cmd+Shift+Enter Send later); the editor's hard-break / exit-code shortcut is off
//  - Cmd+Option+Shift+V (macOS only) is "Paste and Match Style": the same text-only paste as Cmd+Shift+V, so the Cmd+Option guard below lets it through (W2.24); Ctrl+Alt+Shift+V on Windows and
//    Linux stays blocked (it is AltGr+Shift+V)
//  - Ctrl/Cmd+Alt+... the editor's heading / code block / paragraph shortcuts (Mod-Alt-0..6, Mod-Alt-C) are off, except Heading 1-3 (Mod-Alt-1..3, the Styles
//    menu's keys: see isHeadingKey, which lets the digit through only when it is really the digit and AltGr is not down): on Windows AltGr
//    is reported as Ctrl+Alt, so those shortcuts fired while the user typed "@", "\", "{", "[", "|", "~", "€", "ć", "²" ...
// Everything else in the editor (Ctrl+B / I / U, Ctrl+Z / Y / Shift+Z, Ctrl+Shift+7 / 8 lists, and the keys of editor/extensions.ts: Ctrl+= / Ctrl+Shift+= sub / superscript,
// Ctrl+] / [ font size, Ctrl+Space / Ctrl+\ clear formatting, Alt+F10 toolbar) stays. The editor has no key for strikethrough or inline code any more (Outlook: Ctrl+E is Center).

/** The bits of a KeyboardEvent the decision needs (a plain object in the tests). */
export type KeyLike = {
  key: string;
  /** the physical key (`KeyV`): with Option held a Mac reports the character it types (Option+Shift+V is "◊"), not the letter */
  code?: string;
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
 *  "paste-text"   macOS Cmd+Option+Shift+V in an editor: the editor's own text-only paste handler must see it (pasteOptions.tsx)
 *  "pass"         nothing special: the editor and the app handle it as they always did
 */
export type KeyAction = "command-bar" | "insert-link" | "editor-skip" | "paste-text" | "pass";

/** AltGr: reported with the AltGraph modifier state, and on Windows also as Ctrl+Alt (Ctrl and Alt both down). Real Ctrl+Alt is treated the same: the app has no Ctrl+Alt shortcut. */
export const isAltGraph = (e: KeyLike): boolean => e.getModifierState?.("AltGraph") === true || (e.ctrlKey && e.altKey && !e.metaKey);

/**
 * Ctrl/Cmd+Alt+1, 2, 3 are Heading 1-3 (Word, spec-rich-text.md 4.8). They are the one Ctrl+Alt shortcut the editor keeps, and only when the key really
 * is the digit and the browser does not say AltGr is down: on a German keyboard AltGr+2 / AltGr+3 type ² and ³ (the key is then "²" / "³"), and
 * on a French one the digit row types symbols, so neither is ever mistaken for a heading shortcut.
 */
export const isHeadingKey = (e: KeyLike): boolean =>
  (e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3") && e.getModifierState?.("AltGraph") !== true;

/** The V key, also with Option held (a Mac types "√" / "◊" then): the letter or the physical key. */
export const isVKey = (e: Pick<KeyLike, "key" | "code">): boolean => e.key.toLowerCase() === "v" || e.code === "KeyV";

/** `os` is only given by the editors (editorKeyHandlers): Cmd+Option+Shift+V is the text-only paste on a Mac and nothing on the other systems. */
export function keyAction(e: KeyLike, ctx: { inEditor: boolean; os?: string }): KeyAction {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (ctx.inEditor && isHeadingKey(e)) return "pass";
  // AltGr + a letter or digit types a character: neither the editor's shortcuts nor the app's may run
  if (isAltGraph(e)) return ctx.inEditor ? "editor-skip" : "pass";
  if (ctx.inEditor && ctx.os === "macos" && e.metaKey && !e.ctrlKey && e.shiftKey && e.altKey && isVKey(e)) return "paste-text";
  if (mod && e.altKey && ctx.inEditor) return "editor-skip"; // Cmd+Option on a Mac: the editor's heading / code block shortcuts are off too
  if (mod && e.shiftKey && !e.altKey && k === "k") return "command-bar"; // (in an editor too: it is the one way to the command bar from the body)
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

/** Ctrl/Cmd+B folds or opens the side menu. Not in a field, not in the message being written (Bold is Ctrl+B there), not with a dialog open. */
export function sidebarToggleKey(e: KeyLike, ctx: { inField: boolean; inCompose: boolean; modalOpen: boolean }): boolean {
  if (ctx.inField || ctx.inCompose || ctx.modalOpen || isAltGraph(e)) return false;
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b";
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
 * returns true, and leaves the default action of the key alone, so AltGr characters are typed. `os` (a function: osNow) lets Cmd+Option+Shift+V reach the paste handler on a Mac.
 */
export function editorKeyHandlers(onLink: () => void, os?: () => string) {
  return {
    keydown: (_view: unknown, e: KeyboardEvent): boolean => {
      const a = keyAction(e, { inEditor: true, os: os?.() });
      if (a === "insert-link") {
        e.preventDefault();
        onLink();
        return true;
      }
      return a === "editor-skip";
    },
  };
}
