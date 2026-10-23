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

/** How many files are fetched at the same time (each is one call to the backend that reads the stored message: a message with 40 pictures waits for 40, one after the other, otherwise; W13.13). */
const PARALLEL = 4;

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
  // which files come along (in order, against the size limit), then all of them are fetched, a few at a time
  const plan: { a: AttMeta; shown: boolean }[] = [];
  for (const a of m.attachments) {
    // a picture that the body shows: embedded already, or a large one that still has to be fetched
    const shown = !!(a.inline && a.referenced);
    if (shown && !(a.cid && html?.includes(`cid:${a.cid}`))) continue;
    if (only === "pictures" && !shown) continue;
    if (used + a.size > limit) {
      out.skipped.push(a.name);
      continue;
    }
    used += a.size;
    plan.push({ a, shown });
  }
  const got: ({ d: { name: string; mime: string; dataBase64: string } } | { e: unknown })[] = new Array(plan.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < plan.length; i = next++) {
      try {
        got[i] = { d: await fetchOne(plan[i].a.index) };
      } catch (e) {
        got[i] = { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.length) }, worker));
  plan.forEach(({ a, shown }, i) => {
    const r = got[i];
    if ("e" in r) {
      out.failed.push({ name: a.name, error: r.e instanceof Error ? r.e.message : String(r.e) });
      return;
    }
    if (shown) html = (html ?? "").split(`cid:${a.cid}`).join(`data:${r.d.mime};base64,${r.d.dataBase64}`);
    else out.attachments.push({ filename: r.d.name || a.name, mime: r.d.mime || a.mime, dataBase64: r.d.dataBase64 });
  });
  out.html = html;
  return out;
}
