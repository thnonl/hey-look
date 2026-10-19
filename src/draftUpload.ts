// Big pictures and attachments of a draft are sent to the backend one request each, ahead of the save (1.0.7 D-045). One request with the whole draft - the 14 pictures of a
// 19 MB draft are 25 million characters - blocks the page for 150 to 230 ms and the app's main thread for 0.3 to 0.5 s while it is read, so every other window and command
// waits (QA round 4: a webview round trip of 530 ms during the save). Sent one by one, the same bytes take as long in all and nothing waits longer than 45 ms.
// src-tauri/src/draftupload.rs is the other half.

import type { Att, Draft, InlineImage } from "./api";

/** A part of at least this many characters of base64 (about 190 KB) is sent ahead; smaller ones travel with the draft (a request of its own costs more than it saves). */
export const UPLOAD_MIN = 256 * 1024;

/** A part that was sent ahead: where it is in the draft (`inline`: the pictures of the body, else the attachments) and the id its data was sent under. */
export interface UploadRef {
  inline: boolean;
  index: number;
  id: string;
}

/**
 * `draft` with the data of every big picture and attachment left out, and what the backend needs to put it back. `send(id, data)` sends one part (one request); a part that could
 * not be sent stays in the draft, so the save still has everything, only in the big request that was sent before. Parts go one after the other: each request is over before
 * the next starts, and the page and the backend get their turn in between.
 */
export async function slimDraft(draft: Draft, send: (id: string, data: string) => Promise<unknown>, newId: () => string = () => crypto.randomUUID()): Promise<{ draft: Draft; uploads: UploadRef[] }> {
  const uploads: UploadRef[] = [];
  const part = async <T extends Att | InlineImage>(list: T[], inline: boolean): Promise<T[]> => {
    const out: T[] = [];
    for (let index = 0; index < list.length; index++) {
      const p = list[index];
      if (p.dataBase64.length < UPLOAD_MIN) {
        out.push(p);
        continue;
      }
      const id = newId();
      try {
        await send(id, p.dataBase64);
        uploads.push({ inline, index, id });
        out.push({ ...p, dataBase64: "" });
      } catch {
        out.push(p);
      }
    }
    return out;
  };
  const attachments = await part(draft.attachments ?? [], false);
  const inline = draft.inline ? await part(draft.inline, true) : draft.inline;
  return { draft: uploads.length ? { ...draft, attachments, inline } : draft, uploads };
}
