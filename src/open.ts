// Open a link in the default browser or mail program.
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { osNow } from "./platform";

/**
 * Rejects when nothing could open the link. Linux goes through the backend, which waits for the launcher (`xdg-open` ...), starts
 * it without the AppImage's library paths and reports a failure; the opener plugin starts it detached and always reports success
 * there (BUG-L1). Windows and macOS use the opener plugin as before.
 */
export function openExternal(url: string): Promise<void> {
  return osNow() === "linux" ? api.openExternal(url) : openUrl(url);
}

/**
 * Put text on the clipboard; true only when it was really put there (a toast must not say "copied" otherwise). Linux asks the
 * backend (the GTK clipboard): the page's own `navigator.clipboard` is missing or refused there once the click's user gesture is
 * gone, and the old code ignored the answer (QA BUG-L4). Windows and macOS keep the page's clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (osNow() === "linux") {
    try {
      await api.copyText(text);
      return true;
    } catch {
      /* try the page's own clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
