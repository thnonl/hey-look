// The inline picture of the message body: tiptap's image node, plus the width and the file name the composer keeps (Compose), the alignment
// (left, centre, right: a block picture, no text wrap) and a link on the picture (spec-rich-text.md REQ-34). Part of the editor kit chunk (kit.ts).
//
// Only pictures that travel with the HTML (`cid:`, base64 `data:` rasters) enter the document: a remote one is never shown, so it is never fetched
// while writing (a tracking pixel, a UNC or file: picture). How a picture is written to the sent HTML (alignment wrapper, link wrapper) is emailHtml.ts;
// how it is read back is `pictureWrap` here, so a draft that is saved and reopened keeps its alignment and its link.

import Image from "@tiptap/extension-image";
import { isLocalPictureSrc } from "../pastedHtml.ts";
import { checkLinkUrl } from "../linkUrl.ts";

export type PictureAlign = "left" | "center" | "right";

/** What the elements around a picture say: `text-align` of a `div`/`p` that holds only the picture, and the address of a link that does. */
function pictureWrap(el: HTMLElement): { align: PictureAlign | null; href: string | null } {
  let href: string | null = null;
  let node: HTMLElement | null = el;
  const parent = node.parentElement;
  if (parent?.tagName === "A" && parent.childNodes.length === 1) {
    const raw = (parent.getAttribute("href") ?? "").trim();
    href = /^(?:https?:|mailto:|tel:)/i.test(raw) && checkLinkUrl(raw).ok ? raw : null; // (as written: a read-back draft is written again exactly as before)
    node = parent;
  }
  const box = node.parentElement;
  let align: PictureAlign | null = null;
  if (box && /^(DIV|P)$/.test(box.tagName) && box.childNodes.length === 1) {
    const a = (box.style.textAlign || box.getAttribute("align") || "").toLowerCase();
    if (a === "center" || a === "right") align = a;
  }
  return { align, href };
}

export const PictureNode = Image.extend({
  parseHTML() {
    return [{ tag: "img[src]", getAttrs: (el: HTMLElement | string) => (typeof el !== "string" && isLocalPictureSrc(el.getAttribute("src") ?? "") ? null : false) }];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("width")) || null,
        renderHTML: (a: Record<string, unknown>) => (a.width ? { width: a.width } : {}),
      },
      "data-name": {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-name"),
        renderHTML: (a: Record<string, unknown>) => (a["data-name"] ? { "data-name": a["data-name"] } : {}),
      },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => pictureWrap(el).align,
        renderHTML: (a: Record<string, unknown>) => (a.align === "center" || a.align === "right" ? { "data-align": a.align } : {}),
      },
      href: {
        default: null,
        parseHTML: (el: HTMLElement) => pictureWrap(el).href,
        // (the editor never navigates: the address only shows as the picture's tooltip)
        renderHTML: (a: Record<string, unknown>) => (typeof a.href === "string" && a.href ? { "data-href": a.href } : {}),
      },
    };
  },
}).configure({ inline: false, allowBase64: true });
