// The quoted original of a reply or forward (spec-rich-text.md REQ-35): the HTML of the message answered, cleaned to what the outgoing sanitiser
// (src-tauri/src/outgoing.rs) lets through, so that the quote block of the composer shows exactly the bytes that are sent. The original keeps its look:
// the simple rules of its <style> sheets are written into the elements, <font> and <center> become inline styles, old-style attributes (bgcolor, width,
// align, valign, cellpadding ...) stay. Taken away: scripts, frames, objects, forms and their controls, event handlers, ids, classes, comments and
// conditional comments, VML / Word markup, hidden text (a newsletter's pre-header), `url()` and every CSS property outside the allow-list, links that are not
// http / https / mailto / tel, pictures that are not a `data:` raster picture or a web picture (a `cid:` picture that could not be fetched, `file:`, UNC, svg)
// and tracking pixels (a picture of 3 x 3 px or less). Pictures from the web stay in the HTML (they are shown only by the recipient; the composer never
// requests them: quoteBlock display). A huge or deeply tangled original is quoted as plain text instead.
// Pure (no DOM, one tree reader): a plain Node script gives the same answer as the app (scripts/test-quote.mjs and its stored files).

import { parseHtml, textOf, toHtml, type El, type Nd } from "./pasteTree.ts";
import { decls, ruleList } from "./pasteClean.ts";
import { htmlToText } from "../htmlText.ts";

/** The original is not read at all above this many characters (it is quoted as text). */
export const MAX_SOURCE = 4_000_000;
/** The cleaned quote may be this long; a longer one is quoted as text. */
export const MAX_QUOTE_HTML = 1_500_000;
/** A quote as text is cut at a line end before this many characters. */
export const MAX_QUOTE_TEXT = 300_000;
/** More elements than this: quoted as text. */
const MAX_NODES = 40_000;

export interface QuoteResult {
  html: string;
  /** pictures from the web that stay in the HTML (not loaded by the composer) */
  remote: number;
  /** the original was quoted as plain text (too large, or no HTML) */
  asText: boolean;
  /** the text was cut */
  cut: boolean;
}

const KEEP = new Set(
  "p br div span strong b em i u s strike sub sup a ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code hr img table thead tbody tfoot tr th td caption colgroup col".split(" "),
);
/** removed with everything inside */
const DROP = new Set(
  "script style head title template noscript iframe frame frameset object embed applet svg math select textarea option datalist canvas audio video source track map area xml noembed noframes plaintext link meta base input".split(" "),
);
/** become a div */
const AS_DIV = new Set("section article header footer main nav aside figure figcaption address dl dt dd fieldset details summary hgroup".split(" "));
const RENAME: Record<string, string> = { del: "s", ins: "u", tt: "code" };

const CSS_PROPS = new Set(
  "font-family font-size font-weight font-style text-decoration color background-color text-align line-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-color border-style border-width border-collapse width height max-width vertical-align list-style-type direction white-space".split(
    " ",
  ),
);
const CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);

// ---------------------------------------------------------------- values

/** A URL as a browser reads it (outgoing.rs `normalize_url`): tab / newline removed, blanks and control characters cut, inner spaces `%20`. */
function normUrl(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-  ]+|[\u0000-  ]+$/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/ /g, "%20");
}
const isWeb = (u: string) => /^https?:\/\//i.test(u) && !u.includes("\\");
const safeHref = (raw: string): string | null => {
  const u = normUrl(raw);
  return isWeb(u) || /^(?:mailto|tel):./i.test(u) ? u : null;
};

/** Pictures: `data:` rasters and the web. A `cid:` picture is only here when the composer could not fetch it (it would be a broken box). */
function safeSrc(raw: string): { src: string; remote: boolean } | null {
  const u = normUrl(raw);
  if (isWeb(u)) return { src: u, remote: true };
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=%]+$/i.test(u) && u.length <= 8 * 1024 * 1024) return { src: u, remote: false };
  return null;
}

const NUM = /^\s*(\d{1,5})(?:\.\d+)?\s*(px)?\s*(%?)\s*$/i;
/** `600`, `600px`, `50%` -> `600`, `50%`; anything else (auto, calc) -> null. */
const size = (v: string | undefined): string | null => {
  const m = v === undefined ? null : NUM.exec(v);
  return m ? `${m[1]}${m[3]}` : null;
};
const digits = (v: string | undefined, max: number): string | null => (v !== undefined && new RegExp(`^\\s*\\d{1,${max}}\\s*$`).test(v) ? v.trim() : null);
const colorAttr = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  const hex = s.replace(/^#/, "");
  if (/^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(hex) && (s.startsWith("#") || /^[0-9a-f]{6}$/i.test(s))) return "#" + hex;
  return /^[a-z]{3,20}$/i.test(s) ? s : null;
};

/** The declarations the sanitiser keeps, as one `style` value (outgoing.rs `clean_style`); "" when none is left. */
export function cleanStyle(d: Record<string, string>): string {
  const out: string[] = [];
  for (const [prop, raw] of Object.entries(d)) {
    let p = prop;
    let value = raw.replace(/!\s*important/i, "").trim();
    if (p === "background") {
      // the shorthand: only its colour survives
      const c = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]{3,20}\b/i.exec(value.replace(/url\([^)]*\)/gi, ""));
      if (!c || /^(?:none|transparent|inherit|initial|repeat|no-repeat|scroll|fixed|center|top|left|right|bottom|cover|contain)$/i.test(c[0])) continue;
      p = "background-color";
      value = c[0];
    }
    if (!CSS_PROPS.has(p) || !value || value.length > 300) continue;
    if (/[\u0000-\u001f\u007f{}@/=`$\\<>]/.test(value)) continue;
    const lower = value.toLowerCase();
    if (lower.includes("javascript") || lower.includes("expression") || lower.includes("import")) continue;
    let ok = true;
    for (const f of lower.matchAll(/([a-z0-9-]*)\s*\(/g)) ok &&= CSS_FUNCTIONS.has(f[1]);
    if (!ok) continue;
    const at = out.findIndex((x) => x.startsWith(p + ":"));
    if (at >= 0) out.splice(at, 1); // (the later declaration wins, as in CSS)
    out.push(`${p}:${value}`);
  }
  return out.join(";");
}

/** Text a reader never sees (a newsletter's pre-header): hidden by a property the sanitiser would drop, which would make it visible. */
function hidden(d: Record<string, string>, el: El): boolean {
  if ("hidden" in el.attrs) return true;
  const v = (k: string) => (d[k] ?? "").replace(/!\s*important/i, "").trim().toLowerCase();
  if (v("display") === "none" || v("visibility") === "hidden" || v("visibility") === "collapse" || v("mso-hide") === "all") return true;
  const zero = (x: string) => /^0+(?:\.0+)?(?:px|pt|em|%)?$/.test(x);
  const clip = v("overflow") === "hidden" || v("overflow-y") === "hidden";
  return clip && (zero(v("max-height")) || zero(v("height")) || zero(v("max-width")));
}

// ---------------------------------------------------------------- the walk

interface Rule {
  tag: string;
  cls: string;
  spec: number;
  d: Record<string, string>;
}

/** The simple rules (`tag`, `.class`, `tag.class`) of the <style> elements, weakest first. */
function readRules(root: El): Rule[] {
  const rules: Rule[] = [];
  const walk = (e: El) => {
    for (const k of e.kids) {
      if (typeof k === "string") continue;
      if (k.tag !== "style") {
        walk(k);
        continue;
      }
      for (const [selectors, body] of ruleList(textOf(k).slice(0, 400_000))) {
        const d = decls(body);
        for (const sel of selectors.split(",")) {
          const s = /^\s*([a-z][a-z0-9]*)?(?:\.([\w-]+))?\s*$/i.exec(sel.slice(0, 100));
          if (!s || (!s[1] && !s[2])) continue;
          rules.push({ tag: (s[1] ?? "").toLowerCase(), cls: s[2] ?? "", spec: (s[1] ? 1 : 0) + (s[2] ? 10 : 0), d });
        }
      }
    }
  };
  walk(root);
  return rules.map((r, i) => [r, i] as const).sort((a, b) => a[0].spec - b[0].spec || a[1] - b[1]).map((x) => x[0]);
}

/** `font: italic bold 12px/1.4 'Helvetica Neue', Arial` (Apple's programs write it) split into the properties the sanitiser keeps; a value it cannot read is dropped. */
function fontShorthand(d: Record<string, string>): void {
  const v = d.font.replace(/!\s*important/i, "").trim();
  delete d.font;
  const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)([\d.]+(?:px|pt|em|%)|(?:xx?-)?(?:small|large)|medium|larger|smaller)(?:\/(\S+))?\s+(.+)$/i.exec(v);
  if (!m) return;
  for (const w of m[1].split(/\s+/).filter(Boolean)) {
    if (/^(?:italic|oblique)$/i.test(w)) d["font-style"] = "italic";
    else if (/^(?:bold|bolder|[5-9]00)$/i.test(w)) d["font-weight"] = "bold";
  }
  d["font-size"] = m[2];
  if (m[3] && /^[\d.]+(?:px|pt|em|%)?$/.test(m[3])) d["line-height"] = m[3];
  d["font-family"] = m[4];
}

class TooBig extends Error {}

class Cleaner {
  remote = 0;
  nodes = 0;
  rules: Rule[];
  constructor(rules: Rule[]) {
    this.rules = rules;
  }

  /** The declarations of an element: the sheet's rules for its tag and classes, then its own `style`. */
  styleOf(el: El): Record<string, string> {
    const d: Record<string, string> = {};
    if (this.rules.length) {
      const classes = (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
      for (const r of this.rules) if ((!r.tag || r.tag === el.tag) && (!r.cls || classes.includes(r.cls))) Object.assign(d, r.d);
    }
    if (el.attrs.style) Object.assign(d, decls(el.attrs.style));
    if (d.font) fontShorthand(d);
    return d;
  }

  list(kids: readonly Nd[]): Nd[] {
    const out: Nd[] = [];
    for (const k of kids) {
      if (typeof k === "string") out.push(k);
      else out.push(...this.element(k));
    }
    return out;
  }

  element(el: El): Nd[] {
    if (++this.nodes > MAX_NODES) throw new TooBig();
    const tag = el.tag;
    if (DROP.has(tag) || /^(?:v|w|m|xml):/.test(tag)) return [];
    const d = this.styleOf(el);
    // (a sheet that hides the whole document is a trick, not a layout: the body is always quoted)
    if (tag !== "body" && hidden(d, el)) return [];
    const style = (extra: Record<string, string> = {}) => cleanStyle({ ...extra, ...d });
    const attrs: Record<string, string> = {};
    const put = (k: string, v: string | null | undefined) => {
      if (v) attrs[k] = v;
    };
    const dir = (el.attrs.dir ?? "").trim().toLowerCase();
    const common = (s: string) => {
      put("style", s);
      if (dir === "ltr" || dir === "rtl" || dir === "auto") put("dir", dir);
      const al = (el.attrs.align ?? "").trim().toLowerCase();
      if (/^(?:left|right|center|justify)$/.test(al)) put("align", al);
    };
    const wrap = (name: string, s: string, extraAttrs: Record<string, string> = {}): Nd[] => {
      Object.assign(attrs, extraAttrs);
      common(s);
      return [{ tag: name, attrs, kids: this.list(el.kids) }];
    };

    switch (tag) {
      case "html":
        return this.list(el.kids);
      case "body": {
        const bg = colorAttr(el.attrs.bgcolor);
        const s = style(bg ? { "background-color": bg } : {});
        return s ? wrap("div", s) : this.list(el.kids);
      }
      case "font": {
        const px: Record<string, string> = {};
        const face = (el.attrs.face ?? "").split(",").map((f) => f.trim().replace(/["']/g, "")).filter((f) => /^[\w .-]{1,60}$/.test(f));
        if (face.length) px["font-family"] = face.map((f) => (/ /.test(f) ? `'${f}'` : f)).join(",");
        const sz = { "1": 8, "2": 10, "3": 12, "4": 14, "5": 18, "6": 24, "7": 36 }[(el.attrs.size ?? "").trim()];
        if (sz) px["font-size"] = `${sz}pt`;
        const c = colorAttr(el.attrs.color);
        if (c) px.color = c;
        return wrap("span", style(px));
      }
      case "center":
        return wrap("div", style({ "text-align": "center" }));
      case "big":
        return wrap("span", style({ "font-size": "larger" }));
      case "small":
        return wrap("span", style({ "font-size": "smaller" }));
      case "mark":
        return wrap("span", style({ "background-color": "#ffff00" }));
      case "img":
        return this.picture(el, d);
      case "a": {
        const href = safeHref(el.attrs.href ?? "");
        const s = style();
        if (!href) return s ? wrap("span", s) : this.list(el.kids);
        put("href", href);
        if (el.attrs.title) put("title", el.attrs.title.slice(0, 1000));
        return wrap("a", s);
      }
      case "ol":
        put("type", /^(?:1|a|A|i|I)$/.test((el.attrs.type ?? "").trim()) ? el.attrs.type.trim() : null);
        put("start", digits(el.attrs.start, 3));
        return wrap("ol", style());
      case "li":
        put("value", digits(el.attrs.value, 3));
        return wrap("li", style());
      case "table": {
        put("border", digits(el.attrs.border, 3));
        put("cellpadding", digits(el.attrs.cellpadding, 3));
        put("cellspacing", digits(el.attrs.cellspacing, 3));
        put("width", size(el.attrs.width));
        put("bgcolor", colorAttr(el.attrs.bgcolor));
        return wrap("table", style());
      }
      case "td":
      case "th":
        put("colspan", digits(el.attrs.colspan, 3));
        put("rowspan", digits(el.attrs.rowspan, 3));
        put("width", size(el.attrs.width));
        put("height", size(el.attrs.height));
        put("bgcolor", colorAttr(el.attrs.bgcolor));
        return this.valign(el, attrs, wrap, tag, style());
      case "tr":
        put("bgcolor", colorAttr(el.attrs.bgcolor));
        return this.valign(el, attrs, wrap, tag, style());
      case "col":
        put("span", digits(el.attrs.span, 3));
        put("width", size(el.attrs.width));
        return wrap("col", style());
      case "colgroup":
        put("span", digits(el.attrs.span, 3));
        return wrap("colgroup", style());
      default:
    }
    if (RENAME[tag]) return wrap(RENAME[tag], style());
    if (AS_DIV.has(tag)) return wrap("div", style());
    if (KEEP.has(tag)) return wrap(tag, style());
    return this.list(el.kids); // an unknown tag (o:p, st1:..., label, form ...): its content stays
  }

  private valign(el: El, attrs: Record<string, string>, wrap: (n: string, s: string, a?: Record<string, string>) => Nd[], tag: string, s: string): Nd[] {
    const v = (el.attrs.valign ?? "").trim().toLowerCase();
    if (/^(?:top|middle|bottom|baseline)$/.test(v)) attrs.valign = v;
    return wrap(tag, s);
  }

  /** A picture: its source must be local data or the web; a tracking pixel and a picture with nothing to show go. */
  picture(el: El, d: Record<string, string>): Nd[] {
    const alt = (el.attrs.alt ?? "").trim();
    const textOnly = (): Nd[] => (alt ? [alt.slice(0, 1000)] : []);
    const src = safeSrc(el.attrs.src ?? "");
    if (!src) return textOnly();
    const w = size(el.attrs.width ?? d.width);
    const h = size(el.attrs.height ?? d.height);
    const tiny = (x: string | null) => x !== null && !x.endsWith("%") && Number(x) <= 3;
    if (tiny(w) || tiny(h)) return []; // a tracking pixel
    const attrs: Record<string, string> = { src: src.src };
    if (alt) attrs.alt = alt.slice(0, 1000);
    if (w) attrs.width = w;
    if (h) attrs.height = h;
    const s = cleanStyle(d);
    if (s) attrs.style = s;
    const al = (el.attrs.align ?? "").trim().toLowerCase();
    if (/^(?:left|right|center)$/.test(al)) attrs.align = al;
    if (src.remote) this.remote++;
    return [{ tag: "img", attrs, kids: [] }];
  }
}

// ---------------------------------------------------------------- entry points

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text as HTML (the lines kept as they are). */
export function textHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${esc(text)}</div>`;
}

/** Text cut at a line end before MAX_QUOTE_TEXT characters; `note` (already translated) is the last line of a cut text. */
export function capText(text: string, note: string): { text: string; cut: boolean } {
  if (text.length <= MAX_QUOTE_TEXT) return { text, cut: false };
  const head = text.slice(0, MAX_QUOTE_TEXT);
  const nl = head.lastIndexOf("\n");
  return { text: (nl > MAX_QUOTE_TEXT / 2 ? head.slice(0, nl) : head) + "\n\n" + note, cut: true };
}

/** The HTML of an original, cleaned (see the top of the file). Throws nothing: an original that is too large or too tangled comes back as null. */
export function cleanQuoteHtml(html: string): { html: string; remote: number } | null {
  if (html.length > MAX_SOURCE) return null;
  try {
    const start = html.search(/<[a-zA-Z!]/);
    const root = parseHtml(start > 0 ? html.slice(start) : html);
    const c = new Cleaner(readRules(root));
    // a no-break space is written as the entity: the sent message shows what it is, and it survives a 7bit transport (W2.25)
    const out = toHtml(c.list(root.kids)).trim().replace(/\u00a0/g, "&nbsp;");
    return out.length > MAX_QUOTE_HTML ? null : { html: out, remote: c.remote };
  } catch (e) {
    if (e instanceof TooBig) return null;
    throw e;
  }
}

/**
 * The quoted original of a message: its HTML cleaned, else (no HTML, or too large) its text. `cutNote`: the translated line that ends a text that had to be cut.
 */
export function quoteOf(m: { html: string | null; text: string | null }, cutNote: string): QuoteResult {
  if (m.html) {
    const c = cleanQuoteHtml(m.html);
    if (c) return { html: c.html, remote: c.remote, asText: false, cut: false };
  }
  const raw = m.html ? (m.text && m.text.trim() ? m.text : htmlToText(m.html.slice(0, MAX_SOURCE))) : (m.text ?? "");
  const t = capText(raw, cutNote);
  return { html: textHtml(t.text), remote: 0, asText: true, cut: t.cut };
}
