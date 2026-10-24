// Linux: Ctrl+Q quits Hey Look! (D-021), the key many Linux apps use. It is the tray's "Quit Hey Look!": the page only tells the backend that the key was
// pressed (the `quit-key` event), and the backend runs the same quit as the tray item (src-tauri/src/lib.rs `request_quit`), so the question about scheduled
// messages, the draft that is saved and the sends that go out come first. Windows and macOS: no such key here (macOS has Cmd+Q in its app menu).
import { emit } from "@tauri-apps/api/event";
import { osNow, type Os } from "./platform";

export const QUIT_KEY_EVENT = "quit-key";

type KeyInfo = Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing" | "repeat" | "key"> & { code?: string };

/**
 * Is this Ctrl+Q on Linux? Plain Ctrl+Q only (no Shift / Alt / Super). The letter is the one the layout makes: on a Latin layout the key is "q" whatever the code
 * is (AZERTY has Q where QWERTY has A), a layout without Latin letters (Russian, Greek) is told by its physical Q key like GTK's accelerators do. A held key is one press.
 */
export const isQuitKey = (e: KeyInfo, os: Os): boolean =>
  os === "linux" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !e.isComposing && !e.repeat && (e.key.toLowerCase() === "q" || (!/^[a-z]$/i.test(e.key) && e.code === "KeyQ"));

/** The key handler of one document (the window's, or the document of a message frame). */
export function quitKeyHandler(os: () => Os = osNow): (e: KeyboardEvent) => void {
  return (e) => {
    if (!isQuitKey(e, os())) return;
    e.preventDefault();
    if (!("__TAURI_INTERNALS__" in window)) return; // (a plain browser has no backend to quit)
    void emit(QUIT_KEY_EVENT).catch(() => undefined);
  };
}

const onKey = quitKeyHandler();

/** The window's listener (capture phase, so a text box or editor that has the focus does not matter). */
export function installQuitKey(): void {
  window.addEventListener("keydown", onKey, true);
}

/** The same for the document of a message's frame (a key pressed there never reaches the window). Returns the remover. */
export function guardFrameQuitKey(doc: Document): () => void {
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
