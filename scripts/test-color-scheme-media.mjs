// 1.0.7 W5.5 (REQ-5.5.1, REQ-5.5.2; AC-5.5.1 static part), no browser. Run: node --experimental-strip-types scripts/test-color-scheme-media.mjs
// What a mail's `prefers-color-scheme` means: the message background (Original = light, Dark = dark), not the system. The pure rewrite of src/colorSchemeMedia.ts:
//   plain, compound, `not`, `only`, comma lists, upper case, no space after the colon, inside `@supports`, `media` attributes, CSS comments; text outside <style> and `media` is never touched
import assert from "node:assert/strict";
import fs from "node:fs";
import { ALWAYS, NEVER, hasColorSchemeQuery, rewriteColorScheme as rw, rewriteMailHtml } from "../src/colorSchemeMedia.ts";

let n = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};

check("the two constants are media features that are always / never true in a frame", () => {
  assert.equal(ALWAYS, "(min-width:0px)");
  assert.equal(NEVER, "(max-width:0px)");
});

check("plain queries: dark / light / no-preference, and the bare feature, for both backgrounds", () => {
  const c = (q) => `@media ${q}{body{color:red}}`;
  assert.equal(rw(c("(prefers-color-scheme: dark)"), false), c(NEVER), "Original: dark is false");
  assert.equal(rw(c("(prefers-color-scheme: dark)"), true), c(ALWAYS), "Dark: dark is true");
  assert.equal(rw(c("(prefers-color-scheme: light)"), false), c(ALWAYS));
  assert.equal(rw(c("(prefers-color-scheme: light)"), true), c(NEVER));
  for (const dark of [false, true]) assert.equal(rw(c("(prefers-color-scheme: no-preference)"), dark), c(NEVER), "no-preference is never true");
  for (const dark of [false, true]) assert.equal(rw(c("(prefers-color-scheme)"), dark), c(ALWAYS), "the bare feature: a preference exists");
});

check("the rest of the query keeps working: screen, and, max-width, not, only, comma lists", () => {
  assert.equal(rw("@media screen and (prefers-color-scheme: dark) and (max-width: 600px){a{b:c}}", true), `@media screen and ${ALWAYS} and (max-width: 600px){a{b:c}}`);
  assert.equal(rw("@media screen and (prefers-color-scheme: dark) and (max-width: 600px){a{b:c}}", false), `@media screen and ${NEVER} and (max-width: 600px){a{b:c}}`);
  assert.equal(rw("@media not (prefers-color-scheme: dark){x{y:z}}", false), `@media not ${NEVER}{x{y:z}}`, "`not` of a false condition is true");
  assert.equal(rw("@media only screen and (prefers-color-scheme:dark){x{y:z}}", true), `@media only screen and ${ALWAYS}{x{y:z}}`);
  assert.equal(rw("@media print, (prefers-color-scheme: dark), (max-width: 480px){x{y:z}}", false), `@media print, ${NEVER}, (max-width: 480px){x{y:z}}`);
  assert.equal(rw("@media (min-width: 600px) and (prefers-color-scheme: light){x{y:z}}", true), `@media (min-width: 600px) and ${NEVER}{x{y:z}}`);
});

check("upper case, spacing and comments between the tokens", () => {
  for (const q of ["(PREFERS-COLOR-SCHEME: DARK)", "(Prefers-Color-Scheme:Dark)", "(prefers-color-scheme:dark)", "( prefers-color-scheme : dark )", "(\n prefers-color-scheme:\n dark\n)", "(/* a */prefers-color-scheme/* b */:/* c */dark/* d */)"]) {
    assert.equal(rw(`@media ${q}{}`, true), `@media ${ALWAYS}{}`, q);
    assert.equal(rw(`@media ${q}{}`, false), `@media ${NEVER}{}`, q);
  }
});

check("inside @supports and nested rules; several queries in one sheet; other features untouched", () => {
  const css = "@supports (display:grid){@media (prefers-color-scheme: dark){a{color:#fff}}}@media (prefers-reduced-motion: reduce){b{c:d}}@media (prefers-color-scheme: light){e{f:g}}@media (prefers-contrast: more){h{i:j}}";
  assert.equal(rw(css, true), `@supports (display:grid){@media ${ALWAYS}{a{color:#fff}}}@media (prefers-reduced-motion: reduce){b{c:d}}@media ${NEVER}{e{f:g}}@media (prefers-contrast: more){h{i:j}}`);
  assert.equal(rw("@media (prefers-color-scheme: dark) and (prefers-color-scheme: light){x{y:z}}", true), `@media ${ALWAYS} and ${NEVER}{x{y:z}}`);
});

check("nothing to do: the same text comes back", () => {
  const css = "body{color:red}@media (max-width:600px){a{b:c}}";
  assert.equal(rw(css, true), css);
  assert.equal(hasColorSchemeQuery(css), false);
  assert.equal(hasColorSchemeQuery("(PREFERS-COLOR-SCHEME: dark)"), true);
  assert.equal(rwHtml("<p>Hello</p>", true), "<p>Hello</p>");
});

function rwHtml(html, dark) {
  return rewriteMailHtml(html, dark);
}

check("a mail: <style> blocks and media attributes are rewritten, the text of the mail is not", () => {
  const html = `<p>Tip: write @media (prefers-color-scheme: dark) in your CSS.</p><style>.logo-d{display:none}@media (prefers-color-scheme: dark){.logo-d{display:block}.logo-l{display:none}}</style>
    <picture><source media="(prefers-color-scheme: dark)" srcset="data:image/png;base64,AAAA"><img src="data:image/png;base64,BBBB"></picture><style media="(prefers-color-scheme: dark)">body{background:#000}</style>`;
  const light = rwHtml(html, false);
  assert.ok(light.includes("<p>Tip: write @media (prefers-color-scheme: dark) in your CSS.</p>"), "a sentence outside <style> and `media` stays as the sender wrote it");
  assert.ok(light.includes(`@media ${NEVER}{.logo-d{display:block}`), light);
  assert.ok(light.includes(`<source media="${NEVER}" data-hm-orig-media="(prefers-color-scheme: dark)" srcset=`), light);
  assert.ok(light.includes(`<style media="${NEVER}" data-hm-orig-media="(prefers-color-scheme: dark)">body{background:#000}</style>`), light);
  assert.ok(/<style data-hm-orig="[^"]*prefers-color-scheme: dark[^"]*">/.test(light), "the original text is kept for the next switch");
  const dark = rwHtml(html, true);
  assert.ok(dark.includes(`@media ${ALWAYS}{.logo-d{display:block}`) && dark.includes(`<source media="${ALWAYS}"`) && dark.includes(`<style media="${ALWAYS}"`), dark);
  // the original text in the attribute is escaped (a quote, an ampersand and a less-than sign cannot end the attribute)
  const tricky = rwHtml(`<style>a::before{content:"x&y<z"}@media (prefers-color-scheme: dark){b{c:d}}</style>`, false);
  assert.ok(/data-hm-orig="a::before\{content:&quot;x&amp;y&lt;z&quot;\}@media/.test(tricky), tricky);
  // single quotes and an unquoted-looking list
  assert.ok(rwHtml(`<source media='(prefers-color-scheme: dark)' srcset="x">`, true).includes(`media="${ALWAYS}"`));
});

check("the wiring: the frame's document is built with the rewrite, a switch of the background rewrites it again in place, print is light", () => {
  const rp = fs.readFileSync(new URL("../src/components/ReadingPane.tsx", import.meta.url), "utf8");
  assert.ok(rp.includes("rewriteMailHtml(html, darkNow.current),"), "the written document");
  assert.ok(/setMailDark\(doc, dark, DARK_CANVAS\);\s*[^\n]*\n\s*reapplyColorScheme\(doc, dark\);/.test(rp), "in place on a switch, no reload");
  assert.ok(rp.includes('"beforeprint", beforePrint') && rp.includes("reapplyColorScheme(doc, false)") && rp.includes('"afterprint", afterPrint'), "print is light");
  // compose is unchanged: the editor and the compose preview do not use it
  for (const f of fs.readdirSync(new URL("../src/components/", import.meta.url))) if (/^(Compose|RichEditor)/.test(f)) assert.ok(!fs.readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8").includes("colorSchemeMedia"), f);
});

console.log(`test-color-scheme-media: ok (${n} checks)`);
