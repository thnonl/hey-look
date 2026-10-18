// Forward carries the attachments of the message it forwards (QA round 17, BUG-08 / CF-3): they are downloaded from the stored message,
// become attachments of the new message (listed in Compose, where each can be removed), and count toward the same size limit as files added
// by hand. Pictures that sit in the body stay in the body. A file that cannot be fetched is reported and left out; the rest still comes.
// Pure apart from the `fetchOne` it is given, so a plain Node script can test it (scripts/test-forward-attachments.mjs).
import type { Att, AttMeta } from "./api.ts";

/** What one message may carry (attachments and pictures together): the limit Compose enforces (Compose.tsx MAX_ATTACH_BYTES). */
export const MAX_FORWARD_BYTES = 25 * 1024 * 1024;

export interface ForwardFiles {
  /** the attachments of the new message */
  attachments: Att[];
  /** the body, with large pictures that were only referenced (`cid:`) put in as data: pictures */
  html: string | null;
  /** files that could not be fetched */
  failed: { name: string; error: string }[];
  /** files left out because the message would be over the limit */
  skipped: string[];
}

const DATA_URI = /data:[^;,"')\s]+;base64,([A-Za-z0-9+/=]+)/g;

/** The bytes of the pictures already embedded in a body. */
export function embeddedBytes(html: string | null): number {
  let n = 0;
  for (const m of (html ?? "").matchAll(DATA_URI)) n += Math.floor((m[1].length * 3) / 4);
  return n;
}

/** `only: "pictures"` (a reply): just the pictures the body shows are fetched, the other attachments are left where they are. */
export async function forwardFiles(
  m: { html: string | null; attachments: readonly AttMeta[] },
  fetchOne: (index: number) => Promise<{ name: string; mime: string; dataBase64: string }>,
  limit: number = MAX_FORWARD_BYTES,
  only?: "pictures",
): Promise<ForwardFiles> {
  let html = m.html;
  let used = embeddedBytes(html);
  const out: ForwardFiles = { attachments: [], html, failed: [], skipped: [] };
  for (const a of m.attachments) {
    // a picture that the body shows: embedded already, or a large one that still has to be fetched
    const shown = a.inline && a.referenced;
    if (shown && !(a.cid && html?.includes(`cid:${a.cid}`))) continue;
    if (only === "pictures" && !shown) continue;
    if (used + a.size > limit) {
      out.skipped.push(a.name);
      continue;
    }
    try {
      const d = await fetchOne(a.index);
      if (shown) html = (html ?? "").split(`cid:${a.cid}`).join(`data:${d.mime};base64,${d.dataBase64}`);
      else out.attachments.push({ filename: d.name || a.name, mime: d.mime || a.mime, dataBase64: d.dataBase64 });
      used += a.size;
    } catch (e) {
      out.failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.html = html;
  return out;
}
