// Dark rendering of a mail inside its sandboxed frame: every colour the mail ends up with (text, links, borders,
// backgrounds, gradients, <font>/bgcolor attributes, <style> rules) is read once from the computed style and answered
// with a dark counterpart in a generated stylesheet. Nothing in the mail is edited: switching back to the original is
// disabling that stylesheet, and printing (@media screen only) always uses the original colours.

import { frameSandbox } from "./frameSandbox.ts";

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const WHITE: RGB = [255, 255, 255];
const TEXT_MIN = 4.5; // WCAG AA, normal text (also used for large text, which only needs 3)
const EDGE_MIN = 3; // borders / svg shapes (WCAG non-text contrast)
const HAIR_MIN = 1.6; // even a hairline keeps this much against what it sits on (shapes of buttons, cards, code blocks)
const SCRIM = 0.6; // dimming of a picture behind text: its brightest possible pixel ends up at about 40% grey
const ON_PICTURE_MIN = 5.5; // text on a picture is held to this against that worst case

/** Parses a computed colour (`rgb(...)` / `rgba(...)`, comma or space syntax). */
export function parseColor(s: string): RGBA | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s.trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

const toLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** WCAG relative luminance. */
const lum = ([r, g, b]: RGB) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a: RGB, b: RGB): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** sRGB -> OKLCH (perceptual lightness / chroma / hue: lightness changes do not drag the hue along). */
function toOklch([r, g, b]: RGB): { L: number; C: number; h: number } {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

/** OKLCH -> sRGB; a colour outside the sRGB gamut loses chroma (never hue) until it fits. */
function fromOklch(L: number, C: number, h: number): RGB {
  let out: RGB = [0, 0, 0];
  for (let i = 0; i < 24; i++) {
    const a = C * Math.cos(h), b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    out = lin.map((v) => Math.round(Math.min(255, Math.max(0, fromLin(Math.min(1, Math.max(0, v))))))) as RGB;
    if (lin.every((v) => v > -0.001 && v < 1.001)) break;
    C *= 0.9;
  }
  return out;
}

/**
 * Dark counterpart of a BACKGROUND colour: already dark colours stay, mid tones (brand blue, red...) get deeper and
 * light ones (white cards, pastel highlights) become dark surfaces slightly lighter than the canvas, keeping their hue
 * and order (a white card stays above a light-grey page, a zebra row above the card).
 */
export function darkBg(c: RGB): RGB {
  const o = toOklch(c);
  if (o.L <= 0.4) return c; // already dark: the mail keeps its own dark look
  const hsl = (Math.max(...c) + Math.min(...c)) / 510;
  if (o.C > 0.05 && hsl < 0.7) return vivid(o); // saturated brand colour (amber, teal, blue, red...): deep but still vivid
  const base = o.L <= 0.8 ? 0.4 - (o.L - 0.4) * 0.5 : 0.2 + 0.09 * ((o.L - 0.8) / 0.2) ** 2.2;
  // pale tints (highlights, light gradients) keep most of their chroma and get a lighter, deliberate dark tint
  const L = Math.max(base, Math.min(0.42, base + o.C * 1.2));
  return fromOklch(L, o.C * (1 - 0.15 * Math.min(1, (o.L - 0.4) / 0.5)), o.h);
}

/** Deep version of a saturated colour: chroma stays (close to) the original, lightness drops only as far as needed so white text reads on it (>= 4.8:1). */
function vivid(o: { L: number; C: number; h: number }): RGB {
  const C = o.C * 0.95;
  const fits = (L: number) => {
    const a = 0.9 * C * Math.cos(o.h), b = 0.9 * C * Math.sin(o.h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].every((v) => v > -0.001 && v < 1.001);
  };
  let L = 0.36;
  while (L < 0.55 && !fits(L)) L += 0.01; // the gamut of amber / yellow needs more lightness for the same chroma than blue
  L = Math.min(L, o.L);
  let out = fromOklch(L, C, o.h);
  while (L > 0.3 && contrast(WHITE, out) < 4.8) out = fromOklch((L -= 0.01), C, o.h);
  return out;
}

/** Same hue, raised in lightness from `c` until it has at least `min` contrast on `bg` (a line that has to stay visible without being bright). */
export function lift(c: RGB, bg: RGB, min: number): RGB {
  const o = toOklch(c);
  for (let L = o.L; L <= 1.001; L += 0.01) {
    const r = fromOklch(Math.min(L, 1), o.C, o.h);
    if (contrast(r, bg) >= min) return r;
  }
  return WHITE;
}

/** Light counterpart of a text / line colour with at least `min` contrast on `bg` (same hue; dark colours flip, light ones stay). */
export function lightText(fg: RGB, bg: RGB, min: number): RGB {
  const o = toOklch(fg);
  const C = Math.min(o.C, 0.16);
  for (let L = Math.max(o.L, 0.95 - 0.35 * o.L); L <= 1.001; L += 0.02) {
    const c = fromOklch(Math.min(L, 1), C, o.h);
    if (contrast(c, bg) >= min) return c;
  }
  return contrast(WHITE, bg) >= contrast([0, 0, 0], bg) ? WHITE : [0, 0, 0];
}

/**
 * A neutral light colour (white, off-white, light grey, with at most a trace of tint): the "paper" of a mail. Its dark
 * counterpart is not a lighter shade of the canvas but the canvas itself, so a wrapper, card, heading or paragraph
 * block painted white leaves no visible box behind it. Pale tints with real chroma (a light-blue card, cream, pastel
 * highlights) and mid greys are not paper: they keep their own dark tint.
 */
export function isPaper(c: RGB): boolean {
  const o = toOklch(c);
  return o.L >= 0.88 && o.C <= 0.011;
}

/** Elements that keep a tinted dark counterpart of a light grey background: controls and inline marks, which have to stand out from the page. */
const TINTED = new Set(["a", "button", "input", "select", "textarea", "option", "summary", "code", "kbd", "samp", "mark", "img", "hr", "meter", "progress", "svg"]);

let probe: CanvasRenderingContext2D | null | undefined;
/** A colour the computed style left in a syntax parseColor cannot read (color(), oklch(), lab()...), resolved to sRGB through a canvas. */
function resolveColor(s: string): RGBA | null {
  try {
    if (probe === undefined) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#010203";
    probe.fillStyle = s; // an unreadable value leaves the sentinel behind
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    if (d[3] === 255 && d[0] === 1 && d[1] === 2 && d[2] === 3) return null;
    return [d[0], d[1], d[2], d[3] / 255];
  } catch {
    return null;
  }
}

/** Composites a colour with alpha over an opaque backdrop. */
const over = ([r, g, b, a]: RGBA, bg: RGB): RGB => [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
const css = (c: RGB) => `rgb(${c.map(Math.round).join(",")})`;
const cssA = (c: RGB, a: number) => (a >= 1 ? css(c) : `rgba(${c.map(Math.round).join(",")},${a})`);

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
const NEW_COLOR_FN = /oklch|oklab|\blab\(|\blch\(|\bcolor\(|color-mix|\bhsl|\bhwb/i;

interface Read {
  /** position in the walk's list (the element itself, then everything in the body): where a cached result puts its tag back */
  at: number;
  el: Element;
  color: string;
  bg: string;
  img: string;
  shadow: string;
  edge: { side: string; color: string }[];
  fill: string;
  stroke: string;
  svg: boolean;
  text: boolean;
}

/**
 * Builds the dark stylesheet for a mail document and tags the elements it styles (`data-hm`). Must run with the
 * dark base styles on and no earlier dark sheet, so it reads the mail's own colours. `base` is the surface behind the mail.
 * `scope`: only that element and what is inside it (a part of the app's own page, such as the signature in the composer) instead of the whole document.
 * `tags` (the message frame only): receives, for each element of the walk's list (the document element, then every element in the body, in tree order) the number of its
 * `data-hm` rule, or -1; with the sheet's text it is all that is needed to dress the same document again without reading a single style (1.0.7 fix42, see `setMailDark`).
 */
export function buildDarkSheet(doc: Document, base: RGB, scope?: Element, tags?: number[]): string {
  const win = doc.defaultView;
  if (!win || !doc.body) return "";
  darkStats.walks++;
  // pass 1: read everything first (no writes in between, so the style is recalculated once)
  const reads: Read[] = [];
  const top = scope ?? doc.documentElement;
  const list = [top, ...Array.from((scope ?? doc.body).querySelectorAll("*"))];
  if (tags) tags.length = list.length, tags.fill(-1);
  for (let at = 0; at < list.length; at++) {
    const el = list[at];
    const cs = win.getComputedStyle(el);
    darkStats.computed++;
    if (scratch && doc === scratch.contentDocument) darkStats.inScratch++;
    else darkStats.inFrame++;
    if (cs.display === "none") continue;
    const edge: Read["edge"] = [];
    for (const s of SIDES) {
      if (cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "none" || cs.getPropertyValue(`border-${s.toLowerCase()}-style`) === "hidden") continue;
      if (parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0) edge.push({ side: s.toLowerCase(), color: cs.getPropertyValue(`border-${s.toLowerCase()}-color`) });
    }
    const svg = el.namespaceURI === "http://www.w3.org/2000/svg" && el.localName !== "svg";
    reads.push({
      at,
      el,
      color: cs.color,
      bg: cs.backgroundColor,
      img: cs.backgroundImage,
      shadow: cs.textShadow,
      edge,
      fill: svg ? cs.fill : "",
      stroke: svg ? cs.stroke : "",
      svg,
      text: el !== top && /\S/.test(el.textContent ?? ""),
    });
  }

  // pass 2: dark counterpart of each colour, top-down so an element knows what it really sits on
  const effNew = new Map<Element, RGB>();
  const effOld = new Map<Element, RGB>();
  const above = (m: Map<Element, RGB>, el: Element | null, fallback: RGB): RGB => {
    for (let e = el; e; e = e.parentElement) {
      const c = m.get(e);
      if (c) return c;
    }
    return fallback;
  };
  const groups = new Map<string, number>();
  const rules: string[] = [];
  for (const r of reads) {
    const decl: string[] = [];
    let now = above(effNew, r.el.parentElement, base);
    let was = above(effOld, r.el.parentElement, WHITE);
    const bg = parseColor(r.bg) ?? (NEW_COLOR_FN.test(r.bg) ? resolveColor(r.bg) : null);
    const tinted = TINTED.has(r.el.localName);
    // the dark counterpart of a background: paper (white / light grey) is the app surface itself, anything else darkBg
    const dark = (c: RGB): RGB => (!tinted && isPaper(c) ? base : darkBg(c));
    if (bg && bg[3] > 0) {
      const d = dark([bg[0], bg[1], bg[2]]);
      decl.push(`background-color:${cssA(d, bg[3])}`);
      now = over([...d, bg[3]], now);
      was = over(bg, was);
    }
    if (/gradient\(/.test(r.img)) {
      if (NEW_COLOR_FN.test(r.img)) {
        // colour syntax we cannot read: a flat dark surface instead of the gradient
        now = dark(was);
        decl.push(`background-image:none`, `background-color:${css(now)}`);
      } else {
        let worst = now;
        const img = r.img.replace(/rgba?\([^)]*\)/g, (c) => {
          const p = parseColor(c);
          if (!p) return c;
          const d = dark([p[0], p[1], p[2]]);
          const stop = over([...d, p[3]], now);
          if (lum(stop) > lum(worst) || worst === now) worst = stop;
          return cssA(d, p[3]);
        });
        decl.push(`background-image:${img}`);
        now = worst; // text on a gradient has to read on its lightest stop
      }
    }
    // a photo behind text (url background): dimmed from inside (below the content), and text on it is held to the
    // contrast it gets against the brightest picture that dimming allows (white pixels -> 40% grey)
    let textMin = TEXT_MIN;
    if (/url\(/.test(r.img) && r.text) {
      decl.push(`box-shadow:inset 0 0 0 100vmax rgba(0,0,0,${SCRIM})`);
      const worst: RGB = [255 * (1 - SCRIM), 255 * (1 - SCRIM), 255 * (1 - SCRIM)];
      if (lum(worst) > lum(now)) now = worst;
      textMin = ON_PICTURE_MIN;
    }
    effNew.set(r.el, now);
    effOld.set(r.el, was);

    const fg = parseColor(r.color);
    if (fg) {
      const seen = fg[3] < 1 ? over(fg, now) : ([fg[0], fg[1], fg[2]] as RGB);
      if (contrast(seen, now) < textMin) decl.push(`color:${css(lightText([fg[0], fg[1], fg[2]], now, textMin))}`);
    }
    if (r.shadow !== "none") decl.push("text-shadow:none");
    for (const e of r.edge) {
      const c = parseColor(e.color);
      if (!c || c[3] === 0) continue;
      const rgb: RGB = [c[0], c[1], c[2]];
      let out: RGB = rgb;
      if (contrast(over(c, was), was) >= 2) {
        // a rule / accent bar that was visible stays visible (>= 3:1), as close to its own brightness as that allows
        if (contrast(over(c, now), now) < EDGE_MIN) out = lift(darkBg(rgb), now, EDGE_MIN);
      } else {
        // hairline: stays subtle, but still draws the shape of the card / button / code block
        out = darkBg(rgb);
        if (contrast(out, now) < HAIR_MIN) out = lift(out, now, HAIR_MIN);
      }
      if (out !== rgb) decl.push(`border-${e.side}-color:${cssA(out, c[3])}`);
    }
    if (r.svg) {
      for (const [prop, val] of [["fill", r.fill], ["stroke", r.stroke]] as const) {
        const c = parseColor(val);
        if (c && c[3] > 0 && contrast(over(c, now), now) < EDGE_MIN) decl.push(`${prop}:${css(lightText([c[0], c[1], c[2]], now, EDGE_MIN))}`);
      }
    }
    if (decl.length === 0) continue;
    const key = decl.join(";");
    let id = groups.get(key);
    if (id === undefined) {
      id = groups.size;
      groups.set(key, id);
      rules.push(`[data-hm="${id}"]{${decl.map((d) => `${d}!important`).join(";")}}`);
    }
    r.el.setAttribute("data-hm", String(id));
    if (tags) tags[r.at] = id;
  }
  darkStats.rules += rules.length;
  // @layer: important declarations of an earlier layer beat the mail's own (unlayered) !important rules and inline styles
  const chip = "img[data-hm-chip]{background:#c2c5cd!important;border-radius:4px}"; // dim light backing (exactly the image box) for dark logos
  return `@media screen{@layer hm{${rules.join("")}${chip}}}`;
}

/**
 * Logos / signature images with a transparent background and mostly dark artwork would vanish on the dark canvas:
 * those get a light chip behind them (`data-hm-chip`). Decided by sampling the pixels, so it works for images that are
 * inline (data:) or already fetched by the backend; an image the browser will not let us read is left alone.
 */
export function markDarkLogos(scope: ParentNode): void {
  for (const img of Array.from(scope.querySelectorAll("img"))) {
    const test = () => {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0 || w0 > 480 || h0 > 240) return; // photos / banners are never chipped
      try {
        const k = Math.min(1, 64 / Math.max(w0, h0));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w0 * k));
        c.height = Math.max(1, Math.round(h0 * k));
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return;
        g.drawImage(img, 0, 0, c.width, c.height);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let clear = 0, solid = 0, dark = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 32) clear++;
          else if (px[i + 3] >= 128) {
            solid++;
            if ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255 < 0.4) dark++;
          }
        }
        const n = px.length / 4;
        if (clear / n >= 0.15 && solid / n >= 0.02 && dark / solid >= 0.6) img.setAttribute("data-hm-chip", "");
      } catch {
        /* tainted canvas (remote image): left as it is */
      }
    };
    if (img.complete) test();
    else img.addEventListener("load", test, { once: true });
  }
}

// (keyed by the root element: a document that is written again (mailFrame.ts) keeps its Document object but gets a new root, and its dark sheet has to be made again)
const sheets = new WeakMap<Element, HTMLStyleElement>();

/**
 * The dark walk of a mail, and where it runs (1.0.7 fix42, D-103). Mac QA root cause: on WebKit, reading the computed style of every element of a document keeps native style data
 * (about 5.7 MB for the 2 MB / 4,400-element fixture) after the frame is removed, and clearing the document or navigating the frame away before removing it does not give it back, so
 * every selection of a big mail in the dark canvas left that much behind (the same loop on the original canvas, where no walk runs, was flat). Two changes, neither of which
 * relies on cleaning up after `getComputedStyle`:
 *  1. the walk is made ONCE per mail: its result (the sheet's text and the rule number of every element in tree order: strings and numbers, never elements, rules or style objects)
 *     is kept for the last 8 mails, and the same mail in a new frame is dressed from it without reading a style;
 *  2. a walk that has to be made runs in ONE hidden frame that is kept for the life of the page (written again for each mail, emptied after it), never in the message frame, so
 *     the native style data lives and dies with that one document instead of piling up behind removed frames. Its result is copied into the message frame by tree position.
 * The scratch document is written from the same pieces as the message frame (same CSS, same mail, the dark class) at the same width, with a CSP that loads nothing, so the colours it
 * reads are the ones the message frame would have given. If the scratch frame cannot be used (no frame, a document of another shape) the message frame is walked as before.
 * `window.__darkMail` (read through the QA bridge `/eval`): walks made, answered from the cache, in the scratch frame, styles read in the scratch frame and in a message frame, rules made.
 */
const darkStats = { walks: 0, cached: 0, scratch: 0, computed: 0, inScratch: 0, inFrame: 0, rules: 0 };
const DARK_CACHE_MAX = 8;
const darkCache = new Map<string, { sheet: string; tags: Int32Array }>();
const cacheKey = (key: string, base: RGB) => `${key}|${base.join(",")}`;
const elementsOf = (doc: Document): Element[] => [doc.documentElement, ...Array.from(doc.body.querySelectorAll("*"))];
let scratch: HTMLIFrameElement | undefined;
const SCRATCH_CSP = "default-src 'none'; style-src 'unsafe-inline'";
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__darkMail", { get: () => ({ ...darkStats, cache: darkCache.size }), configurable: true });
  // (a QA / test seam: forget the cached walks)
  Object.defineProperty(window, "__darkMailClear", { value: () => darkCache.clear(), configurable: true });
}

/** What a written mail document is made of: the pieces it was written from (ReadingPane.tsx docParts), a name for them (`mailKey`) and the message frame it is in. */
export interface MailDarkInput {
  key: string;
  parts: readonly string[];
  frame: HTMLIFrameElement | null;
}

/** The walk, in the kept hidden frame. null when that cannot be done (the caller walks the message frame itself). */
function walkInScratch(mail: MailDarkInput, base: RGB): { sheet: string; tags: Int32Array } | null {
  if (typeof window === "undefined" || (window as { __darkMailScratch?: boolean }).__darkMailScratch === false) return null;
  const head = mail.parts[0];
  const csp = /(Content-Security-Policy" content=")[^"]*"/;
  if (!head || !csp.test(head) || !mail.frame) return null;
  try {
    if (!scratch || !scratch.isConnected) {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", frameSandbox(navigator.userAgent));
      f.setAttribute("aria-hidden", "true");
      f.tabIndex = -1;
      f.title = "";
      // laid out like the message frame (its width decides the mail's media queries) but out of sight and out of reach
      f.style.cssText = "position:fixed;left:-20000px;top:0;border:0;visibility:hidden;pointer-events:none;height:40px";
      document.body.appendChild(f);
      scratch = f;
    }
    scratch.style.width = `${mail.frame.clientWidth || mail.frame.getBoundingClientRect().width || 800}px`;
    const d = scratch.contentDocument;
    if (!d) return null;
    d.open();
    d.write(head.replace(csp, `$1${SCRATCH_CSP}"`));
    for (let i = 1; i < mail.parts.length; i++) d.write(mail.parts[i]);
    d.close();
    if (!d.body || !d.documentElement.hasAttribute("data-hm-doc")) return null;
    d.documentElement.classList.add("hm-dark"); // (the walk reads the mail with the dark base styles on, as in the message frame)
    const tags: number[] = [];
    const sheet = buildDarkSheet(d, base, undefined, tags);
    darkStats.scratch++;
    d.open(); // (one document at a time: nothing of this mail stays in the frame)
    d.close();
    return tags.length > 0 ? { sheet, tags: Int32Array.from(tags) } : null;
  } catch {
    return null;
  }
}

/**
 * Puts a mail document on (or takes it off) the dark background, in place: the class switches the base colours of the
 * frame, the generated sheet (built once, on first use) recolours the mail itself. Nothing reloads or moves.
 * `mail` names the document (ReadingPane.tsx): the same mail again, in a new frame, gets the sheet and the tags of the first walk back without reading a style, and a walk that has to be
 * made runs in the kept hidden frame (see above). Without it (the composer, a dev check) the document itself is walked.
 */
export function setMailDark(doc: Document, dark: boolean, base: RGB, mail?: MailDarkInput): void {
  const root = doc.documentElement;
  if (!root || !doc.head) return;
  if (!dark) {
    root.classList.remove("hm-dark", "hm-pend");
    const s = sheets.get(root);
    if (s) s.disabled = true;
    return;
  }
  root.classList.add("hm-dark");
  try {
    let s = sheets.get(root);
    if (!s) {
      s = doc.createElement("style");
      const ck = mail ? cacheKey(mail.key, base) : "";
      let res = ck ? darkCache.get(ck) : undefined;
      if (res) {
        darkStats.cached++;
        darkCache.delete(ck); // (least recently used goes first)
        darkCache.set(ck, res);
      } else if (mail) {
        res = walkInScratch(mail, base) ?? undefined;
        if (res) darkCache.set(ck, res);
      }
      const els = res ? elementsOf(doc) : null;
      if (res && els && els.length === res.tags.length) {
        s.textContent = res.sheet;
        for (let i = 0; i < els.length; i++) if (res.tags[i] >= 0) els[i].setAttribute("data-hm", String(res.tags[i]));
      } else {
        // no cached or scratch result for this document (or it does not have the shape of the one that was walked): walk this document itself
        if (res) darkCache.delete(ck);
        const tags: number[] = [];
        s.textContent = buildDarkSheet(doc, base, undefined, ck ? tags : undefined);
        if (ck && tags.length > 0) darkCache.set(ck, { sheet: s.textContent, tags: Int32Array.from(tags) });
      }
      while (darkCache.size > DARK_CACHE_MAX) darkCache.delete(darkCache.keys().next().value as string);
      doc.head.appendChild(s);
      sheets.set(root, s);
      markDarkLogos(doc);
    }
    s.disabled = false;
  } catch {
    root.classList.remove("hm-dark"); // could not recolour: the original colours beat unreadable ones
  } finally {
    root.classList.remove("hm-pend"); // the mail was hidden until it is recoloured
  }
}

/** A short name for a written mail document, from its pieces (never joined into one string): 32-bit FNV-1a over all of them and their total length. See `setMailDark`. */
export function mailKey(...parts: readonly string[]): string {
  let h = 0x811c9dc5;
  let n = 0;
  for (const p of parts) {
    n += p.length;
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${n.toString(36)}`;
}

/** The app surface a mail sits on (the frame itself is transparent). */
export function appSurface(): RGB {
  const c = parseColor(getComputedStyle(document.body).backgroundColor);
  return c ? [c[0], c[1], c[2]] : [27, 28, 32];
}
