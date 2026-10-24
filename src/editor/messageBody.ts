// From the editor's document to the HTML that is stored and sent: the blocks (emailHtml.ts), the signature put in place of its marker,
// inline pictures turned into `cid:` references, everything inside the wrapper with the message's default font. All on strings, so a
// plain Node script runs the very same steps as Compose (scripts/test-rich-golden.mjs). The sanitiser (src-tauri/src/outgoing.rs) and the
// plain-text part (htmlText.ts) work on this result.

import { docToHtml, wrapBase, type BaseFont, type JsonNode } from "./emailHtml.ts";
import { REGION_HTML, sigBlockHtml } from "../signature.ts";

const MARK = "<div data-sig-block></div>";
// empty paragraphs at the very end (the one the editor keeps below the signature region): no stray blank line after the signature
const TRAILING_EMPTY = /(?:<p(?: style="[^"]*")?>(?:<br>)?<\/p>)+$/;

/**
 * The signature region marker replaced by the signature, and the empty paragraphs at the end dropped. With no signature the region leaves `REGION_HTML` where it was, so a draft,
 * a failed send or an Undo gives it back at the same place (V107-R10A-1); the Rust side removes it from a message that is sent.
 */
export function fillSignatureStr(html: string, sigHtml: string | null): string {
  const filled = html.split(MARK).join(sigHtml && sigHtml.trim() ? sigBlockHtml(sigHtml) : REGION_HTML);
  return filled.replace(TRAILING_EMPTY, "");
}

export interface InlinePicture {
  cid: string;
  mime: string;
  dataBase64: string;
  name: string;
}

const PICTURE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const SAME_TYPE: Record<string, string[]> = { "image/png": ["png"], "image/jpeg": ["jpg", "jpeg", "jpe", "jfif"], "image/gif": ["gif"], "image/webp": ["webp"] };
const PICTURE_NAME_EXT = /\.(png|jpe?g|jpe|jfif|gif|webp|bmp|tiff?|heic|avif|svg)$/i;

/**
 * The file name of a picture whose bytes are `mime`: the name when its extension already says so, else the extension of the type (`e09-anim.gif` that was
 * made a PNG is `e09-anim.png`; a name without a picture extension gets one). A type that is not a picture the editor knows leaves the name alone.
 * The part type, its file name and its bytes then agree (v1.0.6 QA round 3, BUG-R3-3: a resized GIF went out as image/png under a .gif name).
 */
export function nameForMime(name: string, mime: string): string {
  const type = mime.toLowerCase();
  const ext = PICTURE_EXT[type];
  if (!ext) return name;
  const m = /\.([^./\\]+)$/.exec(name);
  if (m && SAME_TYPE[type].includes(m[1].toLowerCase())) return name;
  return PICTURE_NAME_EXT.test(name) ? name.replace(PICTURE_NAME_EXT, `.${ext}`) : `${name}.${ext}`;
}

/** The widest a picture is made when a big one is re-encoded (resizeImage scales by the width). */
export const RESIZE_WIDTH = 1600;

/**
 * Which toast says what happened to a big picture that was re-encoded: "resized to 1600 px" only when the picture was wider than that (else it was not scaled, and the toast
 * must not claim it was), for a GIF with the note that the animation is gone. A 900 px wide GIF is only converted to PNG.
 */
export function reencodeToastKey(mime: string, width: number): "compose.pic.resized" | "compose.pic.resizedGif" | "compose.pic.convertedGif" | "compose.pic.recompressed" {
  const scaled = width > RESIZE_WIDTH;
  if (mime.toLowerCase() === "image/gif") return scaled ? "compose.pic.resizedGif" : "compose.pic.convertedGif";
  return scaled ? "compose.pic.resized" : "compose.pic.recompressed";
}

/** What the picture prompt (Settings > Composing, "Resize large pictures automatically" off) offers for a picture over 1 MB: only an action that is true and useful (W2.1). */
export type LargePictureOffer = "resize" | "compress" | "convert" | null;

/**
 * A picture wider than 1600 px is offered the scale to 1600 px; one that is not wider is offered what the re-encode really does: a JPEG or WebP is compressed (JPEG 0.85, same size),
 * a GIF is converted to PNG (first frame), and a PNG gets no offer (the canvas often makes it bigger, not smaller).
 */
export function largePictureOffer(mime: string, width: number): LargePictureOffer {
  if (width > RESIZE_WIDTH) return "resize";
  const type = mime.toLowerCase();
  if (type === "image/jpeg" || type === "image/webp") return "compress";
  if (type === "image/gif") return "convert";
  return null;
}

/** A re-encode is used only when its result is smaller in bytes than the original; otherwise the original stays (W2.1, REQ-2.1.2). */
export function keepSmaller(origBytes: number, newBytes: number): boolean {
  return newBytes < origBytes;
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
    // (the name is the one the picture was added with, made to say what the bytes are: a picture that was re-encoded keeps no stale extension)
    const given = n ? unesc(n[1] ?? n[2] ?? "") : "";
    inline.push({ cid, mime: m[1], dataBase64: m[2], name: given ? nameForMime(given, m[1]) : fileName(m[1], inline.length + 1) });
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
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (done || NAME.test(tag) || !tag.includes(needle)) return tag;
    done = true;
    return tag.replace(/<img\b/i, `<img data-name="${esc(name)}"`);
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
