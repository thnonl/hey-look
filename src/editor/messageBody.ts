// From the editor's document to the HTML that is stored and sent: the blocks (emailHtml.ts), the signature put in place of its marker,
// inline pictures turned into `cid:` references, everything inside the wrapper with the message's default font. All on strings, so a
// plain Node script runs the very same steps as Compose (scripts/test-rich-golden.mjs). The sanitiser (src-tauri/src/outgoing.rs) and the
// plain-text part (htmlText.ts) work on this result.

import { docToHtml, wrapBase, type BaseFont, type JsonNode } from "./emailHtml.ts";
import { sigBlockHtml } from "../signature.ts";

const MARK = "<div data-sig-block></div>";
// empty paragraphs at the very end (the one the editor keeps below the signature region): no stray blank line after the signature
const TRAILING_EMPTY = /(?:<p(?: style="[^"]*")?>(?:<br>)?<\/p>)+$/;

/** The signature region marker replaced by the signature (or removed), and the empty paragraphs at the end dropped. */
export function fillSignatureStr(html: string, sigHtml: string | null): string {
  const filled = html.split(MARK).join(sigHtml && sigHtml.trim() ? sigBlockHtml(sigHtml) : "");
  return filled.replace(TRAILING_EMPTY, "");
}

export interface InlinePicture {
  cid: string;
  mime: string;
  dataBase64: string;
  name: string;
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const NAME = /\sdata-name\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Every `<img>` whose source is a `data:` URI becomes a `cid:` reference with a part of its own (the pictures travel as related parts, not as
 * attachments). Returns the HTML and the pictures; `newCid` makes the id of the next one, `fileName` the name of a picture that has none.
 */
export function swapPictures(html: string, newCid: () => string, fileName: (mime: string, n: number) => string): { html: string; inline: InlinePicture[] } {
  const inline: InlinePicture[] = [];
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = SRC.exec(tag);
    const uri = src ? unesc(src[1] ?? src[2] ?? "") : "";
    const m = /^data:([^;,]+);base64,(.*)$/.exec(uri);
    if (!src || !m) return tag.replace(NAME, ""); // (the editor's file name never leaves)
    const cid = newCid();
    const n = NAME.exec(tag);
    inline.push({ cid, mime: m[1], dataBase64: m[2], name: (n ? unesc(n[1] ?? n[2] ?? "") : "") || fileName(m[1], inline.length + 1) });
    return tag.replace(SRC, ` src="cid:${cid}"`).replace(NAME, "");
  });
  return { html: out, inline };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A stored message gives its pictures back to the editor as data: URIs, and the file name each one had is in the message's part, not in the
 * HTML. This puts it back as the editor's `data-name` on the first `<img>` whose source holds `needle` (the picture's base64) and has no name yet,
 * so a reopened draft sends the picture under the name it was added with (WP5f).
 */
export function nameInlinePicture(html: string, needle: string, name: string): string {
  if (!needle || !name) return html;
  let done = false;
  return html.replace(/<img[^>]*>/gi, (tag) => {
    if (done || NAME.test(tag) || !tag.includes(needle)) return tag;
    done = true;
    return tag.replace(/<img/i, `<img data-name="${esc(name)}"`);
  });
}

/**
 * The message as it is stored and sent. `pictures: "cid"` turns the pictures into inline parts (send, draft); `"data"` keeps them as data:
 * URIs (the crash-recovery snapshot, which reopens in the editor).
 */
export function messageHtml(
  doc: JsonNode,
  o: { sig: string | null; base: BaseFont; pictures: "cid"; newCid: () => string; fileName: (mime: string, n: number) => string } | { sig: string | null; base: BaseFont; pictures: "data" },
): { html: string; inline: InlinePicture[] } {
  const filled = fillSignatureStr(docToHtml(doc, o.base), o.sig);
  if (o.pictures === "data") return { html: wrapBase(filled, o.base), inline: [] };
  const s = swapPictures(filled, o.newCid, o.fileName);
  return { html: wrapBase(s.html, o.base), inline: s.inline };
}
