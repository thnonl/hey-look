// macOS: Cmd+Shift+V in a text box (To, Subject, a Settings field, the search box). WKWebView sends the page no `paste` event for that key (it is no
// accelerator of the Edit menu, whose Paste is Cmd+V), so nothing pasted. The editors catch the key themselves (editor/pasteOptions.tsx); this does it for the
// plain boxes: the clipboard text comes from the backend (read_clipboard_text) and is inserted the way typing inserts it, so the page's own input events,
// undo and controlled values keep working. A single-line box takes the line breaks as spaces, like a normal paste into it. Windows and Linux: unchanged.
import { api } from "./api";
import { osNow } from "./platform";

const TEXT_TYPES = new Set(["", "text", "search", "url", "tel", "email", "password"]);

/** Cmd+Shift+V, and Cmd+Option+Shift+V (the system's "Paste and Match Style" key, W2.24): both paste text only. With Option held the key is "◊", so the physical key decides. */
export const isCmdShiftV = (e: Pick<KeyboardEvent, "metaKey" | "shiftKey" | "altKey" | "ctrlKey" | "isComposing" | "key"> & { code?: string }): boolean =>
  e.metaKey && e.shiftKey && !e.ctrlKey && !e.isComposing && (e.altKey ? e.code === "KeyV" : e.key.toLowerCase() === "v");

export function installPlainPasteKey(): void {
  document.addEventListener("keydown", (e) => {
    if (osNow() !== "macos" || !isCmdShiftV(e) || e.defaultPrevented) return;
    const box = e.target;
    const input = box instanceof HTMLInputElement && TEXT_TYPES.has(box.type) ? box : null;
    if (!input && !(box instanceof HTMLTextAreaElement)) return; // the editors (contenteditable) paste for themselves
    if ((box as HTMLInputElement | HTMLTextAreaElement).readOnly || (box as HTMLInputElement | HTMLTextAreaElement).disabled) return;
    e.preventDefault();
    if (e.repeat) return;
    void api.readClipboardText().then(
      (c) => {
        const text = c.text;
        if (text && document.activeElement === box) document.execCommand("insertText", false, input ? text.replace(/\s*\r?\n\s*/g, " ") : text);
      },
      () => {}, // no clipboard text we can read: nothing is pasted
    );
  });
}
