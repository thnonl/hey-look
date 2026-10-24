// What a mail's `prefers-color-scheme` means in the reading pane (1.0.7 W5.5): the message background, not the system. A newsletter that styles itself with
// `@media (prefers-color-scheme: dark)` used to follow the engine's (the OS's) setting, so on a dark OS it drew its dark design on the "Original" (white) background and on a light OS it
// stayed light on the "Dark" one. Now every `prefers-color-scheme` feature of the mail's own <style> elements and `media` attributes (`<source>` in `<picture>`, `<style media>`) is replaced
// by a constant condition for the current background: Original = light (`light` true, `dark` false), Dark = dark; `no-preference` is never true; the bare `(prefers-color-scheme)` is true.
// The rest of a query (`screen and ... and (max-width: 600px)`, `not`, `only`, comma lists, any case and spacing, comments between the tokens) is left alone.
//
// Pure (strings in, strings out) except `reapply`, which walks a document. Imports nothing, so a plain Node script tests it (scripts/test-color-scheme-media.mjs).

/** A condition that is always true / never true in a frame (its width is never 0): written as a media feature, so it can stand where `(prefers-color-scheme: dark)` stood. */
export const ALWAYS = "(min-width:0px)";
export const NEVER = "(max-width:0px)";

// white space and comments, as CSS allows between the tokens of a media feature
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;
const FEATURE = new RegExp(String.raw`\(${GAP}prefers-color-scheme${GAP}(?::${GAP}([a-z-]+)${GAP})?\)`, "gi");

/** Whether the text holds a `prefers-color-scheme` feature at all (the cheap test before any work). */
export function hasColorSchemeQuery(text: string): boolean {
  return /prefers-color-scheme/i.test(text);
}

/** The same CSS (or media query list) with every `prefers-color-scheme` feature replaced by the constant that is right for the background. */
export function rewriteColorScheme(css: string, dark: boolean): string {
  if (!hasColorSchemeQuery(css)) return css;
  return css.replace(FEATURE, (_all, value: string | undefined) => {
    if (value === undefined) return ALWAYS; // `(prefers-color-scheme)`: true when the preference is not "no-preference", and it never is here
    const v = value.toLowerCase();
    if (v === "dark") return dark ? ALWAYS : NEVER;
    if (v === "light") return dark ? NEVER : ALWAYS;
    return NEVER; // `no-preference` (and anything the engine would not know): not true
  });
}

/** The attribute that keeps the mail's own text of a rewritten element, so that a change of the background can rewrite it again from the original. */
export const ORIG_ATTR = "data-hm-orig";
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The HTML of a mail with its `prefers-color-scheme` features made constant, for the frame's srcDoc: inside `<style>` elements and inside the `media` attribute of `<style>` and `<source>`
 * (nowhere else: a sentence of the mail that names the feature stays as it is). Each element that changed carries its original text in `data-hm-orig` (`<style>`) /
 * `data-hm-orig-media` (the attribute), which `reapply` reads.
 */
export function rewriteMailHtml(html: string, dark: boolean): string {
  if (!hasColorSchemeQuery(html)) return html;
  // <style ...>css</style>
  let out = html.replace(/(<style\b)([^>]*)>([\s\S]*?)(<\/style\s*>)/gi, (all, open: string, attrs: string, css: string, close: string) => {
    const hasCss = hasColorSchemeQuery(css);
    const media = /\smedia\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const mediaText = media ? (media[2] ?? media[3] ?? "") : "";
    const hasMedia = media !== null && hasColorSchemeQuery(mediaText);
    if (!hasCss && !hasMedia) return all;
    let a = attrs;
    if (hasMedia && media) a = a.replace(media[0], ` media="${escAttr(rewriteColorScheme(unescapeAttr(mediaText), dark))}" data-hm-orig-media="${escAttr(unescapeAttr(mediaText))}"`);
    const keep = hasCss ? ` ${ORIG_ATTR}="${escAttr(css)}"` : "";
    return `${open}${a}${keep}>${hasCss ? rewriteColorScheme(css, dark) : css}${close}`;
  });
  // <source ... media="...">
  out = out.replace(/<source\b[^>]*>/gi, (tag) => {
    const media = /\smedia\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!media) return tag;
    const text = unescapeAttr(media[2] ?? media[3] ?? "");
    if (!hasColorSchemeQuery(text)) return tag;
    return tag.replace(media[0], ` media="${escAttr(rewriteColorScheme(text, dark))}" data-hm-orig-media="${escAttr(text)}"`);
  });
  return out;
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Rewrites the elements of a loaded mail document again for a background (the frame is not reloaded: its scroll position, selection and pictures stay). Only the elements that
 * `rewriteMailHtml` marked are touched. Returns how many were changed.
 */
export function reapply(doc: Document, dark: boolean): number {
  let n = 0;
  doc.querySelectorAll(`style[${ORIG_ATTR}]`).forEach((el) => {
    const next = rewriteColorScheme(el.getAttribute(ORIG_ATTR) ?? "", dark);
    if (el.textContent !== next) {
      el.textContent = next;
      n++;
    }
  });
  doc.querySelectorAll("[data-hm-orig-media]").forEach((el) => {
    const next = rewriteColorScheme(el.getAttribute("data-hm-orig-media") ?? "", dark);
    if (el.getAttribute("media") !== next) {
      el.setAttribute("media", next);
      n++;
    }
  });
  return n;
}
