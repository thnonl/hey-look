// The data of the big pictures and files of a draft does not come with `draft_editor_parts`: one answer of 25 MB holds the app's main thread for 0.3 s (the webview round trip
// of a click in another window was 0.5 to 0.7 s while a 19 MB draft opened, 1.0.7 D-044). The backend leaves a marker in its place, and the page asks for each piece with
// `draft_data` and puts it back. src-tauri/src/draftopen.rs and tempstore.rs are the other half.

import type { DraftEditorParts } from "./api";

/** What stands in the place of left-out data: this, then the token the backend gave. */
export const DEFER_MARK = "hl-deferred-";
const MARKER = /hl-deferred-([0-9a-f]{32})/g;

/**
 * `parts` with the left-out data back in its place. `load` gives the data of a token; at most `limit` requests are on their way at once (each is over in a few milliseconds
 * on the backend; the app's main thread takes them one by one in any case). Rejects when a piece is missing: the caller asks for the whole parts then (`all`).
 */
export async function fillDeferred(parts: DraftEditorParts, load: (token: string) => Promise<string>, limit = 4): Promise<DraftEditorParts> {
  if (!parts.deferred.length) return parts;
  const data = new Map<string, string>();
  const queue = [...parts.deferred];
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) data.set(t, await load(t));
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  const back = (text: string) => text.replace(MARKER, (m, token: string) => data.get(token) ?? m);
  return {
    ...parts,
    html: parts.html === null ? null : back(parts.html),
    attachments: parts.attachments.map((a) => (a.dataBase64.startsWith(DEFER_MARK) ? { ...a, dataBase64: back(a.dataBase64) } : a)),
    deferred: [],
  };
}
