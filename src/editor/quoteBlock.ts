// The quote block of a reply or forward in the composer (spec-rich-text.md REQ-35): the original message is not parsed into the editor's schema, it is one
// atom node (`quoteBlock`: quoteNode.ts) that holds the cleaned HTML of the original (quoteClean.ts) and is written back as it is when the draft is built.
// This file is the pure part: how the node is written to the stored / sent HTML, and how a stored draft gives it back.
//
//   reply     <br><div class="hl-quote"><div>On 16 Oct 2026, Ann wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">..the original..</blockquote></div>
//   forward   <br><div class="hl-quote"><div>---------- Forwarded message ----------<br>From: ..<br>..<br><br></div><div>..the original..</div></div>
//
// `hl-quote` is the one class besides `sig` that the outgoing sanitiser keeps; it is how a reopened draft finds the block again. No data attributes: a
// recipient's client sees plain divs and a blockquote (inline styles only). Pure (no imports but one constant, no DOM): scripts/test-quote.mjs.


export interface QuoteAttrs {
  kind: "reply" | "forward";
  /** HTML of the line above the original ("On <date>, <name> wrote:") or of the forward header; made of escaped text and <br> only */
  head: string;
  /** the cleaned original (quoteClean.ts) */
  html: string;
}

const QUOTE_CLASS = "hl-quote";
/** The look of a quote in a mail: the same for the editor's Quote style and for the quoted original. */
export const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex";

/** The block as it is stored and sent. */
export function quoteSentHtml(q: QuoteAttrs): string {
  const body = q.kind === "reply" ? `<blockquote style="${QUOTE_STYLE}">${q.html}</blockquote>` : `<div>${q.html}</div>`;
  return `<br><div class="${QUOTE_CLASS}"><div>${q.head}</div>${body}</div>`;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The form the editor's reader gets (`div[data-quote-block]`: quoteNode.ts parses it): the block in place of the stored one. */
function quoteMarker(q: QuoteAttrs): string {
  return `<div data-quote-block="${q.kind}" data-quote-head="${escAttr(q.head)}" data-quote-html="${escAttr(q.html)}"></div>`;
}

const OPEN = `<div class="${QUOTE_CLASS}">`;
const TAG = /<(\/?)(div|blockquote)\b[^>]*>/gi;

/** The end (after its closing tag) of the element that starts at `from` with the tag `name`; -1 when it is not closed. */
function endOf(html: string, from: number, name: "div" | "blockquote"): number {
  TAG.lastIndex = from;
  let depth = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m[2].toLowerCase() !== name) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return TAG.lastIndex;
  }
  return -1;
}

/**
 * A stored draft body -> the editor's content, the way `extractSignature` does for the signature: the quote block of the stored message becomes the
 * marker the node reads, and its attributes are returned. Only a block that has exactly the form `quoteSentHtml` writes counts (a damaged or foreign one
 * stays what it is: ordinary content). The `<br>` that was put in front of it goes with it.
 */
export function extractQuote(html: string): { html: string; quote: QuoteAttrs | null } {
  for (let at = html.indexOf(OPEN); at >= 0; at = html.indexOf(OPEN, at + 1)) {
    const end = endOf(html, at, "div");
    if (end < 0) continue;
    const inner = html.slice(at + OPEN.length, end - "</div>".length);
    const headEnd = inner.startsWith("<div>") ? endOf(inner, 0, "div") : -1;
    if (headEnd < 0) continue;
    const head = inner.slice("<div>".length, headEnd - "</div>".length);
    const rest = inner.slice(headEnd);
    const reply = rest.startsWith(`<blockquote style="${QUOTE_STYLE}">`);
    const forward = rest.startsWith("<div>");
    if (!reply && !forward) continue;
    const open = reply ? `<blockquote style="${QUOTE_STYLE}">`.length : "<div>".length;
    const bodyEnd = endOf(rest, 0, reply ? "blockquote" : "div");
    const closeLen = reply ? "</blockquote>".length : "</div>".length;
    if (bodyEnd !== rest.length || bodyEnd < open + closeLen) continue; // nothing but the body in the block
    const q: QuoteAttrs = { kind: reply ? "reply" : "forward", head, html: rest.slice(open, bodyEnd - closeLen) };
    const from = html.slice(0, at).endsWith("<br>") ? at - 4 : at;
    return { html: html.slice(0, from) + quoteMarker(q) + html.slice(end), quote: q };
  }
  return { html, quote: null };
}

/** The data-URI pictures in a quote, in bytes (they count toward the size of the message). */
export function quotePictureBytes(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/data:[^;,"')\s]+;base64,([A-Za-z0-9+/=]+)/g)) n += Math.floor((m[1].length * 3) / 4);
  return n;
}
