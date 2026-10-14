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
