// Open a link in the default browser or mail program.
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { osNow, usePlatform } from "./platform";

/**
 * Rejects when nothing could open the link. Linux goes through the backend, which waits for the launcher (`xdg-open` ...), starts
 * it without the AppImage's library paths and reports a failure; the opener plugin starts it detached and always reports success
 * there (BUG-L1). Windows and macOS use the opener plugin as before.
 */
export function openExternal(url: string): Promise<void> {
  if (usePlatform.getState().openFail) return Promise.reject(new Error("the browser is switched off for this test run")); // (a debug build started with HEYLOOK_TEST_OPEN_FAIL=1)
  return osNow() === "linux" ? api.openExternal(url) : openUrl(url);
}

/**
 * Put text on the clipboard; true only when it was really put there (a toast must not say "copied" otherwise). Every copy button of the app
 * goes through here. Three steps, in this order: Linux and macOS ask the backend (the GTK clipboard / the general pasteboard): the page's own
 * `navigator.clipboard` is missing or refused in WebKitGTK, and WKWebView refuses it once the click's user gesture is gone (a copy that follows
 * a backend call, "Copy public key"); the old code ignored the answer (QA BUG-L4). Then the page's clipboard. Then a hidden text box and
 * `document.execCommand("copy")`, which the click's gesture still allows where the clipboard API is refused. Windows starts at the second step.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (usePlatform.getState().copyFail) return false; // (a debug build started with HEYLOOK_TEST_COPY_FAIL=1)
  const os = osNow();
  if (os === "linux" || os === "macos") {
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
    /* try the text box */
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    const keep = document.activeElement as HTMLElement | null;
    document.body.appendChild(box);
    box.select();
    const done = document.execCommand("copy");
    box.remove();
    keep?.focus?.({ preventScroll: true });
    return done;
  } catch {
    return false;
  }
}
