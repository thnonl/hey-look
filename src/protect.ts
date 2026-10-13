import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, type CSSProperties, type ImgHTMLAttributes, type SyntheticEvent } from "react";
import { useStore } from "./store";

/**
 * Confidential mail (the sender set Sensitivity: Confidential or a Purview label such as "Highly Confidential"), the way
 * Outlook treats it: while one is on screen the window is excluded from screen capture and recording, and the message
 * can't be copied, printed, saved, forwarded or sent to the AI Assistant.
 *
 * Capture protection is the OS's own: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows, NSWindowSharingNone on
 * macOS. Screenshots, Snipping Tool, Teams / Zoom sharing and recordings show the window black. It does not stop a camera
 * pointed at the screen, and Linux has no equivalent (the call is accepted and does nothing).
 */
export const CONFIDENTIAL_NOTE = "Confidential: screen capture, copying, printing and forwarding are turned off for this message.";
export const CONFIDENTIAL_DENIED = "This message is confidential, so that isn’t allowed.";

let users = 0;

function setProtected(on: boolean) {
  try {
    void getCurrentWindow().setContentProtected(on).catch(() => undefined);
  } catch {
    // plain browser (dev mock): there is no native window
  }
}
// a reloaded page must not inherit the flag of the page before it
setProtected(false);

/** Print Screen: capture itself is already blocked, so also empty the clipboard in case an older Windows copied something. */
function onKey(e: KeyboardEvent) {
  if (e.key === "PrintScreen") {
    void navigator.clipboard?.writeText("").catch(() => undefined);
    if (e.type === "keydown") useStore.getState().showToast("Screen capture is turned off for confidential mail.", undefined, "info");
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
    e.preventDefault(); // the webview would print the whole window, message included
  }
}

/** Keep the window out of screen capture while `active` (any number of components may ask at once). */
export function useContentProtection(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (users++ === 0) {
      setProtected(true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
    }
    return () => {
      if (--users === 0) {
        setProtected(false);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
      }
    };
  }, [active]);
}

/** Is the message with this id, among the messages being read, confidential? */
export function isConfidentialId(id: string): boolean {
  return useStore.getState().messages.some((m) => m.id === id && m.confidential);
}

/** For actions that take mail out of the app (save, open outside, show source, ...): throws for confidential mail. */
export function denyIfConfidential(id: string) {
  if (isConfidentialId(id)) throw new Error(CONFIDENTIAL_DENIED);
}

/** Props for a picture shown outside the message frame (lightbox, preview) so the webview menu can't "save image as" or copy it. */
export function imageLock(on: boolean): Pick<ImgHTMLAttributes<HTMLImageElement>, "draggable" | "onContextMenu" | "onDragStart"> & { style: CSSProperties } {
  if (!on) return { style: {} };
  const stop = (e: SyntheticEvent) => e.preventDefault();
  return { draggable: false, onContextMenu: stop, onDragStart: stop, style: { userSelect: "none", WebkitUserSelect: "none" } };
}

/**
 * No selecting, copying, dragging or context menu inside a message frame, and nothing printed from it. Keys pressed while
 * the focus is in the frame never reach the window, so Ctrl+P and Print Screen are handled on the frame's document too.
 */
export const CONFIDENTIAL_FRAME_CSS =
  "*{-webkit-user-select:none!important;user-select:none!important;-webkit-user-drag:none!important}@media print{body{display:none!important}}";

export function lockDocument(doc: Document): () => void {
  const stop = (e: Event) => e.preventDefault();
  const events = ["copy", "cut", "contextmenu", "dragstart", "selectstart"];
  events.forEach((t) => doc.addEventListener(t, stop));
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("keyup", onKey, true);
  return () => {
    events.forEach((t) => doc.removeEventListener(t, stop));
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("keyup", onKey, true);
  };
}
