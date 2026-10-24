// The document of the message frame (1.0.7 fix35). It is WRITTEN into the frame (`document.open / write / close` on the frame's own empty document) instead of being handed over as the
// `srcdoc` attribute. Why: Mac QA (fix33, WebKit): selecting a 2 MB mail again and again grew the main page's WebContent by about the size of the mail per selection (bmalloc,
// JS strings; the DOM did not grow). A `srcdoc` frame costs a copy of the whole text as an attribute value, a navigation of the frame (which WebKit records in the page's session history)
// and the one big string React keeps for the attribute; a written document costs the parse and nothing else, and the text is handed over in pieces (head, mail, tail) so the one
// concatenated string of the mail is never made. Chromium behaves the same either way, so the counters below are tested there (scripts/test-mail-frame-history.mjs) and read on a Mac
// through the test bridge (`/eval` `window.__mailFrame`, rows WK-35.C in webkit-checks-107.md).

/** Counters of the message frames of this page, for the test and the QA bridge. `live` and the history lengths are read when asked. */
export const mailFrameStats = { created: 0, removed: 0, writes: 0, fallbacks: 0 };

/** Writes the document into the frame's own (empty) document. False when the frame has none (then the caller sets `srcdoc`). */
export function writeMailDocument(frame: HTMLIFrameElement, parts: readonly string[]): boolean {
  const doc = frame.contentDocument;
  if (!doc) return false;
  try {
    doc.open();
    for (const p of parts) doc.write(p);
    doc.close();
  } catch {
    return false;
  }
  mailFrameStats.writes++;
  return true;
}

/** What `window.__mailFrame` answers. */
function mailFrameReport(): { created: number; removed: number; writes: number; fallbacks: number; live: number; historyLength: number; frameHistoryLength: number | null } {
  const frames = document.querySelectorAll<HTMLIFrameElement>("iframe.msg-frame");
  let frameHistory: number | null = null;
  try {
    frameHistory = frames[0]?.contentWindow?.history.length ?? null;
  } catch {
    /* a frame we may not read */
  }
  return { ...mailFrameStats, live: frames.length, historyLength: history.length, frameHistoryLength: frameHistory };
}

if (typeof window !== "undefined") Object.defineProperty(window, "__mailFrame", { get: mailFrameReport, configurable: true });
