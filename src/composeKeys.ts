import type { Editor } from "@tiptap/react";

// Who owns a key while the compose body (a ProseMirror contenteditable) has the focus. One key, one action:
//  - Ctrl/Cmd+K       link UI inside an editor (like Outlook, Gmail, Word); the command bar everywhere else
//  - Ctrl/Cmd+Shift+B the app's "Show Bcc" (tooltip "Add Bcc (Ctrl+Shift+B)"); the editor's block quote shortcut is off
//  - Ctrl/Cmd+Enter   Send (and Ctrl/Cmd+Shift+Enter Send later); the editor's hard-break / exit-code shortcut is off
//  - Ctrl/Cmd+Alt+... the editor's heading / code block / paragraph shortcuts (Mod-Alt-0..6, Mod-Alt-C) are off: on Windows AltGr
//    is reported as Ctrl+Alt, so those shortcuts fired while the user typed "@", "\", "{", "[", "|", "~", "€", "ć", "²" ...
// Everything else in the editor (Ctrl+B / I / U, Ctrl+Z / Y / Shift+Z, Ctrl+Shift+7 / 8 lists, Ctrl+Shift+S strike, Ctrl+E code) stays.

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

/**
 * The link UI: the toolbar button and Ctrl/Cmd+K. With a selection it links the selection; in a link it edits (an empty address
 * removes) that link; at a bare caret it inserts the address as the link text. `ask` returns the address, or null when cancelled.
 */
export function editLink(editor: Editor, ask: (current: string) => string | null) {
  const current = (editor.getAttributes("link").href as string | undefined) ?? "";
  const answer = ask(current);
  if (answer === null) return;
  const href = answer.trim();
  const chain = editor.chain().focus();
  if (!href) {
    if (current) chain.extendMarkRange("link").unsetLink().run();
    return;
  }
  if (editor.state.selection.empty && !editor.isActive("link")) {
    const from = editor.state.selection.from;
    chain.insertContent({ type: "text", text: href }).setTextSelection({ from, to: from + href.length }).setLink({ href }).setTextSelection(from + href.length).run();
  } else {
    chain.extendMarkRange("link").setLink({ href }).run();
  }
}
