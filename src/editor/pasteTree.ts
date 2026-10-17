// A small reader and writer for the HTML of the clipboard (spec-rich-text.md REQ-23): text in, a tree of elements out, and back to text. It is
// not a browser: it only has to read what Word, Excel, Outlook, Gmail, web pages and Apple's programs put on the clipboard, all of which
// were written from a DOM and are well formed (plus Word's conditional comments), and to never fail on anything else. Pure (no DOM, no
// imports but one): a plain Node script gives the same answer as the editor, so the stored files of scripts/test-paste-clean.mjs are the real output.

import { decodeEntities } from "../htmlText.ts";

export interface El {
  /** lower-case; "" for the root */
  tag: string;
  attrs: Record<string, string>;
  kids: Nd[];
}
export type Nd = El | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** their content is text up to the end tag */
const RAW = new Set(["script", "style", "textarea", "title"]);
const INLINE = new Set(["a", "b", "i", "u", "s", "em", "strong", "span", "font", "code", "sub", "sup", "small", "big", "label", "mark", "strike", "del", "ins", "abbr", "cite"]);
/** a start tag of these ends an open <p> */
const ENDS_P = new Set("address article aside blockquote center div dl fieldset figure footer form h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul li dd dt".split(" "));
/** how deep the tree may get: a hostile paste cannot make a recursive walk overflow the stack */
export const MAX_DEPTH = 120;

const TAG = /^<(\/?)([a-zA-Z][^\s/>]*)([^]*)>$/;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

/** `&amp;` `&#39;` `&copy;` ... to characters; a no-break space stays a no-break space (it is content in Word's empty paragraphs). */
export const decode = (s: string): string => (s.includes("&") ? decodeEntities(s.replace(/&nbsp;|&#160;|&#xa0;/gi, " ")) : s);

/** The end (after the `>`) of the tag that starts at `i`; a `>` inside quotes does not end it; -1 when it never ends. */
function tagEnd(html: string, i: number): number {
  let q = "";
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j];
    if (q) q = c === q ? "" : q;
    else if (c === '"' || c === "'") q = c;
    else if (c === ">") return j + 1;
  }
  return -1;
}

export function parseHtml(html: string): El {
  const root: El = { tag: "", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  /** closes the nearest open `tag` (looking down the stack, never past one of `stop`); true when there was one */
  const close = (tag: string, stop: readonly string[] = []): boolean => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) {
        stack.length = k;
        return true;
      }
      if (stop.includes(stack[k].tag)) return false;
    }
    return false;
  };
  let i = 0;
  // what the tags that never end may cost altogether: a hostile paste of a million "<a " must not be quadratic
  let lost = 0;
  const budget = html.length * 3 + 50000;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      top().kids.push(decode(html.slice(i)));
      break;
    }
    if (lt > i) top().kids.push(decode(html.slice(i, lt)));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i + 4);
      i = e < 0 ? html.length : e + 3; // comments, Word's <!--[if ...]> blocks and Chrome's <!--StartFragment--> go
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const e = html.indexOf(">", i); // <!DOCTYPE>, <?xml ?>, Word's <![if !supportLists]> / <![endif]>
      i = e < 0 ? html.length : e + 1;
      continue;
    }
    const end = lost > budget ? -1 : tagEnd(html, i);
    const m = end < 0 ? null : TAG.exec(html.slice(i, end));
    if (!m) {
      if (end < 0) lost += html.length - i; // (a "<" that starts no tag: a tag that never ends costs one look at the rest, and only a few such looks are made)
      top().kids.push("<");
      i++;
      continue;
    }
    i = end;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      close(tag, tag === "li" ? ["ul", "ol"] : /^t[dhr]$/.test(tag) ? ["table"] : []);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(ATTR)) {
      const n = a[1].toLowerCase();
      if (!(n in attrs)) attrs[n] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    // tags that end others without being told
    if (tag === "li") close("li", ["ul", "ol"]);
    else if (tag === "td" || tag === "th") {
      close("td", ["tr", "table"]) || close("th", ["tr", "table"]);
    } else if (tag === "tr" || tag === "tbody" || tag === "thead" || tag === "tfoot") close("tr", ["table"]);
    if (ENDS_P.has(tag)) {
      for (let k = stack.length - 1; k > 0 && (stack[k].tag === "p" || INLINE.has(stack[k].tag)); k--) {
        if (stack[k].tag === "p") {
          stack.length = k;
          break;
        }
      }
    }
    const el: El = { tag, attrs, kids: [] };
    top().kids.push(el);
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}`, "gi");
      re.lastIndex = i;
      const e = re.exec(html)?.index ?? -1;
      const end = e < 0 ? html.length : e;
      el.kids.push(html.slice(i, end));
      const gt = html.indexOf(">", end);
      i = e < 0 || gt < 0 ? html.length : gt + 1;
    } else if (!VOID.has(tag) && !(tag.includes(":") && m[3].trimEnd().endsWith("/")) && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

export function toHtml(nodes: readonly Nd[]): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") out += escText(n);
    else {
      const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
      out += VOID.has(n.tag) ? `<${n.tag}${a}>` : `<${n.tag}${a}>${toHtml(n.kids)}</${n.tag}>`;
    }
  }
  return out;
}

/** The text of a node and everything under it. */
export function textOf(n: Nd): string {
  return typeof n === "string" ? n : n.kids.map(textOf).join("");
}
