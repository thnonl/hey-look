// What may enter the compose editor from outside: pasted or dropped HTML, the body of a reply / forward / draft, a template.
// Nothing here may start a network request while the message is being written (QA round 17, O-01 / CF-16): a pasted web page with a
// remote `<img>` hit the sender's tracking pixel the moment it was pasted. Pictures that do not travel with the HTML are removed BEFORE
// the editor sees it; `data:` pictures (a copied screenshot) and `cid:` stay, and so do clipboard image files (the paste-image path).
// Pure (no imports, no DOM): the scanner below reads the string, so it can be tested with node.
// Run: node --experimental-strip-types scripts/test-pasted-html.mjs

/** A tag found by `rewriteTags`. `attrs[i].raw` is the attribute exactly as written. */
export interface TagToken {
  /** lower-case name without `/` */
  name: string;
  end: boolean;
  selfClosing: boolean;
  attrs: { name: string; value: string; raw: string }[];
}

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** `&amp; &lt; &gt; &quot; &apos; &nbsp;` and numeric references (with or without the `;`): enough to read a scheme the way a browser does. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|(amp|lt|gt|quot|apos|nbsp));?/g, (m, dec, hex, name) => {
    if (name) return m.endsWith(";") ? ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" } as Record<string, string>)[name] : m;
    const n = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd";
  });
}

/** Calls `fn` for every start / end tag of `html`. It returns the text to write instead of the tag, or null to keep the tag as it is.
 *  A tag that never ends (an unterminated quote) swallows the rest of the text, as it does in a browser, so the rest is cut. */
export function rewriteTags(html: string, fn: (t: TagToken) => string | null): string {
  let out = "";
  let i = 0;
  let last = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";
    const end = next === "/";
    const nameStart = lt + (end ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      // comment / doctype / processing instruction: copied as it is up to its `>`; a lone `<` is text
      if (next === "!" || next === "?") {
        const gt = html.startsWith("<!--", lt) ? html.indexOf("-->", lt + 4) : html.indexOf(">", lt);
        i = gt < 0 ? html.length : gt + (html.startsWith("<!--", lt) ? 3 : 1);
      } else i = lt + 1;
      continue;
    }
    let j = nameStart;
    while (j < html.length && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
    const name = html.slice(nameStart, j).toLowerCase();
    const attrs: TagToken["attrs"] = [];
    let selfClosing = false;
    let closed = false;
    while (j < html.length) {
      while (j < html.length && (isWs(html[j]) || html[j] === "/")) selfClosing = html[j++] === "/";
      if (j >= html.length) break;
      if (html[j] === ">") {
        j++;
        closed = true;
        break;
      }
      selfClosing = false;
      const as = j++;
      while (j < html.length && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
      const aname = html.slice(as, j).toLowerCase();
      let k = j;
      while (k < html.length && isWs(html[k])) k++;
      let value = "";
      if (html[k] === "=") {
        k++;
        while (k < html.length && isWs(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, k + 1);
          if (close < 0) {
            j = html.length; // unterminated quote: the tag never ends
            break;
          }
          value = html.slice(k + 1, close);
          j = close + 1;
        } else {
          const vs = k;
          while (k < html.length && !isWs(html[k]) && html[k] !== ">") k++;
          value = html.slice(vs, k);
          j = k;
        }
      }
      attrs.push({ name: aname, value, raw: html.slice(as, j) });
    }
    if (!closed) {
      out += html.slice(last, lt); // the rest of the text belongs to this unterminated tag
      return out;
    }
    const rep = fn({ name, end, selfClosing, attrs });
    if (rep !== null) {
      out += html.slice(last, lt) + rep;
      last = j;
    }
    i = j;
  }
  return out + html.slice(last);
}

/** A picture source that carries its data with the message: `cid:` or a base64 `data:image/*` raster picture (png, jpeg, gif, webp ... but not svg). Everything else (http,
 *  https, ftp, `//host`, `\\host\share`, `file:`, `blob:`, `data:image/svg+xml`, `javascript:` ...) is not. */
export function isLocalPictureSrc(src: string): boolean {
  // a browser ignores tab / newline inside a URL and blanks around it
  // eslint-disable-next-line no-control-regex
  const s = decodeEntities(src).replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020\u00a0]+/, "").toLowerCase();
  return /^cid:[^\s"'<>\\]{1,255}$/.test(s) || /^data:image\/(?!svg)[a-z0-9.+-]{1,30}(;[a-z0-9=._-]+)*;base64,[a-z0-9+/=%\s]+$/.test(s);
}

/** `html` without the pictures that would be fetched from somewhere (or read from the disk): they are not shown, not loaded and not sent. */
export function stripRemotePictures(html: string): { html: string; removed: number } {
  let removed = 0;
  const out = rewriteTags(html, (t) => {
    if (t.end || t.name !== "img") return null;
    const src = t.attrs.find((a) => a.name === "src");
    if (src && isLocalPictureSrc(src.value)) return null;
    removed++;
    return "";
  });
  return { html: out, removed };
}

/** HTML from the clipboard or a drop, ready for the editor: remote pictures removed, and no copy of the signature region (a pasted
 *  `data-sig-block` element would become a second signature). */
export function cleanPastedHtml(html: string): { html: string; removed: number } {
  const r = stripRemotePictures(html);
  const out = rewriteTags(r.html, (t) => {
    if (t.end || !t.attrs.some((a) => a.name === "data-sig-block")) return null;
    return `<${t.name}${t.attrs.filter((a) => a.name !== "data-sig-block").map((a) => " " + a.raw).join("")}${t.selfClosing ? "/" : ""}>`;
  });
  return { html: out, removed: r.removed };
}
