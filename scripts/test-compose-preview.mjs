// The composer's "Preview as recipient" (F-23): the body is shown on a light or a dark background, as a view-layer effect only.
// Pure logic of src/composePreview.ts, plus source checks that the draft never reads the preview, that the dark preview uses the
// reading pane's own dark transformation, and that the toggle is a keyboard-operable pair of buttons.
// Run: node --experimental-strip-types scripts/test-compose-preview.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { t } from "../src/i18n/index.ts";
import { DARK_CANVAS, frameBaseCss } from "../src/mailCanvas.ts";
import { PREVIEW_COLORS, forgetPreview, previewFromCanvas, previewVars, rememberPreview, startPreview, togglePreview } from "../src/composePreview.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// the mode: follows the message background preference until the user chooses, then the choice lasts for the session
assert.equal(previewFromCanvas("original"), "light");
assert.equal(previewFromCanvas("dark"), "dark");
assert.equal(togglePreview("light"), "dark");
assert.equal(togglePreview("dark"), "light");
assert.equal(togglePreview(togglePreview("light")), "light");
// (WP13g) the start value is the app theme's: light in the light theme whatever is stored, the stored message background in the dark theme
forgetPreview();
assert.equal(startPreview(true, "original"), "light");
assert.equal(startPreview(true, "dark"), "dark");
assert.equal(startPreview(false, "dark"), "light", "light app: light preview even with a stored dark");
assert.equal(startPreview(false, "original"), "light");
rememberPreview("dark");
assert.equal(startPreview(true, "original"), "dark", "the session's choice wins over the preference");
assert.equal(startPreview(false, "original"), "dark");
rememberPreview("light");
assert.equal(startPreview(true, "dark"), "light");
forgetPreview();
assert.equal(startPreview(true, "dark"), "dark", "a switch of the theme forgets the choice: the new theme's start value");
assert.equal(startPreview(false, "dark"), "light");

// the surfaces are the reading pane's: same text, link and background colours as frameBaseCss
const css = frameBaseCss();
const [r, g, b] = DARK_CANVAS;
assert.ok(css.includes(`html{--hm-fg:${PREVIEW_COLORS.light.fg};--hm-link:${PREVIEW_COLORS.light.link};--hm-bg:${PREVIEW_COLORS.light.bg}}`), "light = the white page with the default dark text");
assert.ok(css.includes(`--hm-fg:${PREVIEW_COLORS.dark.fg};--hm-link:${PREVIEW_COLORS.dark.link};--hm-bg:${PREVIEW_COLORS.dark.bg}`), "dark = the reading pane's dark surface");
assert.equal(PREVIEW_COLORS.dark.bg, `rgb(${r},${g},${b})`);
for (const p of ["light", "dark"]) {
  const v = previewVars(p);
  assert.deepEqual(Object.keys(v).sort(), ["--pv-bg", "--pv-code", "--pv-fg", "--pv-link", "--pv-muted", "--pv-rule", "--pv-sel"]);
  assert.ok(Object.values(v).every((x) => typeof x === "string" && x.length > 0));
}

// the strings: the visible words are the existing Light / Dark of the theme menu, in the tooltip too
assert.equal(t("app.ribbon.themeLight"), "Light");
assert.equal(t("app.ribbon.themeDark"), "Dark");
assert.equal(t("compose.preview.label"), "Preview as recipient");
assert.match(t("compose.preview.lightTip"), /light background/);
assert.match(t("compose.preview.darkTip"), /dark background/);

// the draft: buildDraft (what is saved and sent) and its helpers know nothing of the preview, so the HTML is the same with it on or off
const compose = read("src/components/Compose.tsx");
const from = compose.indexOf("const buildDraft = (): Draft => {");
const draft = compose.slice(from, compose.indexOf("const reopen = ", from));
assert.ok(from > 0 && draft.includes("messageHtml(editor?.getJSON()"), "found buildDraft");
const PV = /(?<![\w-])pv(?![\w-])/; // the state variable (not the "pv-" class names)
assert.ok(!PV.test(draft) && !/preview|Preview|setDarkRegion|data-hm/.test(draft), "buildDraft does not read the preview");
const sec = compose.slice(compose.indexOf("const currentSecurity"), compose.indexOf("const addFilesRef"));
assert.ok(!PV.test(sec));
// the preview state is only used to look: the class and variables of the body surface, the region effect and the toggle
const uses = compose.split("\n").filter((l) => PV.test(l) || /\bsetPv\b/.test(l));
for (const l of uses) assert.ok(/useState<PreviewBg>|setPv\(p\)|setPv\(startPreview\(themeIsDark\(st\.prefs\.theme, osDark\(\)\), st\.prefs\.mailCanvas\)\)|pv-\$\{pv\}|previewVars\(pv\)|pv === "dark"|pv === "light"|, pv\]\)|setPreviewMode\(editor, pv\)|<PreviewSwitch pv=\{pv\} onChoose=\{choosePreview\}/.test(l), `preview state used only for display: ${l.trim()}`);
assert.match(compose, /className=\{`cp-editor cp-pv pv-\$\{pv\}`\} style=\{\{ \.\.\.previewVars\(pv\), "--cp-font": base\.family, "--cp-size": `\$\{base\.size\}pt` \} as React\.CSSProperties\}/);
assert.ok(!/useStore\.setState\(\{[^}]*pv/.test(compose) && !/setPrefs\(\{[^}]*pv/.test(compose), "no new preference, nothing persisted");

// the dark preview is the reading pane's transformation: the same buildDarkSheet, scoped to the signature region (the one place the composer holds a mail's own colours)
const dom = read("src/composePreviewDom.ts");
assert.match(dom, /import \{ buildDarkSheet, markDarkLogos \} from "\.\/darkMail";/);
assert.match(dom, /buildDarkSheet\(doc, DARK_CANVAS, scope\)/);
assert.match(dom, /import \{ DARK_CANVAS \} from "\.\/mailCanvas";/);
const rp = read("src/components/ReadingPane.tsx");
assert.match(rp, /setMailDark\(doc, /, "the reader keeps using the same module");
const dark = read("src/darkMail.ts");
assert.match(dark, /export function buildDarkSheet\(doc: Document, base: RGB, scope\?: Element\): string/);
assert.match(dark, /const top = scope \?\? doc\.documentElement;/, "without a scope the whole document, as before");
assert.match(compose, /setDarkRegion\(r, pv === "dark"\)/);
assert.match(compose, /querySelectorAll<HTMLElement>\("\.sig-block \.sig-body"\)/, "only the signature region is recoloured");
assert.ok(!/useCallback|sanitizeHtml/.test(dom), "the region is recoloured in place, not rebuilt");

// the toggle: two real buttons in a labelled group (Space, Enter), state announced with aria-pressed, the mouse leaves the focus in the editor.
// They are part of the formatting toolbar's roving focus (one Tab stop for the whole bar, AC-18): the bar renders the switch as its trailing part
const sw = read("src/editor/PreviewSwitch.tsx");
assert.match(compose, /trailing=\{\{ ids: \["pv:light", "pv:dark"\], render: \(rove\) => <PreviewSwitch /);
assert.match(sw, /role="group" aria-label=\{t\("compose\.preview\.label"\)\}/);
assert.equal((sw.match(/<button type="button"/g) ?? []).length, 2);
assert.equal((sw.match(/aria-pressed=/g) ?? []).length, 2);
assert.equal((sw.match(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/g) ?? []).length, 2, "the editor keeps its caret and selection");
assert.equal((sw.match(/title=\{t\("compose\.preview\.(light|dark)Tip"\)\} aria-label=\{t\("compose\.preview\.(light|dark)Tip"\)\}/g) ?? []).length, 2, "tooltip and name");
assert.equal((sw.match(/\{\.\.\.rove\("pv:(light|dark)"\)\}/g) ?? []).length, 2, "both take their tabIndex from the toolbar's roving focus: Tab goes from the toolbar to the body");
assert.ok(!/tabIndex/.test(sw), "no Tab stop of their own");

// the stylesheet: the surface, the caret, the selection and the placeholder follow the preview
const appCss = read("src/App.css");
for (const rule of [/\.cp-pv \{ background: var\(--pv-bg\); color: var\(--pv-fg\); \}/, /\.cp-pv \.tiptap \{ caret-color: var\(--pv-fg\); \}/, /\.cp-pv ::selection \{/, /\.cp-pv \.tiptap p\.is-empty:first-child::before \{ color: var\(--pv-muted\); \}/]) assert.match(appCss, rule);

console.log("ok - test-compose-preview");
