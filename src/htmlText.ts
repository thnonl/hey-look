// The text/plain alternative of a message: made from the HTML the editor produced. Plain string scanning (no DOM), so a plain Node
// script can test it (scripts/test-html-text.mjs). What a reader of the plain part must still find: list markers, link addresses,
// quote marks, rows of a table, headings and line breaks, and no markup or entities.
//
//   <p>a</p><p>b</p>                 a / b on their own lines (an empty paragraph is a blank line)
//   <ul><li>x</li></ul>              - x          (<ol>: 1. x, <ol type="a|A|i|I">: a. x, nested lists indented by two blanks per level)
//   <a href="https://e.test/">docs</a>   docs (https://e.test/)   (just the address when the text is the address)
//   <blockquote>..</blockquote>      every line starts with "> " ("> > " when nested)
//   <table>                          cells separated by a tab, one row per line
//   <h1>..<h6>                       the heading on a line of its own
//   <br>                             a line break
//   <hr>                             ----------
//   <img alt="x">                    [x]

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", deg: "°", plusmn: "±",
  times: "×", divide: "÷", laquo: "«", raquo: "»", larr: "←", rarr: "→", para: "¶", shy: "", zwnj: "", zwj: "",
};

// HTML 4's Latin-1 entities (code 160 on, in order: nbsp iexcl cent ...) and the "special" and symbol ones mail still uses (newsletters write &auml; &szlig; &eacute; &nbsp; ...)
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const MORE: Record<string, number> = {
  OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, sbquo: 8218, bdquo: 8222, dagger: 8224, Dagger: 8225, permil: 8240, lsaquo: 8249, rsaquo: 8250,
  prime: 8242, Prime: 8243, oline: 8254, frasl: 8260, lrm: 8206, rlm: 8207, uarr: 8593, darr: 8595, harr: 8596, rArr: 8658, hArr: 8660, minus: 8722, radic: 8730, infin: 8734, ne: 8800, le: 8804, ge: 8805,
  asymp: 8776, sum: 8721, prod: 8719, part: 8706, nabla: 8711, hearts: 9829, diams: 9830, spades: 9824, clubs: 9827, loz: 9674, alpha: 945, beta: 946, gamma: 947, delta: 948, mu: 956, pi: 960, sigma: 963, omega: 969, Omega: 937,
};
for (const [i, n] of LATIN1.entries()) if (!(n in NAMED)) NAMED[n] = String.fromCodePoint(160 + i);
for (const [n, cp] of Object.entries(MORE)) if (!(n in NAMED)) NAMED[n] = String.fromCodePoint(cp);

/** `&amp;` `&#39;` `&#x1F680;` -> the character; an entity that is not known stays as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
      return cp === 0xa0 ? " " : String.fromCodePoint(cp);
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

type Attrs = Record<string, string>;
type Tok = { tag: string; close: boolean; attrs: Attrs } | { text: string };

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function tokens(html: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push({ text: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ text: html.slice(i, lt) });
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (!/^<\/?[a-zA-Z!?]/.test(html.slice(lt, lt + 3))) {
      out.push({ text: "<" }); // a lone "<" is text
      i = lt + 1;
      continue;
    }
    // the end of the tag: the first ">" outside quotes
    let j = lt + 1;
    let quote = "";
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const inner = html.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === "!" || inner[0] === "?") continue; // doctype, processing instruction
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(inner);
    if (!m) continue;
    const attrs: Attrs = {};
    for (const a of m[3].matchAll(ATTR)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    out.push({ tag: m[2].toLowerCase(), close: m[1] === "/", attrs });
  }
  return out;
}

const SKIP = new Set(["script", "style", "head", "title", "template", "noscript"]);

/** An address worth printing after a link text: web and mail addresses, not anchors, scripts or embedded pictures. */
function printableHref(href: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|data|cid|blob|file):/i.test(h)) return null;
  return h;
}

/** The marker number of an ordered list item in the numbering of `<ol type>`: 1. a. A. i. I. */
function marker(n: number, type: string): string {
  if (type === "a" || type === "A") {
    let s = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
    return type === "A" ? s.toUpperCase() : s;
  }
  if (type === "i" || type === "I") {
    const R: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    let k = n;
    for (const [v, r] of R) while (k >= v) (s += r), (k -= v);
    return type === "I" ? s.toUpperCase() : s;
  }
  return String(n);
}

const same = (text: string, href: string): boolean => {
  const norm = (x: string) => x.trim().replace(/^mailto:/i, "").replace(/\/+$/, "").toLowerCase();
  return norm(text) === norm(href);
};

export function htmlToText(html: string): string {
  const lines: string[] = [];
  let cur = ""; // the line being written, without its quote marks
  let lead = 0; // how much of it is a list marker (a line with nothing but its marker is not ended by the paragraph inside the item)
  let quote = 0; // blockquote depth
  let pre = 0; // inside <pre> or white-space:pre*: line breaks of the source count
  let cell = 0; // inside a table cell: a line break is a blank
  let skip = ""; // inside <script> / <style> ...
  const lists: { ordered: boolean; n: number; type: string }[] = [];
  const links: { href: string | null; text: string }[] = [];
  const preStack: boolean[] = [];

  const mark = () => (quote ? "> ".repeat(quote) : "");
  const flush = () => {
    if (lead === 0 && cur.trim() === "") cur = ""; // (a line of nothing but no-break spaces, Word's empty paragraph, is an empty line)
    const line = cur === "" && quote ? mark().trimEnd() : mark() + cur;
    // one blank line is enough, and the text does not open with one
    if (!(cur === "" && (lines.length === 0 || lines[lines.length - 1] === line))) lines.push(line);
    cur = "";
    lead = 0;
  };
  /** end the line even when it is empty (<br>, </p>: a blank line stays a blank line) */
  const brk = () => {
    if (cell) {
      if (cur && !/[\s]$/.test(cur)) cur += " ";
      return;
    }
    flush();
  };
  /** end the line only when it holds something (the start / end of a block) */
  const endLine = () => {
    if (cell) return brk();
    if (cur.length > lead && cur.slice(lead).trim() !== "") flush();
  };
  const put = (s: string) => {
    if (!s) return;
    cur += s;
    for (const l of links) l.text += s;
  };
  const text = (raw: string) => {
    // a no-break space keeps its width (the layout of a quoted plain-text mail, W2.25): it is told apart from a blank until the lines are done
    let s = decodeEntities(raw.replace(/&(?:nbsp|#160|#xa0);/gi, "\u00a0")).replace(/[​-‍⁠﻿]/g, "");
    if (pre) {
      const parts = s.replace(/\r\n?/g, "\n").split("\n");
      parts.forEach((p, k) => {
        if (k > 0) brk();
        put(p);
      });
      return;
    }
    s = s.replace(/[^\S\u00a0]+/g, " ");
    // white space at the start of a line (or after another blank) is the layout of the source, not text
    if (cur === "" || /[^\S\u00a0]$/.test(cur)) s = s.replace(/^ /, "");
    // a single no-break space in front of a line is a mail program's habit (Outlook), an indent is two or more
    if (cur === "") s = s.replace(/^\u00a0(?![ \u00a0])/, "");
    put(s);
  };

  for (const tok of tokens(html)) {
    if (skip) {
      if ("tag" in tok && tok.close && tok.tag === skip) skip = "";
      continue;
    }
    if ("text" in tok) {
      text(tok.text);
      continue;
    }
    const { tag, close, attrs } = tok;
    if (SKIP.has(tag)) {
      if (!close) skip = tag;
      continue;
    }
    switch (tag) {
      case "br":
        brk();
        break;
      case "p":
        if (close) brk();
        else endLine();
        break;
      case "div":
      case "section":
      case "article":
      case "header":
      case "footer":
      case "figure":
      case "address":
        if (!close) {
          endLine();
          preStack.push(/white-space\s*:\s*pre/i.test(attrs.style ?? ""));
          if (preStack[preStack.length - 1]) pre++;
        } else {
          endLine();
          if (preStack.pop()) pre--;
        }
        break;
      case "pre":
        endLine();
        pre += close ? -1 : 1;
        if (pre < 0) pre = 0;
        break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        endLine();
        break;
      case "ul":
      case "ol":
        if (close) {
          lists.pop();
          if (lead > 0 && cur.length === lead) flush(); // an empty last item still shows its marker
          else endLine();
        } else {
          endLine();
          lists.push({ ordered: tag === "ol", n: (parseInt(attrs.start ?? "", 10) || 1) - 1, type: attrs.type ?? "1" });
        }
        break;
      case "li":
        if (close) endLine();
        else {
          if (cur !== "") flush();
          const l = lists[lists.length - 1];
          const indent = "  ".repeat(Math.max(0, lists.length - 1));
          if (l) l.n++;
          put(indent + (l?.ordered ? `${marker(l.n, l.type)}. ` : "- "));
          lead = cur.length;
        }
        break;
      case "blockquote":
        endLine();
        // a quote does not end with blank quote lines
        if (close) while (lines.length && quote && lines[lines.length - 1] === mark().trimEnd()) lines.pop();
        quote = Math.max(0, quote + (close ? -1 : 1));
        break;
      case "table":
      case "thead":
      case "tbody":
      case "tfoot":
      case "tr":
        cell = 0;
        endLine();
        break;
      case "td":
      case "th":
        if (!close) {
          if (cell) {
            cur = cur.replace(/[ \u00a0]+$/, "");
            put("\t");
          }
          cell = 1;
        }
        break;
      case "hr":
        endLine();
        if (!cell) {
          put("----------");
          flush();
        }
        break;
      case "a":
        if (close) {
          const l = links.pop();
          const href = l && l.href ? printableHref(l.href) : null;
          if (l && href) {
            const shown = l.text.trim();
            if (!shown) put(href);
            else if (!same(shown, href)) put(` (${href})`);
          }
        } else links.push({ href: attrs.href ?? null, text: "" });
        break;
      case "img":
        if ((attrs.alt ?? "").trim()) put(`[${attrs.alt.trim()}]`);
        break;
      default:
        break;
    }
  }
  if (cur !== "") flush();
  return lines
    .map((l) => l.replace(/\u00a0/g, " "))
    .map((l) => (l === "-- " || l.endsWith("> -- ") ? l : l.replace(/[ \t]+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
